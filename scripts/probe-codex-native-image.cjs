// Opt-in integration probe using the actual installed Codex core in an isolated
// home. Mock mode consumes no quota. Live mode makes one small image request
// through the user's existing loopback Navo gateway, never a paid API fallback.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Agent } = require('undici');
const { createImageGateway } = require('../test/helpers/image-gateway');
const { configFunctions } = require('../test/helpers/codex-api-config');
const { inspectResponsesStream } = require('../lib/openai-compat');

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const cliArg = process.argv.indexOf('--cli');
const cli = cliArg >= 0 ? process.argv[cliArg + 1] : process.env.NAVO_CODEX_TEST_CLI;
const live = process.argv.includes('--live');
const baseline = process.argv.includes('--baseline');
const edit = process.argv.includes('--edit');

function sse(items) {
  return new Response(items.map(item => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

function hasImageTool(tools) {
  return (tools || []).some(tool => tool.name === 'image_gen' || tool.name === 'image_gen.imagegen'
    || tool.name === 'imagegen' || hasImageTool(tool.tools));
}

function imageToolEvidence(value, location = '') {
  if (typeof value === 'string') {
    const index = value.search(/image_gen|imagegen/);
    return index < 0 ? [] : [{ path: location, excerpt: value.slice(Math.max(0, index - 60), index + 180) }];
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => imageToolEvidence(child, `${location}/${key}`));
}

(async () => {
  if (!cli || !fs.existsSync(cli)) throw new Error('Provide the installed Codex core with --cli.');
  if (!live && !process.argv.includes('--mock')) throw new Error('Choose --mock or --live explicitly.');
  if (live && baseline) throw new Error('Baseline comparison is mock-only.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-native-image-'));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  const agent = new Agent();
  let fixture, child, timer;
  let nativeTool = false, imageRequests = 0, textRequests = 0, savedImage = false;
  let exitCode, stdout = '', stderr = '', turnCompleted = false;
  const rpcEvents = [];
  const started = Date.now();
  try {
    const auth = live ? JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.codex/auth.json'), 'utf8')) : null;
    if (live && !auth?.OPENAI_API_KEY) throw new Error('No active loopback Navo API credential.');
    const observed = [];
    fixture = await createImageGateway(async ({ body, signal }) => {
      const isImage = body.tools?.some(tool => tool.type === 'image_generation');
      if (isImage) {
        imageRequests++;
        if (imageRequests > 1) throw new Error('Probe permits one image request only.');
        observed.push({ kind: 'image', toolModel: body.tools[0].model, action: body.tools[0].action,
          inputImages: body.input?.[0]?.content?.filter(item => item.type === 'input_image').length || 0 });
      } else {
        textRequests++;
        const declaredTools = [...(body.tools || []), ...(body.input || []).flatMap(item => item.tools || [])];
        nativeTool ||= hasImageTool(declaredTools) || /image_gen__imagegen/.test(JSON.stringify(declaredTools));
        if (textRequests === 1) observed.push({ kind: 'tools', tools: declaredTools.map(tool => ({
          type: tool.type, name: tool.name, namespace: tool.namespace,
          names: tool.tools?.map(child => child.name),
        })), imageEvidence: imageToolEvidence(declaredTools).slice(0,4) });
        if (textRequests > 3) throw new Error('Probe exceeded its bounded conversation.');
      }
      if (live) return inspectResponsesStream(await fetch('http://127.0.0.1:18300/v1/responses', {
        dispatcher: agent, method: 'POST', signal,
        headers: { Authorization: `Bearer ${auth.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }));
      if (isImage) return { upstream: sse([
        { type: 'response.output_item.done', output_index: 0,
          item: { id: 'ig_fixture', type: 'image_generation_call', status: 'completed', result: PNG, background: 'opaque', size: '1x1' } },
        { type: 'response.completed', response: { id: 'resp_image', status: 'completed', output: [] } },
      ]) };
      if (nativeTool && textRequests === 1) {
        const args = { prompt: 'A solid blue circle on a white background. No text.', transparent_background: false };
        if (edit) args.referenced_image_paths = [path.join(workspace, 'reference.png')];
        const codeMode = /image_gen__imagegen/.test(JSON.stringify(body.input?.[0]?.tools || []));
        const call = codeMode
          ? { type: 'custom_tool_call', id: 'fc_fixture', call_id: 'image_fixture', name: 'exec',
            input: `const result = await tools.image_gen__imagegen(${JSON.stringify(args)}); generatedImage(result);` }
          : { type: 'function_call', id: 'fc_fixture', call_id: 'image_fixture', namespace: 'image_gen', name: 'imagegen', arguments: JSON.stringify(args) };
        return { upstream: sse([
          { type: 'response.created', response: { id: 'resp_call' } },
          { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
          { type: 'response.output_item.done', output_index: 0, item: call },
          { type: 'response.completed', response: { id: 'resp_call', status: 'completed', output: [call] } },
        ]) };
      }
      const message = { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Probe complete.' }] };
      return { upstream: sse([
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: { id: 'resp_done', status: 'completed', output: [message] } },
      ]) };
    });
    const port = Number(new URL(fixture.base).port);
    const secret = fixture.headers.Authorization.slice('Bearer '.length);
    let config = configFunctions(port).build('', 'gpt-6-astra', secret, 'en-US');
    if (baseline) config = config.split('\n').filter(line => !line.includes('x-openai-actor-authorization')).join('\n');
    fs.writeFileSync(path.join(home, 'config.toml'), config);
    fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }));
    if (edit) fs.writeFileSync(path.join(workspace, 'reference.png'), Buffer.from(PNG, 'base64'));
    const env = { ...process.env, CODEX_HOME: home, CODEX_SQLITE_HOME: home, OPENAI_API_KEY: secret,
      NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
    for (const key of Object.keys(env)) if (/^(?:OPENAI_BASE_URL|OPENAI_API_BASE|CODEX_BASE_URL|CODEX_API_KEY|CODEX_ELECTRON.*)$/i.test(key)) delete env[key];
    const prompt = 'Use the built-in image_gen.imagegen tool exactly once to generate a simple solid blue circle on white. Do not use shell commands, external APIs or other tools. Report the saved image path.';
    // The desktop exposes its image extension via app-server. Testing `exec`
    // alone would exercise a different tool registry.
    child = spawn(cli, ['app-server'], {
      cwd: workspace, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      let end;
      while ((end = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        rpcEvents.push(event);
        if (event.id === 1 && event.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'thread/start', params: { cwd: workspace, model: 'gpt-6-astra',
            approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true } });
        } else if (event.id === 2 && event.result?.thread?.id) {
          send({ id: 3, method: 'turn/start', params: { threadId: event.result.thread.id,
            input: [{ type: 'text', text: prompt }] } });
        } else if (event.error) {
          child.kill();
        } else if (event.method === 'turn/completed') {
          turnCompleted = true; child.kill();
        } else if (event.id != null && event.method) {
          send({ id: event.id, error: { code: -32601, message: 'Interactive actions are unavailable in this isolated probe.' } });
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    timer = setTimeout(() => child.kill(), live ? 180000 : 45000);
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-navo-image-probe', version: '1.0.0' },
      capabilities: { experimentalApi: true } } });
    exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    if (turnCompleted) exitCode = 0;
    const items = rpcEvents.filter(e => e.method === 'item/completed').map(e => e.params.item);
    for (const item of items) {
      const file = item.saved_path || item.savedPath;
      if (file && path.resolve(file).startsWith(path.resolve(root) + path.sep) && fs.existsSync(file)) {
        savedImage = true;
        if (live) {
          const output = path.resolve(__dirname, '../verification/image-generation/native-codex.png');
          fs.mkdirSync(path.dirname(output), { recursive: true });
          fs.copyFileSync(file, output);
        }
      }
    }
    const result = { mode: live ? 'live' : baseline ? 'baseline' : 'mock', edit, exitCode,
      ms: Date.now() - started, nativeTool, textRequests, imageRequests, savedImage, observed,
      completedItems: items.map(item => ({ type: item.type, status: item.status, hasSavedPath: Boolean(item.saved_path || item.savedPath) })) };
    console.log(JSON.stringify(result, null, 2));
    if (exitCode !== 0 || (!baseline && (!nativeTool || imageRequests !== 1 || !savedImage))) {
      console.error(stderr.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(-3000));
      // Only fixture-generated diagnostics, never the real credential or request body.
      console.error(JSON.stringify(rpcEvents.filter(event => event.error || event.method === 'error')));
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(timer);
    if (child?.exitCode == null) child?.kill();
    if (fixture) await fixture.close();
    await agent.close();
    // Delete only this probe's own resolved mkdtemp directory, never CODEX_HOME.
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('navo-native-image-')) fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });

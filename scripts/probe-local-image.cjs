// Opt-in smoke test against the user's existing loopback Navo API.
// Reads the current Codex API key in memory; never logs credentials or base64.
const fs = require('node:fs');
const path = require('node:path');
const { Agent } = require('undici');
const { parseImageGenerationSse, inspectResponsesStream } = require('../lib/openai-compat');
(async () => {
  if (!process.argv.includes('--live')) throw new Error('Use --live to send one real image request.');
  const auth = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.codex', 'auth.json'), 'utf8'));
  if (!auth.OPENAI_API_KEY) throw new Error('No local API key configured.');
  const agent = new Agent();
  const started = Date.now();
  const model = process.env.NAVO_PROBE_DRIVER || 'gpt-6-astra';
  let fixture;
  try {
    if (process.argv.includes('--repaired')) {
      const { createImageGateway } = require('../test/helpers/image-gateway');
      fixture = await createImageGateway(async ({ body, signal }) => inspectResponsesStream(await fetch('http://127.0.0.1:18300/v1/responses', {
        dispatcher: agent, method: 'POST', signal,
        headers: { Authorization: `Bearer ${auth.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })), { models: [model] });
      const response = await fetch(fixture.base + '/v1/images/generations', { dispatcher: agent, method: 'POST',
        headers: fixture.headers, signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({ model: 'gpt-image-2.5', prompt: 'A single solid blue circle on a white background. No text.', quality: 'low', size: '1024x1024' }),
      });
      const payload = await response.json();
      const bytes = Buffer.from(payload.data?.[0]?.b64_json || '', 'base64');
      const validPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (validPng) {
        const dir = path.resolve(__dirname, '../verification/image-generation');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'repaired-gateway.png'), bytes);
      }
      console.log(JSON.stringify({ phase: 'repaired-http-endpoint', status: response.status, ms: Date.now() - started,
        toolModel: 'gpt-image-2.5', driverModel: model, validPng, imageBytes: bytes.length,
        dimensions: validPng ? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)] : null,
        error: payload.error || null, usage: payload.usage }));
      if (!validPng || response.status !== 200) process.exitCode = 1;
      return;
    }
    const response = await fetch('http://127.0.0.1:18300/v1/responses', {
      dispatcher: agent, method: 'POST', signal: AbortSignal.timeout(120_000),
      headers: { Authorization: `Bearer ${auth.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true, store: false,
        instructions: 'Generate the requested image using the image_generation tool.',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'A single solid blue circle on a white background. No text.' }] }],
        tools: [{ type: 'image_generation', model: 'gpt-image-2.5', quality: 'low', size: '1024x1024', output_format: 'png' }],
        tool_choice: { type: 'image_generation' }, reasoning: { effort: 'low' },
      }),
    });
    console.log(JSON.stringify({ phase: 'headers', status: response.status, ms: Date.now() - started, model }));
    const parsed = parseImageGenerationSse(await response.text());
    console.log(JSON.stringify({ phase: 'complete', status: response.status, ms: Date.now() - started, model,
      hasImage: Boolean(parsed.b64Json), base64Bytes: parsed.b64Json.length, error: parsed.error,
      eventTypes: [...new Set(parsed.eventTypes)], usage: parsed.usage }));
  } catch (error) {
    console.log(JSON.stringify({ phase: 'error', ms: Date.now() - started, code: error.code || error.cause?.code || error.name }));
    process.exitCode = 1;
  } finally { if (fixture) await fixture.close(); await agent.close(); }
})();

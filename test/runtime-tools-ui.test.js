const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const decode = value => value.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const ready = (configuredPath = 'C:\\mock\\codex.exe', version = '0.144.5') => ({
  status: 'ready', configuredPath, checkedAt: '2026-09-16T01:00:00.000Z',
  selected: { version, source: 'configured', path: configuredPath },
  candidates: [{ version, source: 'configured', path: configuredPath, status: 'ready', durationMs: 12, exitCode: 0 }],
});

// Execute the production IIFE and its real delegated event handlers. The tiny
// DOM implements only the panel contract; no Electron bridge, process probe,
// account, settings file, or network service is contacted by these tests.
function harness(options = {}) {
  const handlers = new Map(), calls = [];
  let input, buttons = new Map(), markup = '';
  const panel = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      const inputTag = value.match(/<input\b[^>]*>/)?.[0];
      input = { id: 'cli-runtime-path', value: decode(inputTag?.match(/\bvalue="([^"]*)"/)?.[1] || ''), disabled: /\sdisabled(?:\s|>)/.test(inputTag || '') };
      buttons = new Map([...value.matchAll(/<button\b[^>]*data-cli-action="([^"]+)"[^>]*>/g)].map(match => {
        const button = { dataset: { cliAction: match[1] }, disabled: /\sdisabled(?:\s|>)/.test(match[0]) };
        return [match[1], button];
      }));
    },
    querySelector: selector => selector === 'input' ? input : null,
    addEventListener: (event, callback) => handlers.set(event, callback),
  };
  const context = vm.createContext({
    setTimeout: options.setTimeout || setTimeout, clearTimeout,
    document: { querySelector: () => options.noPanel ? null : panel },
    window: { codexRuntime: options.selectCli ? { selectCli: options.selectCli } : undefined },
    state: { appLocale: options.chinese === false ? 'en' : 'zh-CN' },
    navoUsesChinese: () => options.chinese !== false,
    escapeHtml: escape,
    api: async (url, request) => {
      calls.push({ url, method: request?.method || 'GET', body: request?.body ? JSON.parse(request.body) : null });
      return options.api ? options.api(url, request) : ready();
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/runtime-tools.js'), 'utf8'), context);
  return {
    calls, panel, get input() { return input; }, get markup() { return markup; },
    button: action => buttons.get(action),
    render: () => context.window.NavoRuntimeTools.render(),
    type(value) {
      assert.equal(input.disabled, false, 'User input must not be simulated into a disabled control');
      input.value = value;
      handlers.get('input')({ target: input });
    },
    click(action) {
      const button = buttons.get(action);
      return handlers.get('click')({ target: { closest: () => button } });
    },
  };
}

test('runtime panel initially reads cached state and renders its configured draft without probing', async () => {
  const h = harness();
  await tick();
  assert.deepEqual(h.calls, [{ url: '/api/cli-state', method: 'GET', body: null }]);
  assert.equal(h.input.value, 'C:\\mock\\codex.exe');
  assert.match(h.markup, /0\.144\.5/);
  assert.equal(h.button('browse').disabled, true);
  assert.equal(h.button('check').disabled, false);
});

test('a late initial state read preserves user edits and subsequent renders', async () => {
  const initial = deferred();
  const h = harness({ api: () => initial.promise });
  h.type('C:\\draft\\codex.exe');
  initial.resolve(ready());
  await tick();
  h.render();
  assert.equal(h.input.value, 'C:\\draft\\codex.exe');
  assert.match(h.markup, /0\.144\.5/);
});

test('a late initial cache read cannot replace a newer diagnostics result', async () => {
  const initial = deferred();
  const h = harness({ api: url => url === '/api/cli-state' ? initial.promise : ready('', '0.150.0') });
  await h.click('check');
  initial.resolve(ready('C:\\outdated\\codex.exe', '0.100.0'));
  await tick();
  assert.match(h.markup, /0\.150\.0/);
  assert.doesNotMatch(h.markup, /0\.100\.0/);
  assert.equal(h.input.value, '');
  assert.deepEqual(h.calls[1], { url: '/api/cli-diagnostics', method: 'POST', body: {} });
});

test('saving trims the path, blocks duplicate actions and keeps the accepted draft', async () => {
  const save = deferred();
  const h = harness({ api: url => url === '/api/cli-state' ? ready() : save.promise });
  await tick();
  h.type('  C:\\new\\codex.exe  ');
  const work = h.click('save');
  assert.equal(h.input.disabled, true);
  assert.equal(h.button('save').disabled, true);
  await h.click('check');
  await h.click('save');
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], { url: '/api/cli-settings', method: 'POST', body: { path: 'C:\\new\\codex.exe' } });
  save.resolve(ready('C:\\new\\codex.exe', '0.150.0'));
  await work;
  assert.equal(h.input.value, 'C:\\new\\codex.exe');
  assert.equal(h.button('save').disabled, false);
  assert.match(h.markup, /配置已验证并保存/);
  h.render();
  assert.equal(h.input.value, 'C:\\new\\codex.exe');
});

test('a late initial success or rejection cannot undo a completed save', async () => {
  for (const rejects of [false, true]) {
    const initial = deferred();
    const h = harness({ api: url => url === '/api/cli-state' ? initial.promise : ready('C:\\new\\codex.exe', '0.150.0') });
    h.type('C:\\new\\codex.exe');
    await h.click('save');
    if (rejects) initial.reject(new Error('old request failed'));
    else initial.resolve(ready('C:\\old\\codex.exe', '0.100.0'));
    await tick();
    assert.equal(h.input.value, 'C:\\new\\codex.exe');
    assert.match(h.markup, /0\.150\.0/);
    assert.doesNotMatch(h.markup, /old request failed|无法读取 CLI 状态|0\.100\.0/);
  }
});

test('failed draft validation preserves the working runtime and isolates draft diagnostics', async () => {
  const error = Object.assign(new Error('invalid CLI'), { diagnostics: {
    status: 'unavailable', selected: null, checkedAt: '2026-09-16T02:00:00.000Z',
    candidates: [{ path: 'C:\\broken\\codex.exe', source: 'configured', status: 'spawn_failed', processErrorCode: 'EPERM' }],
  } });
  const h = harness({ api: url => url === '/api/cli-state' ? ready() : Promise.reject(error) });
  await tick();
  h.type('C:\\broken\\codex.exe');
  await h.click('save');
  assert.equal(h.input.value, 'C:\\broken\\codex.exe');
  assert.match(h.markup, /cli-runtime-status">可用/);
  assert.match(h.markup, /0\.144\.5/);
  assert.match(h.markup, /未保存路径的诊断详情/);
  assert.match(h.markup, /EPERM/);
  assert.match(h.markup, /未更改原配置/);
  assert.equal(h.input.disabled, false);
  assert.equal(h.button('check').disabled, false);
});

test('diagnostics checks the saved configuration and does not save a dirty draft', async () => {
  const h = harness({ api: url => url === '/api/cli-state' ? ready() : ready('C:\\mock\\codex.exe', '0.145.0') });
  await tick();
  h.type('C:\\unsaved\\codex.exe');
  await h.click('check');
  assert.equal(h.input.value, 'C:\\unsaved\\codex.exe');
  assert.equal(h.calls[1].url, '/api/cli-diagnostics');
  assert.deepEqual(h.calls[1].body, {});
  assert.match(h.markup, /0\.145\.0/);
});

test('diagnostics unavailable states and transport failures re-enable controls without false success', async () => {
  let throws = false;
  const h = harness({ api: url => {
    if (url === '/api/cli-state') return ready();
    if (throws) throw new Error('mock transport failure');
    return { status: 'unavailable', selected: null, configuredPath: '', candidates: [{ source: 'npm', path: 'C:\\mock\\alpha.exe', status: 'prerelease', version: '0.151.0-alpha.1' }] };
  } });
  await tick();
  await h.click('check');
  assert.match(h.markup, /CLI 尚未就绪/);
  assert.match(h.markup, /预发行版本/);
  assert.equal(h.button('check').disabled, false);
  throws = true;
  await h.click('check');
  assert.match(h.markup, /mock transport failure/);
  assert.doesNotMatch(h.markup, /配置已验证并保存/);
  assert.equal(h.button('save').disabled, false);
});

test('empty CLI diagnostics distinguish a discovery timeout from a completed search with no candidates', async () => {
  const h = harness({ api: () => ({ status: 'unavailable', checkedAt: '2026-09-16T01:00:00Z', discoveryStatus: 'timeout', candidates: [] }) });
  await tick();
  assert.match(h.markup, /CLI 文件查找未完成：检测超时/);
  const empty = harness({ chinese: false, api: () => ({ status: 'unavailable', checkedAt: '2026-09-16T01:00:00Z', candidates: [] }) });
  await tick();
  assert.match(empty.markup, /No CLI candidates were found/);
  assert.doesNotMatch(empty.markup, /No candidate records/);
});

test('CLI file-status timeouts display localized diagnostic labels', async () => {
  for (const chinese of [true, false]) {
    const h = harness({ chinese, api: () => ({ status: 'unavailable', candidates: [{ path: 'C:\\mock\\codex.exe', source: 'configured', status: 'stat_timeout' }] }) });
    await tick();
    assert.match(h.markup, chinese ? /文件状态读取超时/ : /File status read timed out/);
    assert.doesNotMatch(h.markup, /stat_timeout/);
  }
});

test('a usable CLI retains visible partial-discovery diagnostics in both languages', async () => {
  for (const chinese of [true, false]) {
    const h = harness({ chinese, api: () => ({ ...ready(), discoveryStatus: 'timeout',
      discoveryIssues: [{ source: 'path', path: 'C:\\slow<&>\\codex.exe', status: 'stat_timeout' }] }) });
    await tick();
    assert.match(h.markup, /0\.144\.5/);
    assert.match(h.markup, chinese ? /部分来源未完成检查，请查看详情/ : /Some sources were not fully checked; see details/);
    assert.match(h.markup, /slow&lt;&amp;&gt;/);
    assert.doesNotMatch(h.markup, /stat_timeout/);
  }
});

test('partial discovery without a usable CLI does not claim usable results', async () => {
  for (const chinese of [true, false]) {
    const h = harness({ chinese, api: () => ({ status: 'unavailable', selected: null, candidates: [],
      discoveryIssues: [{ source: 'path', status: 'timeout' }] }) });
    await tick();
    assert.match(h.markup, chinese ? /部分来源未完成检查，请查看详情/ : /Some sources were not fully checked; see details/);
    assert.doesNotMatch(h.markup, /已保留可用结果|usable results were retained/);
  }
});

test('native file selection keeps an early draft and still accepts a late saved-state snapshot', async () => {
  const initial = deferred();
  let locale;
  const h = harness({ api: () => initial.promise, selectCli: async value => { locale = value; return 'C:\\chosen\\codex.exe'; } });
  await h.click('browse');
  initial.resolve(ready());
  await tick();
  assert.equal(locale, 'zh-CN');
  assert.equal(h.input.value, 'C:\\chosen\\codex.exe');
  assert.match(h.markup, /0\.144\.5/);
  assert.equal(h.calls.length, 1, 'Choosing a file must not validate or persist it automatically');
});

test('cancelling the native picker does not discard a late initial configured path', async () => {
  const initial = deferred();
  const h = harness({ api: () => initial.promise, selectCli: async () => null });
  await h.click('browse');
  initial.resolve(ready());
  await tick();
  assert.equal(h.input.value, 'C:\\mock\\codex.exe');
  assert.equal(h.button('browse').disabled, false);
});

test('picker failures are localized, escaped and leave the form usable', async () => {
  const h = harness({ chinese: false, selectCli: async () => { throw new Error('<mock-picker-error>'); } });
  await tick();
  h.type('C:\\draft\\codex.exe');
  await h.click('browse');
  assert.match(h.markup, /File selection failed:/);
  assert.match(h.markup, /&lt;mock-picker-error&gt;/);
  assert.doesNotMatch(h.markup, /<mock-picker-error>/);
  assert.equal(h.input.value, 'C:\\draft\\codex.exe');
  assert.equal(h.button('browse').disabled, false);
});

test('freshly selected files clear stale failed-draft copy without claiming validation', async () => {
  const h = harness({ selectCli: async () => 'C:\\chosen\\codex.exe', api: url => {
    if (url === '/api/cli-state') return ready();
    throw Object.assign(new Error('invalid'), { diagnostics: { status: 'unavailable', candidates: [] } });
  } });
  await tick();
  h.type('C:\\broken\\codex.exe');
  await h.click('save');
  await h.click('browse');
  assert.equal(h.input.value, 'C:\\chosen\\codex.exe');
  assert.doesNotMatch(h.markup, /未保存路径的诊断详情|未通过验证|配置已验证并保存/);
});

test('missing panels do not read CLI state or register handlers', () => {
  assert.deepEqual(harness({ noPanel: true }).calls, []);
});

test('install action prevents duplicate requests, polls progress, and selects the finished CLI', async () => {
  const timers = [];
  let started = false, completed = false;
  const h = harness({ setTimeout: callback => { timers.push(callback); return 0; }, api: url => {
    if (url === '/api/cli-install') { started = true; return { status:'downloading',busy:true,progress:25,totalBytes:1000,receivedBytes:300 }; }
    return { ...ready(completed?'C:\\navo\\codex.exe':'C:\\old\\codex.exe'), installation: started
      ? { status:completed?'complete':'downloading',busy:!completed,progress:completed?100:25 } : {status:'idle',busy:false} };
  } });
  await tick(); await h.click('install'); await h.click('install'); await h.click('save');
  assert.equal(h.calls.filter(call=>call.url==='/api/cli-install').length,1);
  assert.equal(h.button('install').disabled,true);assert.equal(h.input.disabled,true);
  assert.match(h.markup,/25%/);assert.equal(h.button('cancel').disabled,false);
  completed=true;await timers.shift()();
  assert.equal(h.input.value,'C:\\navo\\codex.exe');assert.equal(h.button('install').disabled,false);
  assert.match(h.markup,/稳定版 CLI 已安装并启用/);assert.equal(timers.length,0);
});

test('installation survives a page reload and failure copy is localized without claiming success', async () => {
  for (const chinese of [true,false]) {
    const timers=[];let failed=false;
    const h=harness({chinese,setTimeout:callback=>{timers.push(callback);return 0;},api:()=>({...ready(),installation: failed
      ? {status:'error',busy:false,errorCode:'integrity_failed'}:{status:'downloading',busy:true,progress:60}})});
    await tick();assert.equal(h.button('save').disabled,true);assert.equal(timers.length,1);
    failed=true;await timers.shift()();assert.equal(h.button('save').disabled,false);
    assert.match(h.markup,chinese?/校验不一致/:/checksum does not match/);
    assert.doesNotMatch(h.markup,/已安装并启用|installed and selected/);
  }
});

function routeHarness(options = {}) {
  const probes = [], writes = [];
  const original = ready(), validated = options.validated || ready('C:\\new\\codex.exe', '0.150.0');
  const savedSettings = { codexCliExecutable: original.configuredPath, unrelatedOption: 'preserve' };
  const context = vm.createContext({
    path: path.win32, request: null, response: {}, url: null,
    SETTINGS_FILE: 'mock-settings-only', settings: { ...savedSettings },
    cliInstaller: { snapshot: () => ({ status: options.installBusy ? 'downloading' : 'idle', busy: Boolean(options.installBusy) }),
      start: () => ({status:'checking',busy:true}), cancel: () => ({status:'cancelled',busy:false}) },
    cliResolver: { snapshot: () => original, inspect: async configuration => { probes.push({ original: true, configuration }); return original; } },
    createCliResolver: () => ({
      snapshot: () => validated,
      inspect: async configuration => { probes.push({ original: false, configuration }); return validated; },
    }),
    cliOptions: extra => ({ configured: context.settings.codexCliExecutable, ...extra }),
    readBody: async request => request.body,
    readJson: () => ({ ...savedSettings }),
    writeJsonAtomic: (_file, data) => { if (options.writeError) throw new Error('mock settings write failed'); writes.push(data); },
    sendJson: (_response, status, payload) => ({ status, ...payload }),
    sendError: (_response, status, error, extra = {}) => ({ status, error, ...extra }),
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf("    if (request.method === 'POST' && url.pathname === '/api/cli-install')");
  const end = source.indexOf("    if (request.method === 'GET' && url.pathname === '/api/bootstrap')", start);
  assert.ok(start >= 0 && end > start, 'CLI route block must exist');
  const routes = `(async () => { ${source.slice(start, end)} })()`;
  return {
    probes, writes, context,
    request(method, pathname, body = {}) {
      context.request = { method, body };
      context.url = { pathname };
      return vm.runInContext(routes, context);
    },
  };
}

test('CLI state route remains cache-only while explicit diagnostics probes the live configuration', async () => {
  const h = routeHarness();
  const state = await h.request('GET', '/api/cli-state');
  assert.equal(state.status, 200);
  assert.equal(h.probes.length, 0);
  const diagnostics = await h.request('POST', '/api/cli-diagnostics');
  assert.equal(diagnostics.data.selected.version, '0.144.5');
  assert.equal(h.probes[0].original, true);
  assert.equal(h.probes[0].configuration.force, true);
  assert.equal(h.writes.length, 0);
});

test('saving a verified CLI updates the cache used by subsequent page loads', async () => {
  const h = routeHarness();
  const saved = await h.request('POST', '/api/cli-settings', { path: '  C:\\new\\codex.exe  ' });
  assert.equal(saved.status, 200);
  assert.equal(h.probes[0].original, false);
  assert.equal(h.probes[0].configuration.configured, 'C:\\new\\codex.exe');
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].unrelatedOption, 'preserve');
  const reloaded = await h.request('GET', '/api/cli-state');
  assert.equal(reloaded.data.selected.version, '0.150.0');
  assert.equal(reloaded.data.configuredPath, 'C:\\new\\codex.exe');
  assert.equal(h.probes.length, 1, 'Reload must not repeat the verified probe');
});

test('failed CLI validation cannot replace saved settings or live runtime diagnostics', async () => {
  const h = routeHarness({ validated: { status: 'unavailable', selected: null, candidates: [{ status: 'missing' }] } });
  const failed = await h.request('POST', '/api/cli-settings', { path: 'C:\\missing\\codex.exe' });
  assert.equal(failed.status, 409);
  assert.equal(failed.diagnostics.candidates[0].status, 'missing');
  assert.equal(h.writes.length, 0);
  const reloaded = await h.request('GET', '/api/cli-state');
  assert.equal(reloaded.data.configuredPath, 'C:\\mock\\codex.exe');
  assert.equal(reloaded.data.selected.version, '0.144.5');
});

test('failed CLI settings persistence leaves the live configuration untouched', async () => {
  const h = routeHarness({ writeError: true });
  await assert.rejects(h.request('POST', '/api/cli-settings', { path: 'C:\\new\\codex.exe' }), /mock settings write failed/);
  const reloaded = await h.request('GET', '/api/cli-state');
  assert.equal(reloaded.data.configuredPath, 'C:\\mock\\codex.exe');
  assert.equal(reloaded.data.selected.version, '0.144.5');
});

test('relative paths and command shims are rejected before any CLI validation', async () => {
  const h = routeHarness();
  for (const path of ['codex.exe', 'C:\\mock\\codex.cmd', 'C:\\mock\\codex.ps1']) {
    assert.equal((await h.request('POST', '/api/cli-settings', { path })).status, 400);
  }
  assert.equal(h.probes.length, 0);
  assert.equal(h.writes.length, 0);
});

test('installer routes return background state and settings cannot change during installation', async () => {
  const h=routeHarness({installBusy:true});
  const started=await h.request('POST','/api/cli-install');
  assert.equal(started.status,202);assert.equal(started.data.busy,true);
  const state=await h.request('GET','/api/cli-state');assert.equal(state.data.installation.status,'downloading');
  assert.equal((await h.request('POST','/api/cli-settings',{path:'C:\\other\\codex.exe'})).status,409);
  assert.equal(h.probes.length,0);assert.equal(h.writes.length,0);
  assert.equal((await h.request('POST','/api/cli-install/cancel')).data.status,'cancelled');
});

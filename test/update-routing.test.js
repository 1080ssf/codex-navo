const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function harness(delays = { direct: 1, proxy: 40 }) {
  const changes = [], samples = [], sessions = new Map();
  const makeSession = name => ({
    setProxy: async value => changes.push({ name, ...value }), closeAllConnections: async () => {},
    fetch: async (url, options) => {
      samples.push({ name, url });
      const delay = delays[name.endsWith('proxy') ? 'proxy' : 'direct'];
      if (delay === false) return new Response('', { status: 503 });
      await new Promise(resolve => setTimeout(resolve, delay));
      options.signal.throwIfAborted();
      return new Response('sample'.repeat(100), { status: 206 });
    },
  });
  const navo = makeSession('navo'), codex = makeSession('codex');
  const context = vm.createContext({ URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    CODEX_UPDATE_MANIFEST_URL: 'https://example.test/manifest', autoUpdater: { netSession: navo },
    session: { fromPartition: name => { if (!sessions.has(name)) sessions.set(name, makeSession(name)); return sessions.get(name); } },
    requestLocalJson: async () => ({ proxyUrl: 'http://127.0.0.1:18302', nodeName: 'Proxy' }),
  });
  const source = fs.readFileSync(path.join(__dirname, '../desktop-src/main.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('const configuredUpdateRoutes ='), source.indexOf('async function ensureServer(')), context);
  return { context, changes, samples, navo, codex, run: (target, signal, url) => context.configureUpdaterNetwork(target, signal, url) };
}
test('both products select the faster route through isolated sessions', async () => {
  for (const delays of [{ direct: 1, proxy: 40 }, { direct: 40, proxy: 1 }]) {
    const h = harness(delays);
    for (const target of [h.navo, h.codex]) {
      assert.equal(Boolean((await h.run(target, undefined, 'https://example.test/installer')).proxyUrl), delays.proxy < delays.direct);
    }
    assert.ok(h.samples.every(sample => sample.name.startsWith('navo-update-probe-')));
  }
});
test('repeated direct selection never leaves download session on last tested proxy', async () => {
  const h = harness(); await h.run(h.navo); await h.run(h.navo);
  assert.deepEqual(h.changes.filter(item => item.name === 'navo'), [{ name: 'navo', mode: 'direct' }]);
});
test('missing proxy still permits a working direct route', async () => {
  const h = harness(); h.context.requestLocalJson = async () => { throw Error('unavailable'); };
  assert.equal((await h.run(h.navo)).proxyUrl, '');
});
test('failed routes do not mutate download session', async () => {
  const h = harness({ direct: false, proxy: false });
  await assert.rejects(h.run(h.navo), /unreachable/);
  assert.equal(h.changes.filter(item => item.name === 'navo').length, 0);
});
test('cancellation prevents reconfiguration', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(Error('cancelled'));
  await assert.rejects(h.run(h.navo, controller.signal), /cancelled/); assert.equal(h.changes.length, 0);
});

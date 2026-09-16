const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPreviewServer } = require('../scripts/preview-account-tools');

async function withPreview(run) {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, { body, fixture, raw = false } = {}) => new Promise((resolve, reject) => {
    const req = http.request(base + pathname, {
      method: body ? 'POST' : 'GET',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(fixture ? { referer: `${base}/?fixture=${fixture}` } : {}) },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, payload: raw ? text : JSON.parse(text) }));
    });
    req.once('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try { await run(request); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('preview bootstrap uses the production network-name, protocol, latency and reasoning contracts', async () => withPreview(async request => {
  const { payload } = await request('/api/bootstrap');
  const account = payload.data.accounts.find(account => account.id === 'preview-regular');
  assert.equal(account.network.displayName, '美国 VPS · 演示线路');
  assert.equal(account.network.nodeName, 'US standalone preview');
  assert.deepEqual(payload.data.wakeModelOptions[0].reasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
  const node = payload.data.networkSettings.sources[0].nodes[0];
  assert.equal(node.protocol, 'socks5');
  assert.equal(node.connectDelay, 45);
}));

test('preview scenario selection follows the page referer and keeps empty and mixed network states independent', async () => withPreview(async request => {
  const empty = await request('/api/network-state', { fixture: 'network-empty' });
  assert.equal(empty.payload.data.sources.length, 0);
  const mixed = await request('/api/network-state', { fixture: 'network-mixed' });
  const statuses = mixed.payload.data.sources[1].nodes.map(node => node.status);
  assert.ok(statuses.includes('tls-failed'));
  assert.ok(statuses.includes('checking'));
  const normal = await request('/api/network-state');
  assert.equal(normal.payload.data.sources.length, 2);
  assert.equal(normal.payload.data.sources[1].nodes[0].status, 'available');
}));

test('preview allows in-memory wake settings but never submits wake, model, credit or restore operations', async () => withPreview(async request => {
  const saved = await request('/api/wake-settings', { fixture: 'wake-failed', body: { reasoningEffort: 'high' } });
  assert.equal(saved.payload.data.reasoningEffort, 'high');
  const normal = await request('/api/bootstrap');
  assert.equal(normal.payload.data.wakeSettings.reasoningEffort, 'low');
  for (const pathname of ['/api/accounts/preview-regular/wake', '/api/wake-all', '/api/model-diagnostics/start', '/api/accounts/preview-regular/reset-credits/consume', '/api/codex-rollout-backups/restore']) {
    const result = await request(pathname, { body: {} });
    assert.equal(result.status, 403, pathname);
    assert.equal(result.payload.ok, false);
  }
}));

test('preview floating fixtures distinguish stale, partial, idle and whole-root-task switches', async () => withPreview(async request => {
  const stale = (await request('/api/floating-status', { fixture: 'floating-stale' })).payload.data;
  assert.equal(stale.account.quotaSync.status, 'stale');
  assert.ok(Date.parse(stale.updatedAt) - Date.parse(stale.account.quotaSync.lastSucceededAt) >= 7_000_000);
  const partial = (await request('/api/floating-status', { fixture: 'floating-partial' })).payload.data;
  assert.equal(partial.account.type, 'api');
  assert.equal(partial.account.quotaSync.partial, true);
  const idle = (await request('/api/floating-status', { fixture: 'floating-none' })).payload.data;
  assert.equal(idle.task, null);
  assert.equal(idle.usage.input, 0);
  const first = (await request('/api/floating-status', { fixture: 'floating-switch' })).payload.data;
  const second = (await request('/api/floating-status', { fixture: 'floating-switch' })).payload.data;
  assert.notEqual(first.task.id, second.task.id);
  assert.notEqual(first.task.usage.input, second.task.usage.input);
  assert.equal((await request('/api/floating-status', { fixture: 'floating-offline' })).status, 503);
}));

test('preview launch and backup fixtures expose terminal, empty and legacy UI states without business effects', async () => withPreview(async request => {
  for (const fixture of ['launch-running', 'launch-complete', 'launch-error']) {
    const progress = (await request('/api/codex-launch-progress', { fixture })).payload.data;
    assert.equal(progress.active, fixture === 'launch-running');
    assert.equal(progress.stage, fixture === 'launch-running' ? 'opening' : fixture.slice(7));
  }
  const complete = (await request('/api/bootstrap', { fixture: 'launch-complete' })).payload.data;
  assert.equal(complete.codexRunning, true);
  assert.ok(complete.accounts.some(account => account.codexActive));
  assert.deepEqual((await request('/api/codex-rollout-backups', { fixture: 'backups-empty' })).payload.data, []);
  assert.equal((await request('/api/codex-rollout-backups', { fixture: 'backups-legacy' })).payload.data[0].checksumAvailable, false);
  assert.equal((await request('/api/codex-rollout-backups', { fixture: 'backups-error' })).status, 503);
}));

test('preview catalog is selection scoped and floating pages receive only a fake desktop bridge', async () => withPreview(async request => {
  assert.deepEqual((await request('/api/api-service/models/detect', { body: { accountIds: [] } })).payload.data, []);
  const models = (await request('/api/api-service/models/detect', { body: { accountIds: ['a', 'b'] } })).payload.data;
  assert.equal(models[0].totalAccounts, 2);
  const page = await request('/floating.html?fixture=floating-partial', { raw: true });
  assert.match(page.payload, /preview-desktop\.js/);
  const dashboard = await request('/preview', { raw: true });
  assert.match(dashboard.payload, /fixture=network-mixed/);
  assert.match(dashboard.payload, /fixture=backups-legacy/);
}));

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(options = {}) {
  const storage = options.storage || new Map();
  const calls = [];
  const results = { innerHTML: '' };
  const body = { innerHTML: '', prepend() {} };
  const dialog = { open: true, querySelector(selector) { return selector === '[name="tools-allow-busy"]' ? { checked: options.allowBusy === true } : selector === '.tools-results' ? results : body; } };
  const context = vm.createContext({
    window: {}, document: { querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => ({}) },
    state: { accounts: [], apiService: { keys: [] } }, render() {},
    escapeHtml: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    navoUsesChinese: () => options.chinese !== false,
    confirm: () => options.confirm !== false,
    crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789abc' },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    setTimeout() {}, clearTimeout() {},
    api: async (url, request) => { calls.push({ url, body: JSON.parse(request?.body || '{}') }); if (options.transportError) throw new Error('transport interrupted'); return { id: 'job-1', status: 'completed', items: [] }; }
  });
  let source = fs.readFileSync(path.join(__dirname, '../public/account-tools.js'), 'utf8');
  source = source.replace('window.NavoAccountTools = { decorate };', 'window.NavoAccountTools = { decorate, creditCopy, creditMarkup, status, start, consume, renderJob, setup(d,j) { dialog=d; job=j; mode="credits"; targetId="account-a"; creditsState={credits:{availableCount:2,credits:null}}; } };');
  vm.runInContext(source, context);
  return { tools: context.window.NavoAccountTools, calls, storage, dialog, results };
}

test('live model probes require confirmation and remove presentation-only fields', async () => {
  const denied = harness({ confirm: false });
  await denied.tools.start([{ targetId: 'account-a', model: 'model-a' }]);
  assert.equal(denied.calls.length, 0);
  const accepted = harness();
  await accepted.tools.start([{ targetId: 'api-member:k:a', model: 'model-a', targetLabel: 'private display label' }]);
  assert.deepEqual(accepted.calls[0].body, { items: [{ targetId: 'api-member:k:a', model: 'model-a' }], confirmed: true, allowBusy: false });
});

test('reset transport failures persist the original idempotency key across reloads', async () => {
  const first = harness({ transportError: true }); first.tools.setup(first.dialog);
  await assert.rejects(first.tools.consume({ dataset: {} }), /transport/);
  await assert.rejects(first.tools.consume({ dataset: {} }), /transport/);
  assert.equal(first.calls[0].body.clientOperationId, first.calls[1].body.clientOperationId);
  const second = harness({ transportError: true, storage: first.storage }); second.tools.setup(second.dialog);
  await assert.rejects(second.tools.consume({ dataset: {} }), /transport/);
  assert.equal(second.calls[0].body.clientOperationId, first.calls[0].body.clientOperationId);
  assert.equal(second.calls[0].body.creditId, undefined);
});

test('active-account probes require an explicit UI opt-in', async () => {
  const h = harness({ allowBusy: true }); h.tools.setup(h.dialog);
  await h.tools.start([{ targetId: 'account-a', model: 'model-a' }]);
  assert.equal(h.calls[0].body.allowBusy, true);
});

test('reset dismissal does not send a request', async () => {
  const h = harness({ confirm: false }); h.tools.setup(h.dialog);
  await h.tools.consume({ dataset: {} }); assert.equal(h.calls.length, 0);
});

test('results read backend state, show HTTP failure and escape upstream content', () => {
  const h = harness(); h.tools.setup(h.dialog, { status: 'completed', items: [{ state: 'service_unavailable', model: '<script>', targetId: 'account-a', httpStatus: 503, error: '<img>', attemptedAccountIds: ['a', 'b'] }] });
  h.tools.renderJob();
  assert.match(h.results.innerHTML, /服务不可用/); assert.match(h.results.innerHTML, /HTTP 503/);
  assert.match(h.results.innerHTML, /&lt;script>/); assert.doesNotMatch(h.results.innerHTML, /<img>/);
});

test('diagnostic state labels support English and Chinese', () => {
  assert.equal(harness({ chinese: false }).tools.status('model_mismatch'), 'Model mismatch');
  assert.equal(harness().tools.status('quota_exhausted'), '额度耗尽');
});

test('reset credit fields and dates follow the application language', () => {
  const card = { title: 'Full reset (Weekly + 5 hr)', status: 'available', resetType: 'codexRateLimits', description: "Thanks for using Codex! You've been granted one free rate limit reset.", expiresAt: '2026-10-04T00:50:06.000Z' };
  const zh = harness().tools.creditMarkup(card, 0, false);
  assert.match(zh, /完整重置（周额度 \+ 5 小时额度）/);
  assert.match(zh, /状态：可用/);
  assert.match(zh, /已获赠一次免费的额度重置/);
  assert.match(zh, /到期时间（本地）/);
  assert.doesNotMatch(zh, /available|codexRateLimits|Thanks|\.000Z/);
  const en = harness({ chinese: false }).tools.creditMarkup(card, 0, false);
  assert.match(en, /Full reset/); assert.match(en, /Status: Available/);
  assert.match(harness().tools.creditMarkup({ title: '<script>', expiresAt: 'invalid' }, 0, false), /&lt;script>/);
});

test('diagnostic controls isolate checkbox sizing and provide tooltip content', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(css, /\.navo-account-tools-dialog input\[type="checkbox"\] \{[^}]*width: 16px;[^}]*padding: 0;/);
  const source = fs.readFileSync(path.join(__dirname, '../public/account-tools.js'), 'utf8');
  assert.match(source, /toolbar\.dataset\.tooltip =/);
  assert.match(source, /class="tools-option-text"/);
});

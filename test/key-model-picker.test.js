const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');

function pickerHarness({ chinese = false, loadModels = async () => [{ id: 'fixture-model' }] } = {}) {
  const handlers = new Map();
  const button = { disabled: false, addEventListener: (name, callback) => handlers.set(name, callback) };
  const status = { textContent: '', className: '' };
  const options = { innerHTML: '', hidden: true, querySelectorAll: () => [] };
  const panel = { innerHTML: '', querySelector: selector => selector === '.api-model-detect' ? button : selector === '.api-model-status' ? status : options };
  const form = { elements: { models: { value: '' } }, querySelector: () => ({ insertAdjacentElement() {} }) };
  const context = vm.createContext({ document: { createElement: () => panel }, escapeHtml, navoUsesChinese: () => chinese, form, loadModels });
  vm.runInContext(section('function tr(zh, en)', 'function formatLaunchSize') + section('function parseModelList(', 'function mountAccountPoolPicker('), context);
  vm.runInContext('mountModelPicker({ form, loadModels })', context);
  return { panel, status, button, options, click: () => handlers.get('click')() };
}

test('Key model picker asks for account selection and distinguishes catalogs from live testing in both languages', async () => {
  for (const chinese of [true, false]) {
    const h = pickerHarness({ chinese });
    assert.match(h.panel.innerHTML, chinese ? /先勾选账号/ : /Select accounts/);
    assert.doesNotMatch(h.panel.innerHTML, /填写连接信息/);
    await h.click();
    assert.match(h.status.textContent, chinese ? /尚未实测/ : /not live-tested/);
    assert.match(h.status.textContent, chinese ? /账号管理/ : /Accounts/);
    assert.equal(h.options.hidden, false);
    assert.equal(h.button.disabled, false);
  }
});

test('Key catalog loading blocks its action until completion and empty catalogs remain explicit failures', async () => {
  let finish;
  const h = pickerHarness({ loadModels: () => new Promise(resolve => { finish = resolve; }) });
  const work = h.click();
  assert.equal(h.button.disabled, true);
  assert.match(h.status.textContent, /Reading the selected accounts/);
  finish([]);
  await work;
  assert.match(h.status.textContent, /returned no model catalog/);
  assert.equal(h.button.disabled, false);
  assert.equal(h.options.hidden, true);
});

test('Key catalog loader refuses an empty account selection before requesting the backend', async () => {
  const form = { elements: { accountIds: { value: '' } } }, calls = [];
  let loadModels;
  const context = vm.createContext({
    state: { accounts: [], apiService: { providers: [{ type: 'navo-pool', id: 'fixture-pool' }] } },
    navoUsesChinese: () => false,
    openApiFormDialog: async options => { options.onReady({ form }); return null; },
    mountAccountPoolPicker() {}, mountModelPicker: options => { loadModels = options.loadModels; },
    api: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return [{ id: 'fixture-model', supportedAccounts: 2, totalAccounts: 2 }]; },
  });
  vm.runInContext(section('function tr(zh, en)', 'function formatLaunchSize') + section('async function editApiKey(', 'async function createApiKeyAndShowSecret('), context);
  await context.editApiKey();
  await assert.rejects(loadModels(), /Select the accounts/);
  assert.deepEqual(calls, []);
  form.elements.accountIds.value = 'a,b';
  const models = await loadModels();
  assert.deepEqual(calls, [{ url: '/api/api-service/models/detect', body: { accountIds: ['a', 'b'] } }]);
  assert.equal(models[0].value, 'fixture-model');
});

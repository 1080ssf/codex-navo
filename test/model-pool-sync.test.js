const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
test('new detected GPT-6 models enter the pool and survive UI refresh', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  let pool = [];
  const context = { accounts: [{ id: 'account-a', label: 'fixture' }], validateAccountId: () => true,
    isCodexAuthenticated: () => true, networkManager: { ensureAccount: async () => null, environmentForRuntime: () => ({}) },
    process: { env: {} }, findCodexCli: async () => 'fixture', accountPaths: () => ({ codexHomeDir: 'fixture' }),
    readCodexModels: async () => [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-sol' }, { id: 'gpt-6-luna' }], accountModelCapabilities: new Map(),
    wakeModelCatalog: () => [{ slug: 'old-model' }], apiServiceManager: {
      ensureAccountPool: models => { pool = Array.from(models); }, publicState: () => ({ keys: [] }),
    },
  };
  const start = source.indexOf('async function detectSelectedAccountModels(');
  const end = source.indexOf('\nfunction readActiveApiCodex(', start);
  const fn = vm.runInNewContext(`(${source.slice(start, end)})`, context);
  const result = await fn(['account-a']);
  assert.equal(result.length, 3); assert.ok(pool.includes('gpt-6.1-sol')); assert.ok(pool.includes('gpt-6-sol')); assert.ok(pool.includes('gpt-6-luna'));
  const refresh = source.slice(source.indexOf('function publicApiServiceState()'), source.indexOf('  const state = apiServiceManager.publicState();', source.indexOf('function publicApiServiceState()')));
  vm.runInNewContext(refresh + '}', context);
  context.publicApiServiceState(); assert.ok(pool.includes('gpt-6.1-sol')); assert.ok(pool.includes('gpt-6-sol'));
});

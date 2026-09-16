const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ApiServiceManager } = require('../lib/api-service');
const { LEGACY_ALL_ACCOUNT_SCOPE, normalizeApiKeyAccountScope, resolveApiKeyMembers } = require('../lib/api-key-members');

function temporaryManager(t, records = []) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-key-members-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const writeJsonAtomic = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  const readJson = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
  const keysFile = path.join(runtimeRoot, 'api-service', 'keys.json');
  writeJsonAtomic(keysFile, records);
  let writes = 0;
  const options = { runtimeRoot, readJson, writeJsonAtomic: (file, value) => { writes += 1; writeJsonAtomic(file, value); } };
  const manager = new ApiServiceManager(options);
  return { manager, options, keysFile, readJson, writes: () => writes };
}

test('only persisted legacy empty scopes migrate to dynamic all-account membership', (t) => {
  const { manager, options, keysFile, readJson, writes } = temporaryManager(t, [
    { id: 'missing', dailyUsageVersion: 2 },
    { id: 'empty', accountIds: [], dailyUsageVersion: 2 },
    { id: 'selected', accountIds: ['b', 'a', 'b'], dailyUsageVersion: 2 },
    { id: 'explicit-empty', accountIds: [], accountScope: 'explicit', dailyUsageVersion: 2 },
    { id: 'unknown', accountIds: [], accountScope: 'future', dailyUsageVersion: 2 },
    { id: 'inconsistent', accountIds: ['a'], accountScope: 'legacy-all', dailyUsageVersion: 2 },
  ]);
  assert.deepEqual(manager.keys.map((key) => [key.id, key.accountScope, key.accountIds]), [
    ['missing', 'legacy-all', []], ['empty', 'legacy-all', []], ['selected', 'explicit', ['b', 'a']],
    ['explicit-empty', 'explicit', []], ['unknown', 'explicit', []], ['inconsistent', 'explicit', ['a']],
  ]);
  assert.equal(writes(), 1);
  assert.equal(readJson(keysFile, [])[0].accountScope, 'legacy-all');
  const restarted = new ApiServiceManager(options);
  assert.equal(writes(), 1, 'scope migration must not write again on the next load');
  assert.deepEqual(restarted.keys.map((key) => key.accountScope), manager.keys.map((key) => key.accountScope));
  assert.deepEqual(resolveApiKeyMembers(restarted.keys[0], [{ id: 'a' }, { id: 'new-later' }]).map((account) => account.id), ['a', 'new-later']);
});

test('new and updated keys require explicit nonempty membership and cannot opt into legacy expansion', (t) => {
  const { manager, keysFile } = temporaryManager(t, [{ id: 'legacy', dailyUsageVersion: 2 }]);
  const before = fs.readFileSync(keysFile, 'utf8');
  for (const value of [{}, { accountIds: [] }, { accountIds: ' , ' }, { accountScope: 'legacy-all' }]) {
    assert.throws(() => manager.createKey(value), { statusCode: 400 });
  }
  assert.equal(fs.readFileSync(keysFile, 'utf8'), before);
  const created = manager.createKey({ name: 'New', accountIds: ['a'], accountScope: 'legacy-all' });
  assert.equal(created.key.accountScope, 'explicit');
  assert.deepEqual(resolveApiKeyMembers(created.key, [{ id: 'a' }, { id: 'b' }]).map((account) => account.id), ['a']);
  manager.updateKey(created.key.id, { name: 'Rename', accountScope: 'legacy-all' });
  assert.equal(manager.keys.find((key) => key.id === created.key.id).accountScope, 'explicit');
  for (const accountIds of [[], '', null]) {
    assert.throws(() => manager.updateKey(created.key.id, { accountIds }), { statusCode: 400 });
  }
  manager.updateKey('legacy', { name: 'Legacy renamed' });
  assert.equal(manager.keys.find((key) => key.id === 'legacy').accountScope, 'legacy-all');
  manager.updateKey('legacy', { accountIds: ['b'] });
  assert.equal(manager.keys.find((key) => key.id === 'legacy').accountScope, 'explicit');
  assert.deepEqual(manager.keys.find((key) => key.id === 'legacy').accountIds, ['b']);
});

test('member resolution is ordered, deduplicated, eligibility-filtered and never falls back from explicit none', () => {
  const accounts = [{ id: 'a', enabled: true }, { id: 'b', enabled: true }, { id: 'disabled', enabled: false }];
  const eligible = (account) => account.enabled;
  assert.deepEqual(resolveApiKeyMembers({ accountScope: 'explicit', accountIds: ['b', 'a', 'b', 'gone', 'disabled'] }, accounts, eligible)
    .map((account) => account.id), ['b', 'a']);
  for (const key of [null, {}, { accountIds: [] }, { accountScope: 'explicit', accountIds: [] }, { accountScope: 'explicit', accountIds: ['gone'] }]) {
    assert.deepEqual(resolveApiKeyMembers(key, accounts, eligible), []);
  }
  assert.deepEqual(normalizeApiKeyAccountScope({ accountIds: [] }), { accountIds: [], accountScope: 'explicit' });
  assert.deepEqual(resolveApiKeyMembers({ accountScope: 'legacy-all', accountIds: [] }, accounts, eligible).map((account) => account.id), ['a', 'b']);
});

const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function serverFunction(name) {
  const start = serverSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `server function ${name} exists`);
  const end = serverSource.indexOf('\n}', start);
  return serverSource.slice(start, end + 2);
}

function memberRuntime(key) {
  const observed = {};
  const accounts = [
    { id: 'a', enabled: true, authenticated: true, remaining: 90, label: 'A' },
    { id: 'b', enabled: true, authenticated: true, remaining: 40, accountKind: 'relay', label: 'B' },
    { id: 'exhausted', enabled: true, authenticated: true, remaining: 0, label: 'Exhausted' },
    { id: 'disabled', enabled: false, authenticated: true, remaining: 80 },
    { id: 'expired', enabled: true, authenticated: true, quotaErrorCode: 'auth_expired', remaining: 80 },
    { id: 'unauthorized', enabled: true, authenticated: false, remaining: 80 },
  ];
  const context = vm.createContext({
    accounts, LEGACY_ALL_ACCOUNT_SCOPE, resolveApiKeyMembers,
    isCodexAuthenticated: (account) => account.authenticated,
    accountRemainingPercent: (account) => account.remaining,
    accountHasUsableQuota: (account) => account.remaining > 0,
    accountPoolCooldowns: new Map(), accountPoolLastUsed: new Map(), accountModelCapabilities: new Map(),
    apiServiceManager: { keys: [key], ensureAccountPool() {}, publicState: () => ({ keys: [{ ...key }] }) },
    wakeModelCatalog: () => [], apiKeyNetworkId: (id) => id,
    networkManager: { publicAssignment: () => ({ mode: 'direct' }) },
    combinedAccountQuota: (pool) => ({ remainingPercent: 50, totalRemainingPercent: 150, accountCount: pool.length }),
    accountView: () => ({ network: {} }), wakeState: () => ({}),
    reconcileActiveApiCodexState: () => ({ keyId: key.id }),
    detectCodexDesktopSnapshot: () => ({ pid: 0 }), activeCodexAccountId: () => '',
    usageTracker: { sync() {}, summary: () => ({ accounts: {} }) }, usageForLocalDate: () => ({}),
    combinedFloatingQuotaWindows: (pool) => { observed.floatingMembers = pool.map((account) => account.id); return []; },
    hasSpendableCredits: () => false,
  });
  vm.runInContext(['apiKeyConfiguredMembers', 'apiKeyMembers', 'accountPoolCandidates', 'accountPoolHealth', 'diagnosticTarget', 'publicApiServiceState', 'floatingQuotaSync', 'recentActiveFloatingTask', 'floatingWindowState']
    .map(serverFunction).join('\n'), context);
  return { context, observed, accounts };
}

function ids(members) { return Array.from(members, (member) => member.id); }

test('real server gateway, model diagnostics, reset-card public members and floating state agree for migrated empty keys', () => {
  const key = { id: 'legacy', accountScope: 'legacy-all', accountIds: [] };
  const { context, observed } = memberRuntime(key);
  const expected = ['a', 'b', 'exhausted'];
  assert.deepEqual(ids(context.apiKeyMembers(key)), expected);
  const state = context.publicApiServiceState();
  assert.deepEqual(Array.from(state.keys[0].resolvedAccountIds), expected);
  assert.deepEqual(Array.from(state.keys[0].accountIds), [], 'public state keeps the original configuration separate');
  assert.deepEqual(ids(state.keys[0].backingAccounts), expected);
  assert.deepEqual(ids(context.diagnosticTarget('api-key:legacy').members), expected);
  assert.equal(context.diagnosticTarget('api-member:legacy:exhausted').account.id, 'exhausted');
  assert.throws(() => context.diagnosticTarget('api-member:legacy:disabled'), /not a member/);
  assert.throws(() => context.diagnosticTarget('api-member:missing:a'), /not a member/);
  context.floatingWindowState();
  assert.deepEqual(Array.from(observed.floatingMembers), expected);
  assert.deepEqual(ids(context.accountPoolHealth(key)), ['a', 'b', 'exhausted', 'disabled', 'expired', 'unauthorized'],
    'health diagnostics retain configured members that are ineligible for routing');
  assert.deepEqual(Array.from(context.accountPoolHealth(key), (account) => [account.id, account.status]), [
    ['a', 'available'], ['b', 'available'], ['exhausted', 'quota_exhausted'],
    ['disabled', 'disabled'], ['expired', 'authentication_required'], ['unauthorized', 'authentication_required'],
  ]);
  assert.deepEqual(ids(context.accountPoolCandidates(key)), ['a', 'b'], 'routing eligibility excludes exhausted members only at request time');
  context.accountPoolCooldowns.set('a', Date.now() + 60_000);
  context.accountModelCapabilities.set('b', new Set(['allowed']));
  assert.deepEqual(ids(context.accountPoolCandidates(key, 'allowed')), ['b']);
  assert.deepEqual(ids(context.accountPoolCandidates(key, 'other')), []);
  assert.deepEqual(ids(context.diagnosticTarget('api-key:legacy').members), expected, 'cooldown/model checks must not erase pool membership');
});

test('real server never expands explicit empty/deleted-member scopes and retains explicit routing order', () => {
  for (const accountIds of [[], ['gone'], ['b', 'a', 'b']]) {
    const key = { id: 'explicit', accountScope: 'explicit', accountIds };
    const { context, observed } = memberRuntime(key);
    const expected = accountIds.includes('b') ? ['b', 'a'] : [];
    assert.deepEqual(ids(context.apiKeyMembers(key)), expected);
    assert.deepEqual(ids(context.accountPoolCandidates(key)), expected);
    assert.deepEqual(ids(context.accountPoolHealth(key)), expected);
    assert.deepEqual(ids(context.diagnosticTarget('api-key:explicit').members), expected);
    assert.deepEqual(Array.from(context.publicApiServiceState().keys[0].resolvedAccountIds), expected);
    context.floatingWindowState();
    assert.deepEqual(Array.from(observed.floatingMembers), expected);
  }
});

test('diagnostics treat legacy all-account members as busy while their API key is active', async () => {
  const key = { id: 'legacy', accountScope: 'legacy-all', accountIds: [] };
  const { context } = memberRuntime(key);
  context.readActiveApiCodex = () => ({ keyId: key.id });
  context.wakeOperations = new Map();
  context.ModelDiagnostics = class { constructor(probe) { this.probe = probe; } };
  const start = serverSource.indexOf('const modelDiagnostics = new ModelDiagnostics(');
  const end = serverSource.indexOf('\nfunction browserPlacementIsVisible', start);
  vm.runInContext(`${serverSource.slice(start, end)}\nthis.probe = modelDiagnostics.probe;`, context);
  const result = await context.probe({ targetId: 'a', model: 'test', allowBusy: false });
  assert.equal(result.state, 'busy');
});

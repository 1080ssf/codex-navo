const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { beginQuotaRead, quotaRefreshDue } = require('../lib/quota-refresh-scheduler');
const { resolveApiKeyMembers } = require('../lib/api-key-members');
const { normalizeWakeSettings, shouldVerifyWakeAccount } = require('../lib/wake');

// Run the production orchestration functions with in-memory account data and
// mocked process/network/persistence dependencies. Never import server.js.
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
function serverFunction(name, { optional = false } = {}) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  if (optional && !match) return '';
  assert.ok(match, `${name} exists in server.js`);
  const end = source.indexOf('\n}', match.index);
  assert.ok(end >= 0, `${name} closes`);
  return source.slice(match.index, end + 2);
}

const NOW = Date.parse('2026-09-16T02:00:00Z');
function failedAccount(id) {
  return {
    id, quotaError: 'old proxy failure', quotaErrorCode: 'fetch_failed',
    quotaRefreshFailureCount: 8,
    quotaRefreshRetryAt: new Date(NOW + 30 * 60_000).toISOString(),
    quotaRefreshAttemptedAt: new Date(NOW - 60_000).toISOString(),
  };
}

function quotaRuntime(pooled) {
  const accounts = [failedAccount('a'), failedAccount('b')];
  const key = { id: 'fixture-key' };
  const context = vm.createContext({
    accounts, beginQuotaRead,
    process: { env: {} }, settings: { mockLaunch: false },
    detectCodexDesktopSnapshot: () => ({ pid: 1 }),
    publicApiServiceState: () => ({ activeKeyId: pooled ? key.id : '' }),
    apiServiceManager: { keys: [key] },
    apiKeyMembers: () => accounts,
    apiKeyTaskEnvironment: async () => ({}),
    activeCodexAccountId: () => 'a',
    accountPaths: () => ({ codexHomeDir: 'unused-in-memory-test' }),
    prepareAccountNetwork: async () => {},
    accountTaskEnvironment: async () => ({}),
    backgroundTaskEnvironment: async () => ({}),
    codexEnvironment: () => ({}),
    findCodexCli: async () => 'never-spawned-fixture',
    readCodexQuota: async () => ({ refreshedAt: new Date(NOW).toISOString(), windows: [] }),
    quotaObservation: (quota) => quota,
    isCodexAuthenticated: () => true,
    readAccountAuth: () => ({}),
    inspectAccountHealth: () => ({}),
    saveAccounts() {}, audit() {}, floatingWindowState: () => ({}),
  });
  vm.runInContext(['refreshFloatingWindowQuota', 'refreshWakeQuota', 'checkAccountHealth'].map((name) => serverFunction(name)).join('\n'), context);
  return { context, accounts };
}

function assertBackoffCleared(account) {
  assert.equal(account.quotaRefreshFailureCount, 0);
  assert.equal(account.quotaRefreshRetryAt, '');
  assert.equal(account.quotaRefreshSucceededAt, new Date(NOW).toISOString());
  assert.equal(account.quotaErrorCode, '');
  assert.equal(quotaRefreshDue(account, true, NOW + 59_999), false);
  assert.equal(quotaRefreshDue(account, true, NOW + 60_000), true);
}

test('ordinary floating-window manual refresh clears an earlier background retry deadline', async () => {
  const { context, accounts } = quotaRuntime(false);
  await context.refreshFloatingWindowQuota();
  assertBackoffCleared(accounts[0]);
  assert.equal(accounts[1].quotaRefreshFailureCount, 8, 'unrelated account state is not changed');
});

test('API-pool floating-window refresh clears each successfully refreshed member backoff', async () => {
  const { context, accounts } = quotaRuntime(true);
  await context.refreshFloatingWindowQuota();
  accounts.forEach(assertBackoffCleared);
});

test('successful wake verification and online health reads also restore background refresh cadence', async () => {
  const { context, accounts } = quotaRuntime(false);
  await context.refreshWakeQuota(accounts[0]);
  await context.checkAccountHealth(accounts[1], 'fixture');
  accounts.forEach(assertBackoffCleared);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
for (const firstEntry of ['health', 'floating', 'pool', 'wake', 'quota-route']) {
  for (const outcome of ['success', 'auth-failure']) {
    test(`late ${firstEntry} ${outcome} cannot replace a newer health snapshot`, async () => {
      const { context, accounts } = quotaRuntime(firstEntry === 'pool');
      if (firstEntry === 'pool') context.apiKeyMembers = () => [accounts[0]];
      const requests = [];
      context.readCodexQuota = () => new Promise((resolve, reject) => requests.push({ resolve, reject }));
      if (firstEntry === 'quota-route') {
        const start = source.indexOf("      if (operation === 'quota') {");
        const end = source.indexOf("      if (operation === 'wake') {", start);
        Object.assign(context, { operation: 'quota', account: accounts[0], accountId: 'a', operator: 'fixture', response: {},
          accountView: account => ({ quota: account.quota }),
          sendJson: (_response, status, body) => ({ status, body }),
          sendError: (_response, status, message) => ({ status, message }),
          refreshAccountPlanExpiry: async () => {},
        });
        vm.runInContext(`async function quotaRoute() { ${source.slice(start, end)} }`, context);
      }
      const old = firstEntry === 'health' ? context.checkAccountHealth(accounts[0], 'old')
        : firstEntry === 'wake' ? context.refreshWakeQuota(accounts[0])
        : firstEntry === 'quota-route' ? context.quotaRoute()
        : context.refreshFloatingWindowQuota();
      // A wake caller retains an explicit unknown/superseded outcome, not a
      // successful verification manufactured from another reader's result.
      const oldResult = Promise.resolve(old).catch(error => error);
      await flush();
      const fresh = context.checkAccountHealth(accounts[0], 'fresh');
      await flush();
      assert.equal(requests.length, 2);
      requests[1].resolve({ label: 'newer', refreshedAt: new Date(NOW + 2000).toISOString(), windows: [] });
      await fresh;
      if (outcome === 'success') requests[0].resolve({ label: 'older', refreshedAt: new Date(NOW + 1000).toISOString(), windows: [] });
      else requests[0].reject(new Error('401 unauthorized from earlier read'));
      const result = await oldResult;
      assert.equal(accounts[0].quota.label, 'newer');
      assert.equal(accounts[0].quotaCheckedAt, new Date(NOW + 2000).toISOString());
      assert.equal(accounts[0].quotaErrorCode, '');
      assert.equal(accounts[0].quotaError, '');
      if (firstEntry === 'wake') assert.equal(result.code, 'QUOTA_REFRESH_SUPERSEDED');
      if (firstEntry === 'quota-route') assert.equal(result.body.superseded, true);
    });
  }
}

test('a health request superseded during network preparation does not start a late quota read', async () => {
  const { context, accounts } = quotaRuntime(false);
  let release, preparations = 0, reads = 0;
  context.backgroundTaskEnvironment = async () => {
    if (++preparations === 1) await new Promise(resolve => { release = resolve; });
    return {};
  };
  context.readCodexQuota = async () => { reads++; return { label: 'current', refreshedAt: new Date(NOW).toISOString() }; };
  const old = context.checkAccountHealth(accounts[0], 'old');
  await flush();
  await context.checkAccountHealth(accounts[0], 'newer');
  release(); await old;
  assert.equal(reads, 1);
  assert.equal(accounts[0].quota.label, 'current');
});

for (const route of ['floating', 'pool-route']) for (const outcome of ['success', 'failure']) {
  test(`${route} owns member generations before shared preparation; late ${outcome} cannot replace a newer refresh`, async () => {
    const { context, accounts } = quotaRuntime(true);
    context.apiKeyMembers = () => [accounts[0]];
    let release, fail, reads = 0;
    context.apiKeyTaskEnvironment = () => new Promise((resolve, reject) => { release = resolve; fail = reject; });
    context.readCodexQuota = async () => { reads++; return { label: 'newer-health', refreshedAt: new Date(NOW).toISOString() }; };
    if (route === 'pool-route') {
      const start = source.indexOf('    const apiKeyLaunchMatch =');
      const end = source.indexOf('    const apiKeyMatch =', start);
      Object.assign(context, { url: { pathname: '/api/api-service/keys/fixture-key/refresh' }, request: { method: 'POST' }, response: {},
        sendJson: (_response, status, body) => ({ status, body }), sendError: (_response, status, message) => ({ status, message }) });
      vm.runInContext(`async function poolRoute() { ${source.slice(start, end)} }`, context);
    }
    const old = route === 'floating' ? context.refreshFloatingWindowQuota() : context.poolRoute();
    await flush();
    await context.checkAccountHealth(accounts[0], 'newer');
    if (outcome === 'success') release({}); else fail(new Error('old preparation failed'));
    await old;
    assert.equal(reads, 1, 'the older pool does not start a new upstream read after preparation');
    assert.equal(accounts[0].quota.label, 'newer-health');
    assert.equal(accounts[0].quotaErrorCode, '');
  });
}

function wakeRuntime({ enabled, mode, expired = false }) {
  let verified = 0, generated = 0, resetProbes = 0;
  const account = { id: 'pending-account', quotaErrorCode: expired ? 'auth_expired' : '' };
  const state = {
    pendingWakeVerification: {
      trigger: 'manual', submittedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      commandVerified: true, checkCount: 0,
    },
    lastWakeEvidence: { verified: true, submission: 'completed' },
  };
  const context = vm.createContext({
    accounts: [account], wakeScheduleRunning: false,
    wakeSettings: normalizeWakeSettings({ enabled, mode }),
    isCodexAuthenticated: () => true,
    wakeOperations: new Set(),
    wakeState: () => state,
    shouldVerifyWakeAccount,
    verifyPendingWakeAccount: async () => { verified += 1; state.pendingWakeVerification = null; },
    detectResetForAccount: async () => { resetProbes += 1; },
    shouldWakeAccount: () => true,
    wakeAccount: async () => { generated += 1; },
    audit() {},
  });
  vm.runInContext(serverFunction('runScheduledWakes'), context);
  return { context, counts: () => ({ verified, generated, resetProbes }) };
}

for (const settings of [{ enabled: true, mode: 'manual' }, { enabled: false, mode: 'daily' }, { enabled: false, mode: 'after-reset' }]) {
  test(`submitted manual wakes still get quota-only confirmation with automatic mode ${settings.mode}, enabled=${settings.enabled}`, async () => {
    const { context, counts } = wakeRuntime(settings);
    await context.runScheduledWakes();
    assert.deepEqual(counts(), { verified: 1, generated: 0, resetProbes: 0 });
    assert.equal(context.wakeScheduleRunning, false);
    await context.runScheduledWakes();
    assert.deepEqual(counts(), { verified: 1, generated: 0, resetProbes: 0 });
  });
}

test('a pending wake with expired authorization does not issue quota checks or another generation', async () => {
  const { context, counts } = wakeRuntime({ enabled: false, mode: 'manual', expired: true });
  await context.runScheduledWakes();
  assert.deepEqual(counts(), { verified: 0, generated: 0, resetProbes: 0 });
});

function poolHealthRuntime() {
  const accounts = [
    { id: 'healthy', label: 'Healthy', authenticated: true, remaining: 80 },
    { id: 'disabled', label: 'Disabled', enabled: false, authenticated: true, remaining: 80 },
    { id: 'expired', label: 'Expired', authenticated: true, quotaErrorCode: 'auth_expired', remaining: 80 },
    { id: 'unauthorized', label: 'Unauthorized', authenticated: false, remaining: 80 },
  ];
  const context = vm.createContext({
    accounts, resolveApiKeyMembers,
    isCodexAuthenticated: (account) => account.authenticated,
    accountRemainingPercent: (account) => account.remaining,
    accountHasUsableQuota: (account) => account.remaining > 0,
    accountPoolCooldowns: new Map(), accountModelCapabilities: new Map(),
    hasSpendableCredits: () => false,
  });
  vm.runInContext([
    serverFunction('apiKeyConfiguredMembers', { optional: true }),
    serverFunction('apiKeyMembers'), serverFunction('accountPoolHealth'),
  ].join('\n'), context);
  return context;
}

for (const key of [
  { id: 'explicit', accountScope: 'explicit', accountIds: ['healthy', 'disabled', 'expired', 'unauthorized', 'deleted'] },
  { id: 'legacy', accountScope: 'legacy-all', accountIds: [] },
]) {
  test(`${key.accountScope} pool health reports unhealthy configured members without routing requests to them`, () => {
    const context = poolHealthRuntime();
    const actual = Array.from(context.accountPoolHealth(key), (account) => [account.id, account.status]);
    assert.deepEqual(actual, [
      ['healthy', 'available'], ['disabled', 'disabled'],
      ['expired', 'authentication_required'], ['unauthorized', 'authentication_required'],
    ]);
    assert.deepEqual(Array.from(context.apiKeyMembers(key), (account) => account.id), ['healthy']);
    assert.deepEqual(Array.from(context.accountPoolHealth({ accountScope: 'explicit', accountIds: [] })), []);
  });
}

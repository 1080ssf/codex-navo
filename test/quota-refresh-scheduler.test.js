const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { QuotaRefreshScheduler, quotaRefreshDue, refreshAccountQuota, applyQuotaSnapshot, beginQuotaRead } = require('../lib/quota-refresh-scheduler');

const START = Date.parse('2026-09-12T09:00:00Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('new reader ownership invalidates an older reader before either response arrives', () => {
  const account = {}, first = beginQuotaRead(account), second = beginQuotaRead(account);
  assert.equal(first.isCurrent(), false);
  assert.throws(() => first.apply({ label: 'old' }), { code: 'QUOTA_REFRESH_SUPERSEDED' });
  assert.equal(account.quota, undefined);
  second.apply({ label: 'new', refreshedAt: new Date(START).toISOString() });
  assert.equal(second.isCurrent(), true);
  assert.equal(account.quota.label, 'new');
});

test('late background auth failure cannot mark an in-flight newer manual request as expired', async () => {
  const account = {};
  let reject;
  const old = refreshAccountQuota(account, { persist() {}, loadQuota: () => new Promise((_resolve, fail) => { reject = fail; }) });
  await flush();
  const current = beginQuotaRead(account);
  reject(new Error('401 unauthorized'));
  await old;
  assert.equal(account.quotaErrorCode, undefined);
  current.apply({ refreshedAt: new Date(START).toISOString() });
  assert.equal(account.quotaErrorCode, '');
});

test('manual success clears prior backoff and resumes the active one-minute cadence', () => {
  const account = { quotaRefreshFailureCount: 8, quotaRefreshRetryAt: new Date(START + 1_800_000).toISOString(), quotaErrorCode: 'auth_expired' };
  applyQuotaSnapshot(account, { refreshedAt: new Date(START).toISOString() });
  assert.equal(account.quotaRefreshFailureCount, 0);
  assert.equal(account.quotaRefreshRetryAt, '');
  assert.equal(account.quotaErrorCode, '');
  assert.equal(quotaRefreshDue(account, true, START + 59_999), false);
  assert.equal(quotaRefreshDue(account, true, START + 60_000), true);
});

for (const outcome of ['success', 'auth-failure']) test(`an older background ${outcome} cannot overwrite a newer manual success`, async () => {
  const account = {};
  let complete, fail;
  const pending = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const work = refreshAccountQuota(account, { now: () => START, persist() {}, loadQuota: () => pending });
  await flush();
  applyQuotaSnapshot(account, { label: 'manual-newer', refreshedAt: new Date(START + 1000).toISOString() });
  if (outcome === 'success') complete({ label: 'background-older', refreshedAt: new Date(START + 2000).toISOString() });
  else fail(new Error('401 unauthorized'));
  await work;
  assert.equal(account.quota.label, 'manual-newer');
  assert.equal(account.quotaErrorCode, '');
  assert.equal(account.quotaRefreshRetryAt, '');
});

test('network preparation failures record attempts and retain the last successful quota', async () => {
  const account = { id: 'test', quota: { refreshedAt: new Date(START - 600_000).toISOString() } };
  let persisted = 0;
  await refreshAccountQuota(account, {
    active: true, now: () => START, persist: () => { persisted += 1; },
    loadQuota: async () => { throw new Error('测试代理不可用'); },
  });
  assert.equal(persisted, 2);
  assert.equal(account.quotaRefreshAttemptedAt, new Date(START).toISOString());
  assert.equal(account.quota.refreshedAt, new Date(START - 600_000).toISOString());
  assert.equal(account.quotaCheckedAt, undefined);
  assert.match(account.quotaError, /准备网络.*测试代理不可用/);
  assert.equal(account.quotaRefreshFailureCount, 1);
  assert.equal(quotaRefreshDue(account, true, START + 5_000), false);
  assert.equal(quotaRefreshDue(account, true, START + 60_000), true);
});

test('failure backoff grows within a bound, and a success restores the normal cadence', async () => {
  const account = { id: 'test' };
  let now = START;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await refreshAccountQuota(account, {
      active: true, now: () => now, persist() {}, loadQuota: async () => { throw new Error('offline'); },
    });
    const retryAt = Date.parse(account.quotaRefreshRetryAt);
    assert.equal(retryAt - now, Math.min(30 * 60_000, 60_000 * 2 ** (attempt - 1)));
    now = retryAt;
  }
  await refreshAccountQuota(account, {
    now: () => now, persist() {}, loadQuota: async () => ({ refreshedAt: new Date(now).toISOString() }),
  });
  assert.equal(account.quotaRefreshFailureCount, 0);
  assert.equal(account.quotaRefreshRetryAt, '');
  assert.equal(account.quotaError, '');
  assert.equal(quotaRefreshDue(account, true, now + 59_999), false);
  assert.equal(quotaRefreshDue(account, true, now + 60_000), true);
  assert.equal(quotaRefreshDue(account, false, now + 299_999), false);
  assert.equal(quotaRefreshDue(account, false, now + 300_000), true);
});

test('a timed out preparation cannot start a late quota request or overwrite a newer result', async () => {
  const account = { id: 'test' };
  let release, reads = 0;
  const preparation = new Promise((resolve) => { release = resolve; });
  await refreshAccountQuota(account, {
    timeoutMs: 10, now: () => START, persist() {},
    loadQuota: async (context) => {
      await preparation;
      context.checkpoint('读取额度');
      reads += 1;
      return { refreshedAt: new Date(START).toISOString() };
    },
  });
  assert.match(account.quotaError, /超时/);
  release();
  await flush();
  assert.equal(reads, 0);
  assert.equal(account.quota, undefined);
});

test('completed accounts can start new work while a different account remains slow', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const scheduler = new QuotaRefreshScheduler({ concurrency: 2, refresh: async ({ account }) => {
    calls.push(account.id);
    if (account.id === 'slow') await slow;
  } });
  const slowEntry = { account: { id: 'slow' } }, fastEntry = { account: { id: 'fast' } };
  const first = scheduler.scan([slowEntry, fastEntry]);
  await flush();
  assert.equal(scheduler.running.size, 1);
  const second = scheduler.scan([slowEntry, fastEntry]);
  await Promise.all(second);
  assert.deepEqual(calls, ['slow', 'fast', 'fast']);
  release();
  await Promise.all(first);
});

test('late quota replies cannot replace data after their per-account deadline', async () => {
  const account = { id: 'test' };
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await refreshAccountQuota(account, { timeoutMs: 10, now: () => START, persist() {}, loadQuota: () => pending });
  account.quota = { refreshedAt: new Date(START + 60_000).toISOString(), label: 'newer' };
  release({ refreshedAt: new Date(START).toISOString(), label: 'late' });
  await flush();
  assert.equal(account.quota.label, 'newer');
});

test('server integration includes API proxy setup and CLI discovery in per-account error state', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const block = source.slice(source.indexOf('async function refreshScheduledAccountQuota('), source.indexOf('async function refreshDueAccountQuotas('));
  let reads = 0;
  const context = vm.createContext({
    refreshAccountQuota, accounts: [], process: { env: {} }, saveAccounts() {}, audit() {},
    accountPaths: () => ({ codexHomeDir: 'unused-test-path' }),
    prepareAccountNetwork: async () => { throw new Error('测试代理失败'); },
    codexEnvironment: () => ({}),
    findCodexCli: async () => { throw new Error('测试 CLI 未就绪'); },
    readCodexQuota: async () => { reads += 1; },
  });
  vm.runInContext(block, context);
  const individual = { id: 'individual' };
  await context.refreshScheduledAccountQuota(individual, null, true);
  assert.match(individual.quotaError, /准备网络.*测试代理失败/);
  const pooled = { id: 'pooled' };
  await context.refreshScheduledAccountQuota(pooled, async () => { throw new Error('测试共享代理失败'); }, true);
  assert.match(pooled.quotaError, /准备网络.*测试共享代理失败/);
  const cli = { id: 'cli' };
  await context.refreshScheduledAccountQuota(cli, {}, true);
  assert.match(cli.quotaError, /查找 Codex CLI.*测试 CLI 未就绪/);
  assert.ok(individual.quotaRefreshAttemptedAt && pooled.quotaRefreshAttemptedAt && cli.quotaRefreshAttemptedAt);
  assert.equal(reads, 0);
});

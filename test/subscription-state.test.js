const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const server = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const source = server.slice(server.indexOf('const PLAN_EXPIRY_REFRESH_MS'), server.indexOf('let planExpiryRefreshRun'));
function harness(read, account = { id: 'workspace' }) {
  const calls = [], saves = [], audits = [];
  const context = vm.createContext({
    path, Date, Map, isCodexAuthenticated: () => true, accountPaths: () => ({ browserDir: '/profile' }),
    readLiveChromeDebugPort: async () => 1234,
    readAccountAuth: () => ({ tokens: { access_token: 'test-token', account_id: 'workspace' } }),
    decodeJwtClaims: () => ({}), readProtocolSubscription: async options => { calls.push(options); return read(); },
    saveAccounts: rows => saves.push(JSON.parse(JSON.stringify(rows))), accounts: [account],
    audit: (...args) => audits.push(args),
  });
  vm.runInContext(source, context);
  return { run: options => context.refreshAccountPlanExpiry(account, options), account, calls, saves, audits };
}
const subscription = { planType: 'self_serve_business_prolite', expiresAt: '2026-10-18T13:31:46.000Z', renewsAt: '2026-10-18T07:31:46.000Z', billingPeriod: 'monthly' };

test('subscription refresh persists the observed workspace plan and both distinct dates', async () => {
  const h = harness(async () => subscription);
  await h.run({ force: true });
  assert.equal(h.account.subscriptionPlanType, subscription.planType);
  assert.equal(h.account.planExpiresAt, subscription.expiresAt);
  assert.equal(h.account.planRenewsAt, subscription.renewsAt);
  assert.equal(h.account.planExpiryStatus, 'available');
  assert.equal(h.saves.length, 1);
  assert.equal(h.calls[0].closeBrowser, false);
});

test('concurrent manual and scheduled refreshes share one subscription read', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  const a = h.run({ force: true }), b = h.run({ force: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  finish(subscription);
  assert.deepEqual(await Promise.all([a,b]), [subscription.expiresAt, subscription.expiresAt]);
  assert.equal(h.saves.length, 1);
});

test('verification failures preserve last valid dates and do not cause frequent background retries', async () => {
  const h = harness(async () => { throw Object.assign(new Error('verification required'), { code: 'verification_required', status: 403, stage: 'web_session' }); }, { id: 'workspace', planExpiresAt: subscription.expiresAt });
  await h.run({ force: true });
  assert.equal(h.account.planExpiryStatus, 'verification_required');
  assert.equal(h.account.planExpiryErrorStage, 'web_session');
  assert.equal(h.account.planExpiresAt, subscription.expiresAt);
  h.account.planExpiryCheckedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  await h.run();
  assert.equal(h.calls.length, 1);
  await h.run({ force: true });
  assert.equal(h.calls.length, 2);
});

test('a successful retry clears old errors and never fabricates expiry from renewal', async () => {
  const h = harness(async () => ({ ...subscription, expiresAt: null }), { id: 'workspace', planExpiresAt: subscription.expiresAt, planExpiryError: 'old', planExpiryErrorCode: 'verification_required', planExpiryErrorStage: 'web_session' });
  await h.run({ force: true });
  assert.equal(h.account.planExpiresAt, undefined);
  assert.equal(h.account.planExpiryStatus, 'renewal');
  assert.equal(h.account.planExpiryErrorCode, '');
  assert.equal(h.account.planExpiryErrorStage, '');
});

test('main account plan rendering recognizes the observed Business tier without turning all Business accounts into 5x', () => {
  const client = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(client.slice(client.indexOf('function formatPlan('), client.indexOf('function formatUsdBalance(')), context);
  assert.equal(context.formatPlan('self_serve_business_prolite'), 'BUSINESS×5');
  assert.equal(context.formatPlan('business'), 'BUSINESS');
  assert.equal(context.formatPlan('pro'), 'PRO');
  assert.equal(context.formatPlan('pro_x5'), 'PRO×5');
  assert.equal(context.formatPlan('unrecognized'), '套餐待识别');
});

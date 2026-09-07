const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexUsageTracker, localDateKey } = require('../lib/codex-usage');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-repricing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const home = path.join(root, 'account');
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const file = path.join(home, 'sessions', 'rollout-test.jsonl');
  fs.writeFileSync(file, [
    { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
    { timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 100000, cached_input_tokens: 90000, output_tokens: 1000 },
    } } },
  ].map(JSON.stringify).join('\n') + '\n');
  const tracker = new CodexUsageTracker({ storeFile: path.join(root, 'usage.json'),
    sharedCodexHome: path.join(root, 'shared'), getAccounts: () => [{ id: 'a' }],
    getAccountHome: () => home, getActiveAccountId: () => null });
  tracker.sync(true);
  const usage = tracker.store.days[localDateKey()].accounts.a;
  usage.estimatedCostUsd = 0;
  usage.pricedRequests = 0;
  usage.unpricedRequests = 1;
  tracker.save();
  return { tracker, usage, file };
}

test('equal-sized diagnostic requests count separately while duplicate events do not', (t) => {
  const { tracker } = fixture(t);
  const cursor = { model: 'gpt-6-astra' };
  const line = (id) => JSON.stringify({ type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { navo_diagnostic_request_id: id,
      last_token_usage: { input_tokens: 20, output_tokens: 2 } } } });
  assert.equal(tracker.inspectLine(line('first'), cursor, 'diagnostic'), true);
  assert.equal(tracker.inspectLine(line('first'), cursor, 'diagnostic'), false);
  assert.equal(tracker.inspectLine(line('second'), cursor, 'diagnostic'), true);
  assert.equal(tracker.store.days[localDateKey()].accounts.diagnostic.requests, 2);
});

test('repricing repairs amounts without changing counts and preserves a backup', async (t) => {
  const { tracker, usage } = fixture(t);
  const result = await tracker.reconcileHistoricalCosts();
  assert.equal(result.updated, 1);
  assert.equal(usage.estimatedCostUsd, 0.24);
  assert.equal(usage.totalTokens, 101000);
  assert.equal(usage.pricedRequests, 1);
  assert.equal(usage.unpricedRequests, 0);
  assert.ok(fs.existsSync(`${tracker.storeFile}.before-pricing-2026-09-06.bak`));
  assert.equal(await tracker.reconcileHistoricalCosts(), null);
});

test('repricing preserves aggregates when source history is missing or mismatched', async (t) => {
  const { tracker, usage, file } = fixture(t);
  fs.unlinkSync(file);
  assert.equal((await tracker.reconcileHistoricalCosts()).skipped, 1);
  assert.equal(usage.requests, 1);
  assert.equal(usage.unpricedRequests, 1);
  assert.equal(tracker.store.pricingRevision, undefined);
  assert.equal(await tracker.reconcileHistoricalCosts(), null);
});

test('repricing will not apply a partial replay to a larger saved bucket', async (t) => {
  const { tracker, usage } = fixture(t);
  usage.requests++;
  assert.equal((await tracker.reconcileHistoricalCosts()).updated, 0);
  assert.equal(usage.requests, 2);
  assert.equal(usage.estimatedCostUsd, 0);
});

test('unrecoverable history backs off instead of replaying every hourly tick', async (t) => {
  const { tracker, file } = fixture(t);
  fs.unlinkSync(file);
  await tracker.reconcileHistoricalCosts();
  const state = tracker.store.pricingReconciliation;
  assert.equal(state.incompleteAttempts, 1);
  assert.ok(Date.parse(state.nextAttemptAt) - Date.parse(state.checkedAt) >= 2 * 60 * 60_000 - 1000);
  state.checkedAt = new Date(Date.now() - 65 * 60_000).toISOString();
  tracker.sources = () => { throw new Error('Should not rescan during backoff'); };
  assert.equal(await tracker.reconcileHistoricalCosts(), null);
});

test('failed replay records retry timing but still reports the underlying error', async (t) => {
  const { tracker } = fixture(t);
  tracker.sources = () => { throw new Error('source unavailable'); };
  await assert.rejects(tracker.reconcileHistoricalCosts(), /source unavailable/);
  assert.equal(tracker.store.pricingReconciliation.failed, true);
  assert.equal(tracker.repricing, false);
  assert.equal(await tracker.reconcileHistoricalCosts(), null);
});

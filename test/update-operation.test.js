const test = require('node:test');
const assert = require('node:assert/strict');
const { singleFlight, updateErrorState, reusableUpdateCheck, progressReporter } = require('../lib/update-operation');
const { packageAvailability } = require('../lib/update-operation');

test('package availability never disguises transport or Store errors as propagation', () => {
  const none = { ok: true, hasUpdate: false };
  assert.equal(packageAvailability(true, { ok: false, status: 404 }, none).status, 'propagating');
  for (const status of [0, 401, 403, 429, 500, 503]) {
    const state = packageAvailability(true, { ok: false, status }, none);
    assert.equal(state.status, 'error');
    assert.match(state.error, /HTTP/);
  }
  assert.equal(packageAvailability(true, { status: 404 }, { ok: false, error: 'Store timed out' }).status, 'error');
  assert.equal(packageAvailability(true, { ok: true }, none).status, 'available');
  assert.equal(packageAvailability(true, { status: 503 }, { ok: true, hasUpdate: true }).status, 'available');
  assert.equal(packageAvailability(false, { status: 503 }, none).status, 'current');
});

test('progress limits intermediate writes and always publishes final progress', () => {
  let now = 0;
  const values = [];
  const report = progressReporter((value) => values.push(value), 250, () => now);
  report(1);
  for (now = 1; now < 250; now++) report(now);
  report(250);
  now++;
  report(251, true);
  assert.deepEqual(values, [1, 250, 251]);
});

test('only recent successful available update checks can be reused', () => {
  const now = Date.now();
  const state = { status: 'available', updateAvailable: true, packageReady: true,
    latestVersion: '1.2.3', packageUrl: 'https://example.test/package.msix', checkedAt: new Date(now - 5000).toISOString() };
  assert.equal(reusableUpdateCheck(state, now), true);
  for (const patch of [{ status: 'error' }, { packageReady: false },
    { checkedAt: new Date(now - 61000).toISOString() }, { checkedAt: new Date(now + 1000).toISOString() }]) {
    assert.equal(reusableUpdateCheck({ ...state, ...patch }, now), false);
  }
});

test('missing release manifest is an error, never evidence that the app is current', () => {
  assert.deepEqual(updateErrorState(new Error('latest.yml HTTP 404')), {
    status: 'error', error: 'latest.yml HTTP 404', errorCode: 'UPDATE_MANIFEST_MISSING',
  });
  assert.equal(updateErrorState(new Error('timeout')).status, 'error');
});

test('concurrent install requests share one operation and release the lock after failure', async () => {
  let calls = 0;
  let finish;
  const run = singleFlight(() => { calls++; return new Promise((resolve, reject) => { finish = reject; }); });
  const first = run();
  assert.equal(run(), first);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish(new Error('blocked'));
  await assert.rejects(first, /blocked/);
  const second = run();
  await Promise.resolve();
  assert.equal(calls, 2);
  finish(new Error('cancelled'));
  await assert.rejects(second, /cancelled/);
});

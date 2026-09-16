const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const wake = require('../lib/wake');
const command = require('../lib/wake-command');

test('daily pre-submission temporary failures get two bounded retries, not a completed day', () => {
  const account = { id: 'test' };
  const settings = wake.normalizeWakeSettings({ enabled: true, mode: 'daily', dailyTime: '09:00' });
  let now = new Date(2026, 8, 12, 9, 0);
  for (let count = 1; count <= 3; count += 1) {
    const initial = wake.wakeAttemptState(settings.accountStates.test || {}, 'daily', 'running', { now });
    const failure = wake.classifyWakeFailure(new Error('ECONNREFUSED'));
    const state = wake.wakeAttemptState(initial, 'daily', 'failed', {
      now, retryable: failure.retryable, evidence: { submission: failure.submission },
    });
    settings.accountStates.test = state;
    assert.equal(state.lastDailyDate, undefined);
    assert.equal(state.dailyAttemptCount, count);
    assert.equal(wake.shouldWakeAccount(settings, account, new Date(now.getTime() + 60_000)), false);
    if (count < 3) {
      now = new Date(state.dailyRetryAt);
      assert.equal(wake.shouldWakeAccount(settings, account, now), true);
    } else assert.equal(wake.shouldWakeAccount(settings, account, new Date(2026, 8, 12, 23, 0)), false);
  }
  assert.equal(wake.shouldWakeAccount(settings, account, new Date(2026, 8, 13, 9, 0)), true);
});

test('authentication, permanent setup failure and sent-but-unknown failures are not automatically retried', () => {
  assert.equal(wake.classifyWakeFailure(new Error('401 unauthorized')).authExpired, true);
  assert.equal(wake.classifyWakeFailure(new Error('401 unauthorized')).retryable, false);
  assert.equal(wake.classifyWakeFailure(new Error('CLI not installed')).retryable, false);
  assert.equal(wake.classifyWakeFailure(new Error('ETIMEDOUT'), 'unknown').retryable, false);
});

test('unknown submissions are only checked, and unrelated user quota changes never prove wake success', () => {
  const now = new Date(2026, 8, 12, 9, 0);
  let state = wake.wakeAttemptState({}, 'daily', 'pending', { now, evidence: { submission: 'unknown', verified: false } });
  const settings = wake.normalizeWakeSettings({ enabled: true, mode: 'daily', dailyTime: '09:00', accountStates: { test: state } });
  assert.equal(wake.shouldWakeAccount(settings, { id: 'test' }, new Date(2026, 8, 12, 23, 0)), false);
  assert.equal(wake.shouldVerifyWakeAccount(state, now), false);
  for (let count = 1; count <= 3; count += 1) {
    const checkTime = new Date(now.getTime() + count * 5 * 60_000);
    assert.equal(wake.shouldVerifyWakeAccount(state, checkTime), true);
    state = wake.wakeVerificationState(state, { active: true, now: checkTime });
    assert.equal(state.lastWakeStatus, 'pending');
  }
  assert.equal(wake.shouldVerifyWakeAccount(state, new Date(2026, 8, 12, 23, 0)), false);
});

test('a verified completed command can finish quota confirmation without generating again', () => {
  let state = wake.wakeAttemptState({}, 'daily', 'pending', {
    evidence: { submission: 'completed', verified: true, quotaWindowActive: false },
  });
  state = wake.wakeVerificationState(state, { active: true });
  assert.equal(state.lastWakeStatus, 'success');
  assert.equal(state.pendingWakeVerification, null);
  const falseSuccess = wake.wakeAttemptState({}, 'daily', 'success', {
    evidence: { submission: 'unknown', verified: false, quotaWindowActive: true },
  });
  assert.equal(falseSuccess.lastWakeStatus, 'pending');
});

test('a preflight crash can resume after backoff, while a persisted submission survives restart without resending', () => {
  const now = new Date(2026, 8, 12, 9, 0);
  const account = { id: 'test' };
  let state = wake.wakeAttemptState({}, 'daily', 'running', { now });
  let settings = wake.normalizeWakeSettings({ enabled: true, mode: 'daily', dailyTime: '09:00', accountStates: { test: JSON.parse(JSON.stringify(state)) } });
  assert.equal(wake.shouldWakeAccount(settings, account, new Date(now.getTime() + 5 * 60_000)), true);
  state = wake.wakeAttemptState(state, 'daily', 'pending', { now, evidence: { submission: 'unknown' } });
  settings = wake.normalizeWakeSettings({ ...settings, accountStates: { test: JSON.parse(JSON.stringify(state)) } });
  assert.equal(wake.shouldWakeAccount(settings, account, new Date(now.getTime() + 5 * 60_000)), false);
});

test('definitive failure to spawn restores an after-reset event instead of losing it', () => {
  const event = { key: 'test-reset' };
  let state = wake.wakeAttemptState({ pendingResetEvent: event }, 'after-reset', 'running');
  state = wake.wakeAttemptState(state, 'after-reset', 'pending', { evidence: { submission: 'unknown' } });
  assert.equal(state.pendingResetEvent, null);
  state = wake.wakeAttemptState(state, 'after-reset', 'failed', { evidence: { submission: 'not-submitted' } });
  assert.deepEqual(state.pendingResetEvent, event);
  assert.equal(state.lastHandledResetEventKey, '');
});

test('a wake finishing after midnight retains the date of the scheduled attempt', () => {
  let state = wake.wakeAttemptState({}, 'daily', 'running', { now: new Date(2026, 8, 12, 23, 59) });
  state = wake.wakeAttemptState(state, 'daily', 'success', {
    now: new Date(2026, 8, 13, 0, 1),
    evidence: { submission: 'completed', verified: true, quotaWindowActive: true },
  });
  assert.equal(state.lastDailyDate, '2026-09-12');
});

function harness(options = {}) {
  const writes = [], account = { id: 'test' };
  let generations = 0, failQuota = options.failQuota;
  const complete = [
    { type: 'item.completed', item: { type: 'agent_message', text: 'test response' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
  ];
  const context = vm.createContext({
    ...wake, ...command, path,
    process: { env: {} }, fs: { mkdirSync() {} },
    settings: { mockLaunch: false },
    wakeSettings: wake.normalizeWakeSettings({ enabled: true, mode: 'daily', dailyTime: '00:00', model: 'test-model' }),
    wakeOperations: new Set(), wakeRuns: new Map(), accounts: [account],
    isCodexAuthenticated: () => true,
    accountPaths: () => ({ codexHomeDir: 'test-only-home', codexDir: 'test-only-dir' }),
    ensureCodexProfileConfig() {},
    accountTaskEnvironment: async () => { if (options.failPreparation) throw new Error('ECONNREFUSED'); return {}; },
    findCodexCli: async () => 'test-only-executable',
    saveAccounts() {}, audit() {}, accountView: () => ({ wake: context.wakeSettings.accountStates.test }),
    beginQuotaRead: require('../lib/quota-refresh-scheduler').beginQuotaRead,
    wakeState: () => context.wakeSettings.accountStates.test || {},
    saveWakeSettings: (value) => { context.wakeSettings = value; writes.push(JSON.parse(JSON.stringify(value.accountStates.test))); },
    updateWakeState: (id, value) => { context.wakeSettings.accountStates[id] = { ...context.wakeSettings.accountStates[id], ...value }; },
    readCodexQuota: async () => {
      if (failQuota) throw new Error('test quota offline');
      return { refreshedAt: new Date().toISOString(), windows: [{ windowDurationMins: 300, remainingPercent: 90 }] };
    },
    setTimeout: (callback, ms) => { if (ms === 12_000) queueMicrotask(callback); return 1; },
    clearTimeout() {},
    spawn: () => {
      generations += 1;
      assert.equal(context.wakeSettings.accountStates.test.lastWakeEvidence.submission, 'unknown');
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdout.setEncoding = () => {}; child.stderr.setEncoding = () => {}; child.kill = () => {};
      queueMicrotask(() => {
        if (options.spawnFailure) {
          child.emit('error', Object.assign(new Error('test launch failure'), { code: 'ENOENT' }));
          return;
        }
        child.emit('spawn');
        const events = options.events || complete;
        child.stdout.emit('data', events.map((event) => JSON.stringify(event)).join('\n'));
        child.emit('close', options.exitCode ?? 0);
      });
      return child;
    },
  });
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('function recordWakeAttempt('), source.indexOf('async function refreshQuotaForResetDetection(')), context);
  return { context, account, writes, generations: () => generations, setQuotaOnline: () => { failQuota = false; } };
}

test('actual wake orchestration records preparation failures without spawning a command', async () => {
  const h = harness({ failPreparation: true });
  await assert.rejects(h.context.wakeAccount(h.account, 'daily'), /ECONNREFUSED/);
  const state = h.context.wakeState();
  assert.equal(state.dailyAttemptCount, 1);
  assert.equal(state.dailyRetryAllowed, true);
  assert.equal(state.lastDailyDate, undefined);
  assert.equal(h.generations(), 0);
});

test('actual wake orchestration persists submission before spawn and only verifies a completed request after quota failure', async () => {
  const h = harness({ failQuota: true });
  await h.context.wakeAccount(h.account, 'daily');
  assert.equal(h.context.wakeState().lastWakeStatus, 'pending');
  assert.equal(h.context.wakeState().pendingWakeVerification.commandVerified, true);
  h.setQuotaOnline();
  await h.context.verifyPendingWakeAccount(h.account);
  assert.equal(h.context.wakeState().lastWakeStatus, 'success');
  assert.equal(h.generations(), 1);
});

test('actual incomplete CLI output remains pending even when unrelated quota use is visible', async () => {
  const h = harness({ events: [{ type: 'error', message: 'network timeout after submitting' }], exitCode: 1 });
  await assert.rejects(h.context.wakeAccount(h.account, 'daily'), /timeout/);
  assert.equal(h.context.wakeState().dailyRetryAllowed, false);
  await h.context.verifyPendingWakeAccount(h.account);
  assert.equal(h.context.wakeState().lastWakeStatus, 'pending');
  assert.equal(h.generations(), 1);
});

test('actual authentication failures stop scheduled attempts and request reauthorization', async () => {
  const h = harness({ events: [{ type: 'error', message: '401 unauthorized' }], exitCode: 1 });
  await assert.rejects(h.context.wakeAccount(h.account, 'daily'), /unauthorized/);
  assert.equal(h.account.quotaErrorCode, 'auth_expired');
  assert.equal(h.context.wakeState().lastWakeStatus, 'failed');
  assert.equal(h.context.wakeState().dailyRetryAllowed, false);
});

test('a definitive spawn failure clears the provisional submitted marker', async () => {
  const h = harness({ spawnFailure: true });
  await assert.rejects(h.context.wakeAccount(h.account, 'daily'), /test launch failure/);
  assert.equal(h.context.wakeState().lastWakeStatus, 'failed');
  assert.equal(h.context.wakeState().lastDailyDate, '');
  assert.equal(h.context.wakeState().pendingWakeVerification, null);
});

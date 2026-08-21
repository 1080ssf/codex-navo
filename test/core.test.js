const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireLease, cleanExpiredLeases, isWithin, normalizeOperator, validateAccountId } = require('../lib/core');
const { hasSpendableCredits, normalizeRateLimits, windowLabel } = require('../lib/codex-quota');
const { CodexUsageTracker, estimateCost, selectedDayKeys, tokenSnapshot } = require('../lib/codex-usage');

test('同一个账号不能被另一位操作员占用', () => {
  const now = Date.parse('2026-08-07T10:00:00.000Z');
  const first = acquireLease({}, 'account-abc', '张三', 'browser', now);
  const second = acquireLease(first.leases, 'account-abc', '李四', 'codex', now + 1000);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.existing.operator, '张三');
});

test('同一操作员可以重新打开且租约不设时限', () => {
  const now = Date.parse('2026-08-07T10:00:00.000Z');
  const first = acquireLease({}, 'account-abc', '张三', 'browser', now);
  const second = acquireLease(first.leases, 'account-abc', '张三', 'codex', now + 60_000);
  assert.equal(second.ok, true);
  assert.equal(second.lease.launchType, 'codex');
  assert.equal(second.lease.expiresAt, undefined);
  assert.equal(second.lease.acquiredAt, first.lease.acquiredAt);
});

test('过期租约会被清理', () => {
  const leases = { a: { expiresAt: '2026-08-07T09:00:00.000Z' }, b: { expiresAt: '2026-08-07T12:00:00.000Z' } };
  const result = cleanExpiredLeases(leases, Date.parse('2026-08-07T10:00:00.000Z'));
  assert.deepEqual(Object.keys(result.leases), ['b']);
});

test('路径必须位于 profiles 根目录内', () => {
  const root = path.resolve('profiles');
  assert.equal(isWithin(root, path.join(root, 'browser', 'account-a')), true);
  assert.equal(isWithin(root, path.resolve(root, '..', 'outside')), false);
});

test('操作员与账号 ID 输入会被限制', () => {
  assert.equal(normalizeOperator(' 张三\r\n伪造日志 '), '张三  伪造日志');
  assert.equal(validateAccountId('account-abcdef'), true);
  assert.equal(validateAccountId('../secret'), false);
});

test('额度窗口会转换为可用百分比并优先显示周额度', () => {
  const quota = normalizeRateLimits({ rateLimits: {
    planType: 'plus',
    credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    primary: { usedPercent: 35, resetsAt: 1000, windowDurationMins: 300 },
    secondary: { usedPercent: 12, resetsAt: 2000, windowDurationMins: 10080 },
  }, rateLimitResetCredits: { availableCount: 3, details: [{ expiresAt: '2026-08-23T00:00:00.000Z' }] } });
  assert.equal(quota.windows[0].label, '周额度');
  assert.equal(quota.windows[0].remainingPercent, 88);
  assert.equal(quota.windows[1].remainingPercent, 65);
  assert.deepEqual(quota.credits, {
    hasCredits: true,
    unlimited: false,
    quantity: 12,
    rawBalance: '12.50',
    usdBalance: '0.48',
    usdPerCredit: 0.04,
  });
  assert.deepEqual(quota.resetCredits, { availableCount: 3, expiresAt: '2026-08-23T00:00:00.000Z' });
  assert.equal(windowLabel({ windowDurationMins: 300 }), '5 小时额度');
});

test('套餐额度耗尽后仍可使用余额，零余额账号才会退出候选池', () => {
  assert.equal(hasSpendableCredits({ hasCredits: true, rawBalance: 0.25, quantity: 0 }), true);
  assert.equal(hasSpendableCredits({ unlimited: true, rawBalance: 0 }), true);
  assert.equal(hasSpendableCredits({ hasCredits: true, rawBalance: 0 }), false);
});

test('Codex 本地 token_count 会拆分输入、缓存、输出并按公开单价估算', () => {
  const usage = tokenSnapshot({
    input_tokens: 100_000,
    cached_input_tokens: 80_000,
    cache_write_input_tokens: 0,
    output_tokens: 10_000,
    reasoning_output_tokens: 4_000,
  });
  assert.deepEqual(usage, { input: 100_000, cachedInput: 80_000, cacheWriteInput: 0, output: 10_000, reasoningOutput: 4_000 });
  assert.equal(estimateCost('gpt-5.6-sol', usage), 0.44);
});

test('用量范围支持今日、昨日和滚动天数', () => {
  const now = new Date('2026-08-08T12:00:00+08:00');
  assert.deepEqual(selectedDayKeys('yesterday', [], now), ['2026-08-07']);
  assert.deepEqual(selectedDayKeys('7d', [], now).slice(0, 2), ['2026-08-08', '2026-08-07']);
});

test('Codex 用量跟踪器只统计基线后新增的真实 JSONL 事件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-usage-'));
  try {
    const sessions = path.join(root, 'shared', 'sessions', '2026', '08', '08');
    fs.mkdirSync(sessions, { recursive: true });
    const rollout = path.join(sessions, 'rollout-test.jsonl');
    fs.writeFileSync(rollout, `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-terra' } })}\n`);
    const tracker = new CodexUsageTracker({
      storeFile: path.join(root, 'usage.json'),
      sharedCodexHome: path.join(root, 'shared'),
      getAccounts: () => [{ id: 'account-test' }],
      getAccountHome: () => path.join(root, 'account-home'),
      getActiveAccountId: () => 'account-test',
    });
    tracker.sync(true);
    assert.equal(tracker.summary('today').totals.requests, 0);
    fs.appendFileSync(rollout, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: {
        input_tokens: 20_000, cached_input_tokens: 5_000, output_tokens: 2_000, reasoning_output_tokens: 800,
      } } },
    })}\n`);
    tracker.sync(true);
    const summary = tracker.summary('today');
    assert.equal(summary.totals.requests, 1);
    assert.equal(summary.accounts['account-test'].totalTokens, 22_000);
    assert.equal(summary.accounts['account-test'].reasoningOutputTokens, 800);
    assert.equal(summary.totals.estimatedCostUsd, 0.06875);
    const archived = path.join(root, 'shared', 'archived_sessions');
    fs.mkdirSync(archived, { recursive: true });
    fs.renameSync(rollout, path.join(archived, path.basename(rollout)));
    tracker.sync(true);
    assert.equal(tracker.summary('today').totals.requests, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('共享 Codex 历史会按 Navo 启动区间回填到正确账号', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-history-'));
  try {
    const sessions = path.join(root, 'shared', 'sessions', '2026', '08', '08');
    fs.mkdirSync(sessions, { recursive: true });
    const occurredAt = new Date();
    const rollout = path.join(sessions, 'rollout-history.jsonl');
    fs.writeFileSync(rollout, [
      JSON.stringify({ timestamp: occurredAt.toISOString(), type: 'turn_context', payload: { model: 'gpt-5.6-luna' } }),
      JSON.stringify({ timestamp: occurredAt.toISOString(), type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 10_000, cached_input_tokens: 4_000, output_tokens: 1_000 },
      } } }),
    ].join('\n') + '\n');
    const tracker = new CodexUsageTracker({
      storeFile: path.join(root, 'usage.json'),
      sharedCodexHome: path.join(root, 'shared'),
      getAccounts: () => [{ id: 'account-history' }],
      getAccountHome: () => path.join(root, 'account-home'),
      getActiveAccountId: () => null,
      getSharedIntervals: () => [{ accountId: 'account-history', startMs: occurredAt.getTime() - 1_000, endMs: occurredAt.getTime() + 1_000 }],
    });
    tracker.sync(true);
    assert.equal(tracker.summary('today').accounts['account-history'].requests, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('子智能体复制的父任务 token_count 不会重复计入本机用量', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-subagent-usage-'));
  try {
    const folder = path.join(root, 'shared', 'sessions', '2026', '08', '19');
    fs.mkdirSync(folder, { recursive: true });
    const parentId = '00000000-0000-4000-8000-000000000101';
    const childId = '00000000-0000-4000-8000-000000000102';
    const now = new Date();
    const parentUsage = { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100 };
    const childUsage = { input_tokens: 2000, cached_input_tokens: 1800, output_tokens: 200 };
    const token = (usage, timestamp = now.toISOString()) => ({
      timestamp, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: usage } },
    });
    const parent = path.join(folder, `rollout-parent-${parentId}.jsonl`);
    const child = path.join(folder, `rollout-child-${childId}.jsonl`);
    fs.writeFileSync(parent, `${[
      { timestamp: now.toISOString(), type: 'session_meta', payload: { id: parentId } },
      { timestamp: now.toISOString(), type: 'turn_context', payload: { model: 'gpt-5.6-luna' } },
      token(parentUsage),
    ].map(JSON.stringify).join('\n')}\n`);
    fs.writeFileSync(child, `${[
      { timestamp: now.toISOString(), type: 'session_meta', payload: { id: childId, source: { subagent: { thread_spawn: { parent_thread_id: parentId } } } } },
      { timestamp: now.toISOString(), type: 'session_meta', payload: { id: parentId } },
      token(parentUsage, new Date(now.getTime() + 60_000).toISOString()),
      { timestamp: new Date(now.getTime() + 61_000).toISOString(), type: 'turn_context', payload: { model: 'gpt-5.6-luna' } },
      token(childUsage, new Date(now.getTime() + 62_000).toISOString()),
    ].map(JSON.stringify).join('\n')}\n`);
    const tracker = new CodexUsageTracker({
      storeFile: path.join(root, 'usage.json'),
      sharedCodexHome: path.join(root, 'shared'),
      getAccounts: () => [],
      getAccountHome: () => '',
      getActiveAccountId: () => 'account-test',
      getSharedIntervals: () => [{ accountId: 'account-test', startMs: now.getTime() - 1000, endMs: now.getTime() + 120_000 }],
    });
    tracker.sync(true);
    const totals = tracker.summary('today').totals;
    assert.equal(totals.requests, 2);
    assert.equal(totals.inputTokens, 3000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

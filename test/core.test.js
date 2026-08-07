const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { acquireLease, cleanExpiredLeases, isWithin, normalizeOperator, validateAccountId } = require('../lib/core');
const { normalizeRateLimits, windowLabel } = require('../lib/codex-quota');

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
  } });
  assert.equal(quota.windows[0].label, '周额度');
  assert.equal(quota.windows[0].remainingPercent, 88);
  assert.equal(quota.windows[1].remainingPercent, 65);
  assert.deepEqual(quota.credits, { hasCredits: true, unlimited: false, points: '12.50' });
  assert.equal(windowLabel({ windowDurationMins: 300 }), '5 小时额度');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectQuotaReset, normalizeWakeSettings, primaryQuotaWindow, quotaObservation, shouldWakeAccount } = require('../lib/wake');
const { readModelCatalog } = require('../lib/model-catalog');

test('唤醒设置默认关闭并限制非法输入', () => {
  const settings = normalizeWakeSettings({ enabled: true, mode: 'unknown', dailyTime: '25:90', prompt: '  ' });
  assert.equal(settings.enabled, true);
  assert.equal(settings.mode, 'manual');
  assert.equal(settings.dailyTime, '09:00');
  assert.equal(settings.prompt, 'hi');
  assert.equal(settings.reasoningEffort, '');
});

test('缺少模型缓存时提供可选择的官方模型和推理强度', () => {
  const models = readModelCatalog(['Z:\\definitely-missing-model-cache.json']);
  assert.equal(models[0].slug, 'gpt-5.6-sol');
  assert.ok(models[0].reasoningEfforts.includes('low'));
  assert.ok(models[0].reasoningEfforts.includes('max'));
});

test('每日策略在指定时间后每天只触发一次', () => {
  const account = { id: 'account-test' };
  const settings = normalizeWakeSettings({ enabled: true, mode: 'daily', dailyTime: '09:00' });
  assert.equal(shouldWakeAccount(settings, account, new Date(2026, 7, 8, 8, 59)), false);
  assert.equal(shouldWakeAccount(settings, account, new Date(2026, 7, 8, 9, 0)), true);
  settings.accountStates[account.id] = { lastDailyDate: '2026-08-08' };
  assert.equal(shouldWakeAccount(settings, account, new Date(2026, 7, 8, 18, 0)), false);
});

test('额度重置策略只选择持续时间最长的 Weekly 窗口', () => {
  const quota = { windows: [
    { windowDurationMins: 300, resetsAt: 100, remainingPercent: 90 },
    { windowDurationMins: 10080, resetsAt: 200, remainingPercent: 40 },
  ] };
  assert.equal(primaryQuotaWindow(quota).resetsAt, 200);
  assert.equal(quotaObservation(quota).remainingPercent, 40);
});

test('预计时间到达、周期时间前移和额度突然恢复都能识别为重置', () => {
  const previous = { resetsAt: 100, remainingPercent: 38 };
  assert.equal(detectQuotaReset(previous, { resetsAt: 100, remainingPercent: 38 }, new Date(101_000)).reason, 'scheduled-time-reached');
  assert.equal(detectQuotaReset(previous, { resetsAt: 200, remainingPercent: 100 }, new Date(50_000)).reason, 'reset-time-advanced');
  assert.equal(detectQuotaReset(previous, { resetsAt: 100, remainingPercent: 100 }, new Date(50_000)).reason, 'quota-restored');
});

test('额度重置事件进入待处理状态后只触发一次', () => {
  const account = { id: 'account-test' };
  const settings = normalizeWakeSettings({ enabled: true, mode: 'after-reset' });
  settings.accountStates[account.id] = { pendingResetEvent: { key: 'cycle:100:200' } };
  assert.equal(shouldWakeAccount(settings, account), true);
  settings.accountStates[account.id].lastHandledResetEventKey = 'cycle:100:200';
  assert.equal(shouldWakeAccount(settings, account), false);
});

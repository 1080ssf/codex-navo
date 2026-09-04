const MODES = new Set(['manual', 'daily', 'after-reset']);

function normalizeWakeSettings(value = {}) {
  const dailyTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value.dailyTime || ''))
    ? String(value.dailyTime)
    : '09:00';
  const model = String(value.model || '').trim().slice(0, 80);
  const reasoningEffort = String(value.reasoningEffort || '').trim().slice(0, 20);
  const prompt = String(value.prompt || 'hi').trim().slice(0, 1000) || 'hi';
  const accountStates = value.accountStates && typeof value.accountStates === 'object' && !Array.isArray(value.accountStates)
    ? value.accountStates
    : {};
  return {
    enabled: value.enabled === true,
    mode: MODES.has(value.mode) ? value.mode : 'manual',
    dailyTime,
    model,
    reasoningEffort,
    prompt,
    accountStates,
  };
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function primaryQuotaWindow(quota) {
  const windows = [...(quota?.windows || [])]
    .filter((window) => Number.isFinite(Number(window.windowDurationMins)));
  return windows.find((window) => Number(window.windowDurationMins) === 300)
    || windows.sort((left, right) => Number(left.windowDurationMins) - Number(right.windowDurationMins))[0]
    || null;
}

function quotaObservation(quota, observedAt = new Date()) {
  const window = primaryQuotaWindow(quota);
  if (!window) return null;
  const resetsAt = Number(window.resetsAt);
  const remainingPercent = Number(window.remainingPercent);
  return {
    windowDurationMins: Number(window.windowDurationMins),
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
    remainingPercent: Number.isFinite(remainingPercent) ? remainingPercent : null,
    observedAt: observedAt.toISOString(),
  };
}

function isQuotaWindowActive(first, second, now = new Date()) {
  if (!first || !second) return false;
  if (Number(first.windowDurationMins) !== 300 || Number(second.windowDurationMins) !== 300) return false;
  const remaining = Number(second.remainingPercent);
  if (Number.isFinite(remaining) && remaining < 99.9) return true;
  const firstReset = Number(first.resetsAt);
  const secondReset = Number(second.resetsAt);
  if (!Number.isFinite(firstReset) || !Number.isFinite(secondReset) || firstReset <= 0 || secondReset <= 0) return false;
  if (secondReset * 1000 <= now.getTime()) return false;
  return Math.abs(secondReset - firstReset) <= 2;
}

function detectQuotaReset(previous, current, now = new Date()) {
  if (!previous || !current) return null;
  const previousDuration = Number(previous.windowDurationMins);
  const currentDuration = Number(current.windowDurationMins);
  if (Number.isFinite(previousDuration) && Number.isFinite(currentDuration) && previousDuration !== currentDuration) {
    return null;
  }
  const previousReset = Number(previous.resetsAt) || 0;
  const currentReset = Number(current.resetsAt) || 0;
  const previousRemaining = Number(previous.remainingPercent);
  const currentRemaining = Number(current.remainingPercent);
  if (previousReset && now.getTime() >= previousReset * 1000) {
    return { key: `scheduled:${previousReset}`, reason: 'scheduled-time-reached', detectedAt: now.toISOString() };
  }
  const restoredToFull = Number.isFinite(previousRemaining) && Number.isFinite(currentRemaining)
    && currentRemaining >= 99 && currentRemaining > previousRemaining;
  const largeIncrease = Number.isFinite(previousRemaining) && Number.isFinite(currentRemaining)
    && currentRemaining - previousRemaining >= 10;
  if (restoredToFull || largeIncrease) {
    return { key: `restored:${previousReset}:${currentReset}:${Math.round(previousRemaining)}:${Math.round(currentRemaining)}`, reason: 'quota-restored', detectedAt: now.toISOString() };
  }
  return null;
}

function shouldWakeAccount(settings, account, now = new Date()) {
  if (!settings.enabled || settings.mode === 'manual') return false;
  const state = settings.accountStates?.[account.id] || {};
  if (settings.mode === 'daily') {
    const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return nowTime >= settings.dailyTime && state.lastDailyDate !== localDateKey(now);
  }
  return Boolean(state.pendingResetEvent?.key
    && state.pendingResetEvent.key !== state.lastHandledResetEventKey);
}

module.exports = { detectQuotaReset, isQuotaWindowActive, localDateKey, normalizeWakeSettings, primaryQuotaWindow, quotaObservation, shouldWakeAccount };

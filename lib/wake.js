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
  return [...(quota?.windows || [])]
    .filter((window) => Number.isFinite(Number(window.windowDurationMins)))
    .sort((left, right) => Number(right.windowDurationMins) - Number(left.windowDurationMins))[0] || null;
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

function detectQuotaReset(previous, current, now = new Date()) {
  if (!previous || !current) return null;
  const previousReset = Number(previous.resetsAt) || 0;
  const currentReset = Number(current.resetsAt) || 0;
  const previousRemaining = Number(previous.remainingPercent);
  const currentRemaining = Number(current.remainingPercent);
  if (currentReset > previousReset) {
    return { key: `cycle:${previousReset}:${currentReset}`, reason: 'reset-time-advanced', detectedAt: now.toISOString() };
  }
  const restoredToFull = Number.isFinite(previousRemaining) && Number.isFinite(currentRemaining)
    && currentRemaining >= 99 && currentRemaining > previousRemaining;
  const largeIncrease = Number.isFinite(previousRemaining) && Number.isFinite(currentRemaining)
    && currentRemaining - previousRemaining >= 10;
  if (restoredToFull || largeIncrease) {
    return { key: `restored:${currentReset}:${Math.round(previousRemaining)}:${Math.round(currentRemaining)}`, reason: 'quota-restored', detectedAt: now.toISOString() };
  }
  if (previousReset && now.getTime() >= previousReset * 1000) {
    return { key: `scheduled:${previousReset}`, reason: 'scheduled-time-reached', detectedAt: now.toISOString() };
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

module.exports = { detectQuotaReset, localDateKey, normalizeWakeSettings, primaryQuotaWindow, quotaObservation, shouldWakeAccount };

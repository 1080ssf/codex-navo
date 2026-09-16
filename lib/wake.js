const MODES = new Set(['manual', 'daily', 'after-reset']);
const MAX_DAILY_ATTEMPTS = 3;
const WAKE_RETRY_MS = 5 * 60_000;
const MAX_VERIFICATION_ATTEMPTS = 3;

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
    remainingPercent: window.remainingPercent != null && Number.isFinite(remainingPercent) ? remainingPercent : null,
    observedAt: observedAt.toISOString(),
  };
}

function isQuotaWindowActive(first, second, now = new Date()) {
  if (!first || !second) return false;
  if (Number(first.windowDurationMins) !== 300 || Number(second.windowDurationMins) !== 300) return false;
  const remaining = Number(second.remainingPercent);
  if (second.remainingPercent != null && Number.isFinite(remaining) && remaining < 99.9) return true;
  const firstReset = Number(first.resetsAt);
  const secondReset = Number(second.resetsAt);
  if (!Number.isFinite(firstReset) || !Number.isFinite(secondReset) || firstReset <= 0 || secondReset <= 0) return false;
  if (secondReset * 1000 <= now.getTime()) return false;
  const elapsed = Date.parse(second.observedAt) - Date.parse(first.observedAt);
  return Number.isFinite(elapsed) && elapsed >= 10_000 && Math.abs(secondReset - firstReset) <= 2;
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
    const today = localDateKey(now);
    if (nowTime < settings.dailyTime || state.lastDailyDate === today) return false;
    if (state.lastDailyAttemptDate !== today) return true;
    return state.dailyRetryAllowed === true
      && state.dailyAttemptCount < MAX_DAILY_ATTEMPTS
      && Date.parse(state.dailyRetryAt || '') <= now.getTime();
  }
  return Boolean(state.pendingResetEvent?.key
    && state.pendingResetEvent.key !== state.lastHandledResetEventKey);
}

function classifyWakeFailure(error, submission = 'not-submitted') {
  const message = `${error?.code || ''} ${error?.message || ''} ${error?.wakeOutput || ''}`;
  const authExpired = /\b401\b|unauthorized|token_revoked|invalidated oauth|refresh_token_reused|登录已失效|尚未完成.*授权/i.test(message);
  const transient = /ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|\b(?:429|502|503|504)\b|timed?\s*out|timeout|connection refused|network.*(?:failed|unavailable)|暂时|超时|(?:网络|节点|代理).*(?:失败|不可用)/i.test(message);
  return { submission, authExpired, retryable: submission === 'not-submitted' && !authExpired && transient };
}

function wakeAttemptState(previous, trigger, status, { error = '', evidence = null, retryable = false, now = new Date() } = {}) {
  const submitted = evidence?.submission === 'unknown' || evidence?.submission === 'completed';
  // Quota consumption alone is never evidence that our own request completed.
  if (status === 'success' && !(evidence?.verified === true && evidence?.quotaWindowActive === true)) {
    status = submitted ? 'pending' : 'failed';
  }
  const next = {
    ...previous,
    lastWakeAt: now.toISOString(),
    lastWakeStatus: status,
    lastWakeError: String(error || '').slice(0, 500),
    lastWakeEvidence: evidence,
  };
  if (status === 'running') next.pendingWakeVerification = null;
  if (trigger === 'daily') {
    const today = localDateKey(now);
    if (status === 'running') {
      next.lastDailyAttemptDate = today;
      next.dailyAttemptCount = previous.lastDailyAttemptDate === today ? (Number(previous.dailyAttemptCount) || 0) + 1 : 1;
    }
    next.dailyRetryAllowed = !submitted && (status === 'running' || (status === 'failed' && retryable))
      && (Number(next.dailyAttemptCount) || 1) < MAX_DAILY_ATTEMPTS;
    next.dailyRetryAt = next.dailyRetryAllowed
      ? new Date(now.getTime() + WAKE_RETRY_MS * (2 ** Math.max(0, (Number(next.dailyAttemptCount) || 1) - 1))).toISOString() : '';
    const attemptDate = next.lastDailyAttemptDate || today;
    if (submitted || status === 'success') next.lastDailyDate = attemptDate;
    else if (status === 'failed' && previous.lastDailyDate === attemptDate) next.lastDailyDate = '';
  }
  if (status === 'pending' && submitted) {
    next.pendingWakeVerification = {
      trigger,
      submittedAt: previous.pendingWakeVerification?.submittedAt || now.toISOString(),
      commandVerified: evidence?.verified === true,
      resetEvent: previous.pendingWakeVerification?.resetEvent || previous.pendingResetEvent || null,
      lastCheckedAt: '',
      checkCount: 0,
    };
  } else if (status === 'success' || status === 'failed') next.pendingWakeVerification = null;
  if (trigger === 'after-reset') {
    if (submitted || status === 'success') {
      next.lastHandledResetEventKey = previous.pendingResetEvent?.key || previous.lastHandledResetEventKey || '';
      next.pendingResetEvent = null;
      next.lastResetAttemptAt = '';
    } else {
      next.lastResetAttemptAt = next.lastWakeAt;
      if (status === 'failed' && previous.pendingWakeVerification?.resetEvent) {
        next.pendingResetEvent = previous.pendingWakeVerification.resetEvent;
        next.lastHandledResetEventKey = '';
      }
    }
  }
  return next;
}

function shouldVerifyWakeAccount(state, now = new Date()) {
  const pending = state.pendingWakeVerification;
  if (!pending || (Number(pending.checkCount) || 0) >= MAX_VERIFICATION_ATTEMPTS) return false;
  const lastCheck = Date.parse(pending.lastCheckedAt || pending.submittedAt || '') || 0;
  return now.getTime() - lastCheck >= WAKE_RETRY_MS;
}

function wakeVerificationState(previous, { active = false, error = '', first = null, second = null, now = new Date() } = {}) {
  const pending = previous.pendingWakeVerification;
  if (!pending) return previous;
  const success = active && pending.commandVerified === true && previous.lastWakeEvidence?.verified === true;
  return {
    ...previous,
    lastWakeStatus: success ? 'success' : 'pending',
    lastWakeError: String(error || previous.lastWakeError || '').slice(0, 500),
    lastWakeEvidence: {
      ...previous.lastWakeEvidence,
      quotaWindowActive: active,
      quotaRefreshed: !error,
      quotaRefreshError: String(error || '').slice(0, 500),
      quotaObservations: { ...previous.lastWakeEvidence?.quotaObservations, first, second },
    },
    pendingWakeVerification: success ? null : {
      ...pending, lastCheckedAt: now.toISOString(), checkCount: (Number(pending.checkCount) || 0) + 1,
    },
  };
}

module.exports = {
  classifyWakeFailure, detectQuotaReset, isQuotaWindowActive, localDateKey, normalizeWakeSettings,
  primaryQuotaWindow, quotaObservation, shouldVerifyWakeAccount, shouldWakeAccount,
  wakeAttemptState, wakeVerificationState,
};

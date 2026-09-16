const ACTIVE_INTERVAL_MS = 60_000;
const IDLE_INTERVAL_MS = 5 * 60_000;
const MAX_RETRY_MS = 30 * 60_000;
const quotaRevisions = new WeakMap();

// Every successful reader (manual, floating, wake, health or background) uses
// this commit point. An older background request must not undo that success.
function applyQuotaSnapshot(account, quota, now = Date.now()) {
  quotaRevisions.set(account, (quotaRevisions.get(account) || 0) + 1);
  account.quota = quota;
  account.quotaCheckedAt = quota.refreshedAt || new Date(now).toISOString();
  account.quotaRefreshSucceededAt = account.quotaCheckedAt;
  account.quotaRefreshFailureCount = 0;
  account.quotaRefreshRetryAt = '';
  account.quotaError = '';
  account.quotaErrorCode = '';
}

// Ownership starts before network/CLI preparation, not when a reply arrives.
// All readers share this generation so late successes AND failures are ignored.
function beginQuotaRead(account) {
  let revision = (quotaRevisions.get(account) || 0) + 1;
  quotaRevisions.set(account, revision);
  const isCurrent = () => quotaRevisions.get(account) === revision;
  const checkpoint = () => {
    if (!isCurrent()) {
      const error = new Error('额度刷新已由更新的请求接管');
      error.code = 'QUOTA_REFRESH_SUPERSEDED';
      throw error;
    }
  };
  return {
    isCurrent, checkpoint,
    apply(quota, now) {
      checkpoint();
      applyQuotaSnapshot(account, quota, now);
      revision = quotaRevisions.get(account);
    },
  };
}

function quotaRefreshDue(account, active, now = Date.now()) {
  const retryAt = Date.parse(account.quotaRefreshRetryAt || '') || 0;
  if (retryAt > now) return false;
  const lastSuccess = Math.max(
    Date.parse(account.quota?.refreshedAt || '') || 0,
    Date.parse(account.quotaRefreshSucceededAt || '') || 0,
  );
  const lastAttempt = Date.parse(account.quotaRefreshAttemptedAt || '') || 0;
  const latest = Math.max(lastSuccess, lastAttempt);
  return !latest || latest <= now - (active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
}

async function refreshAccountQuota(account, {
  loadQuota, persist, audit = () => {}, active = false,
  timeoutMs = 45_000, now = Date.now,
}) {
  let expired = false;
  let stage = '准备网络';
  let timer;
  const read = beginQuotaRead(account);
  const superseded = () => !read.isCurrent();
  const context = {
    checkpoint(nextStage) {
      if (expired) throw new Error('额度刷新任务已超时');
      if (superseded()) throw new Error('额度已由其他刷新更新');
      if (nextStage) stage = nextStage;
    },
  };
  account.quotaRefreshAttemptedAt = new Date(now()).toISOString();
  persist();
  try {
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('额度刷新超时，请检查网络后重试'));
      }, timeoutMs);
    });
    const quota = await Promise.race([Promise.resolve().then(() => loadQuota(context)), deadline]);
    context.checkpoint();
    read.apply(quota, now());
    audit('success');
  } catch (error) {
    if (superseded()) return;
    const detail = String(error?.message || error).slice(0, 300);
    const authExpired = /401|unauthorized|token_revoked|invalidated oauth|refresh_token_reused/i.test(detail);
    account.quotaRefreshFailureCount = Math.min(10, (Number(account.quotaRefreshFailureCount) || 0) + 1);
    const retryMs = Math.min(MAX_RETRY_MS, (active ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS)
      * (2 ** (account.quotaRefreshFailureCount - 1)));
    account.quotaRefreshRetryAt = new Date(now() + retryMs).toISOString();
    account.quotaErrorCode = authExpired ? 'auth_expired' : 'fetch_failed';
    account.quotaError = authExpired ? '登录已失效，请重新授权' : `${stage}失败：${detail}`;
    audit(account.quotaError);
  } finally {
    clearTimeout(timer);
    persist();
  }
}

// A scan does not await a whole batch. Each account owns its slot and deadline,
// so a slow account cannot keep completed accounts behind a shared batch lock.
class QuotaRefreshScheduler {
  constructor({ refresh, concurrency = 3, onError = () => {} }) {
    this.refresh = refresh;
    this.concurrency = concurrency;
    this.onError = onError;
    this.running = new Map();
  }

  scan(entries) {
    const started = [];
    for (const entry of entries) {
      if (this.running.size >= this.concurrency) break;
      if (this.running.has(entry.account.id)) continue;
      const promise = Promise.resolve().then(() => this.refresh(entry))
        .catch((error) => this.onError(error, entry.account))
        .finally(() => this.running.delete(entry.account.id));
      this.running.set(entry.account.id, promise);
      started.push(promise);
    }
    return started;
  }
}

module.exports = { QuotaRefreshScheduler, quotaRefreshDue, refreshAccountQuota, applyQuotaSnapshot, beginQuotaRead };

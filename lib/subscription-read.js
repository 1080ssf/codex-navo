// Keep this function self-contained: it is also evaluated inside the account's
// own ChatGPT page. Only subscription fields and classified failures leave it.
async function readSubscriptionInPage({ accountId, accessToken = '' }, fetchImpl = globalThis.fetch) {
  const fail = (code, stage, status = 0) => ({ ok: false, code, stage, status });
  async function request(url, stage, headers = {}) {
    try {
      const response = await fetchImpl(url, { credentials: 'include', cache: 'no-store', headers, signal: AbortSignal.timeout(8_000) });
      const text = await response.text();
      if (response.headers.get('cf-mitigated') === 'challenge'
          || /text\/html/i.test(response.headers.get('content-type') || '') && /challenge-platform|Just a moment|cf-chl-/i.test(text)) {
        return fail('verification_required', stage, response.status);
      }
      if (!response.ok) return fail(response.status === 401 ? 'session_required'
        : response.status === 403 ? 'permission_denied'
          : response.status === 429 ? 'rate_limited' : 'http_error', stage, response.status);
      try { return { ok: true, payload: JSON.parse(text) }; }
      catch { return fail('invalid_response', stage, response.status); }
    } catch { return fail('network_error', stage); }
  }
  if (!accountId) return fail('account_not_found', 'identity');
  const session = await request('/api/auth/session', 'web_session');
  if (!session.ok) return session;
  // A Codex OAuth token is not interchangeable with the signed-in website's
  // token. Prefer the website session, keeping the expected workspace ID fixed.
  const token = session.payload?.accessToken || accessToken;
  if (!token) return fail('session_required', 'web_session', 401);
  const result = await request('/backend-api/accounts/check/v4-2023-04-27', 'subscription', {
    Authorization: `Bearer ${token}`, 'ChatGPT-Account-Id': accountId,
  });
  if (!result.ok) return result;
  const record = result.payload?.accounts?.[accountId];
  // Never take the personal/default workspace's plan or billing dates.
  if (!record) return fail('account_not_found', 'subscription', 200);
  const entitlement = record.entitlement;
  return { ok: true, planType: record.account?.plan_type || null,
    active: entitlement?.has_active_subscription === true,
    expiresAt: entitlement?.expires_at || null, renewsAt: entitlement?.renews_at || null,
    billingPeriod: entitlement?.billing_period || null };
}

function subscriptionReadError(value) {
  const labels = {
    verification_required: '网页验证未完成，请打开该账号网页端完成验证后刷新',
    session_required: '该账号的网页登录态不可用，请打开网页端登录后刷新',
    permission_denied: '订阅接口拒绝当前凭证访问',
    account_not_found: '订阅响应未包含当前工作空间，未读取其他账号的日期',
    rate_limited: '订阅查询请求过于频繁，请稍后重试',
    invalid_response: '订阅接口未返回有效数据',
    network_error: '订阅读取网络连接失败或超时',
  };
  const error = new Error(labels[value?.code] || `自动读取套餐到期时间失败（HTTP ${Number(value?.status) || '未知'}）`);
  error.code = value?.code || 'http_error';
  error.stage = value?.stage || 'subscription';
  error.status = Number(value?.status) || 0;
  return error;
}

module.exports = { readSubscriptionInPage, subscriptionReadError };

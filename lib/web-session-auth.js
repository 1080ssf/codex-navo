function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function buildCodexAuthFromWebSession(session, now = new Date()) {
  const accessToken = String(session?.accessToken || '').trim();
  if (accessToken.length < 20) throw new Error('网页会话没有返回可用的访问凭证');
  const accessClaims = decodeJwtPayload(accessToken);
  const accessAuth = accessClaims?.['https://api.openai.com/auth'] || {};
  const accountId = String(session?.account?.id || accessAuth.chatgpt_account_id || '').trim();
  if (!accountId) throw new Error('网页会话没有返回 Codex 账号 ID');
  const email = String(session?.user?.email || accessClaims.email || '').trim();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = Number(accessClaims.exp) || Math.floor(Date.parse(session?.expires || '') / 1000) || issuedAt + 3600;
  if (expiresAt <= issuedAt) throw new Error('网页会话访问凭证已经过期');
  const idToken = [
    encodeJwtPart({ alg: 'none', typ: 'JWT', cpa_synthetic: true }),
    encodeJwtPart({
      iat: issuedAt,
      exp: expiresAt,
      email,
      'https://api.openai.com/auth': {
        ...accessAuth,
        chatgpt_account_id: accountId,
        chatgpt_plan_type: session?.account?.planType || accessAuth.chatgpt_plan_type || 'free',
        chatgpt_user_id: session?.user?.id || accessAuth.chatgpt_user_id || '',
      },
    }),
    'synthetic',
  ].join('.');
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    last_refresh: now.toISOString(),
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      // This mirrors codex-auth-helper: a ChatGPT web session is temporary and
      // does not expose a real Codex OAuth refresh token. Navo renews it from
      // the account's isolated Chrome session instead of treating it as OAuth.
      refresh_token: String(session?.sessionToken || '').trim() || 'placeholder',
      account_id: accountId,
    },
  };
}

module.exports = { buildCodexAuthFromWebSession, decodeJwtPayload };

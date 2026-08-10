const crypto = require('node:crypto');

const PACKAGE_TYPE = 'codex-navo-auth-package';
const PACKAGE_VERSION = 2;

function decodeJwtHeader(token) {
  try {
    const segment = String(token || '').split('.')[0];
    return segment ? JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

function isNonRefreshableWebSessionAuth(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return false;
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : auth;
  const accessToken = String(tokens.access_token || '');
  const refreshToken = String(tokens.refresh_token || '');
  const idHeader = decodeJwtHeader(tokens.id_token);
  return Boolean(
    accessToken && refreshToken && accessToken === refreshToken
    || refreshToken === 'placeholder'
    || idHeader.cpa_synthetic === true
    || String(tokens.id_token || '').endsWith('.synthetic'),
  );
}

function validateAuthPayload(auth, options = {}) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('Codex 授权数据格式无效');
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : auth;
  const hasAccess = typeof tokens.access_token === 'string' && tokens.access_token.length > 20;
  const hasRefresh = typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 20;
  const hasApiKey = typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.length > 20;
  const temporary = isNonRefreshableWebSessionAuth(auth);
  if (options.allowTemporary === true && hasAccess && temporary) return auth;
  if (!hasApiKey && (!hasAccess || !hasRefresh)) throw new Error('授权包中没有可用的 Codex 登录凭证');
  if (!hasApiKey && temporary) {
    throw new Error('Codex 授权缺少可刷新的 OAuth refresh token，请继续完成官方 Codex 授权');
  }
  return auth;
}

function decodeJwtPayload(token) {
  try {
    const segment = String(token || '').split('.')[1];
    if (!segment) return {};
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

function authAccessExpiry(auth) {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : auth;
  const claims = decodeJwtPayload(tokens.access_token);
  const expiresAtMs = Number(claims.exp) * 1000;
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return null;
  return new Date(expiresAtMs).toISOString();
}

function authIdentity(auth) {
  validateAuthPayload(auth, { allowTemporary: true });
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : auth;
  const claims = decodeJwtPayload(tokens.id_token || tokens.access_token);
  const accountId = tokens.account_id || auth.account_id || claims.chatgpt_account_id || claims.account_id || '';
  const subject = claims.sub || '';
  const email = claims.email || claims['https://api.openai.com/profile']?.email || '';
  const stable = String(accountId || subject || email || auth.OPENAI_API_KEY || '').trim();
  return stable ? crypto.createHash('sha256').update(stable).digest('hex') : '';
}

function packageChecksum(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validateWebSessionPayload(session) {
  if (session == null) return null;
  if (!session || typeof session !== 'object' || Array.isArray(session) || !Array.isArray(session.cookies)) {
    throw new Error('网页会话数据格式无效');
  }
  if (!session.cookies.length || session.cookies.length > 200) throw new Error('网页会话 Cookie 数量无效');
  for (const cookie of session.cookies) {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) throw new Error('网页会话 Cookie 格式无效');
    const name = String(cookie.name || '');
    const value = String(cookie.value || '');
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    const supportedDomain = domain === 'chatgpt.com' || domain.endsWith('.chatgpt.com')
      || domain === 'openai.com' || domain.endsWith('.openai.com');
    if (!name || name.length > 256 || !value || value.length > 16_384 || !supportedDomain) {
      throw new Error('网页会话 Cookie 内容无效');
    }
  }
  return session;
}

function createAuthPackage(payload) {
  validateAuthPayload(payload?.files?.['auth.json'], { allowTemporary: true });
  validateWebSessionPayload(payload?.files?.['web-session.json']);
  return {
    type: PACKAGE_TYPE,
    version: PACKAGE_VERSION,
    payload,
    integrity: { algorithm: 'sha256', checksum: packageChecksum(payload) },
  };
}

function readAuthPackage(value) {
  if (!value || value.type !== PACKAGE_TYPE || value.version !== PACKAGE_VERSION || !value.payload) {
    throw new Error('这不是受支持的 Codex Navo 授权包');
  }
  if (value.integrity?.algorithm !== 'sha256' || value.integrity.checksum !== packageChecksum(value.payload)) {
    throw new Error('授权包已损坏或内容不完整');
  }
  validateAuthPayload(value.payload.files?.['auth.json'], { allowTemporary: true });
  validateWebSessionPayload(value.payload.files?.['web-session.json']);
  return value.payload;
}

module.exports = {
  PACKAGE_TYPE,
  PACKAGE_VERSION,
  authAccessExpiry,
  authIdentity,
  createAuthPackage,
  isNonRefreshableWebSessionAuth,
  readAuthPackage,
  validateAuthPayload,
  validateWebSessionPayload,
};

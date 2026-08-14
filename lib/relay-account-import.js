const MAX_RELAY_ACCOUNTS = 100;

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function jwtClaims(token) {
  try {
    const segment = String(token || '').split('.')[1];
    return segment ? JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

function formatOf(value) {
  const item = object(value);
  if (Array.isArray(item.accounts) && item.accounts.some((entry) => object(entry).credentials)) return 'sub2api';
  if (item.auth_mode === 'chatgpt' && object(item.tokens).access_token) return item.axonhub_note ? 'axonhub' : 'codex-auth';
  if (object(item.tokens).access_token && object(item.meta).label) return 'codex-manager';
  if (object(item.tokens).access_token) return 'cockpit';
  if (item.accessToken && (item.provider === 'codex' || item.providerSpecificData)) return '9router';
  if (item.type === 'codex' && item.access_token) return item.account_note !== undefined ? 'cockpit' : 'cpa';
  if (item.access_token || item.accessToken) return 'raw';
  return '';
}

function expandRecords(value, inheritedFormat = '') {
  if (Array.isArray(value)) return value.flatMap((item) => expandRecords(item, inheritedFormat));
  const item = object(value);
  const format = formatOf(item) || inheritedFormat;
  if (Array.isArray(item.accounts) && item.accounts.length) {
    return item.accounts.flatMap((account) => expandRecords(account, format || 'sub2api'));
  }
  if (!format) {
    for (const key of ['data', 'items', 'profiles', 'credentials']) {
      if (Array.isArray(item[key])) return expandRecords(item[key], inheritedFormat);
    }
  }
  return format ? [{ item, format }] : [];
}

function normalizeRelayRecord(record, index) {
  const item = object(record.item);
  const credentials = object(item.credentials);
  const tokens = object(item.tokens);
  const extra = object(item.extra);
  const meta = object(item.meta);
  const provider = object(item.providerSpecificData);
  const accessToken = firstString(
    credentials.access_token, tokens.access_token, item.access_token, item.accessToken,
  );
  if (accessToken.length <= 20) throw new Error(`第 ${index + 1} 个账号缺少有效访问 Token`);
  const accessClaims = jwtClaims(accessToken);
  const idToken = firstString(credentials.id_token, tokens.id_token, item.id_token, item.idToken);
  const idClaims = jwtClaims(idToken);
  const accessAuth = object(accessClaims['https://api.openai.com/auth']);
  const idAuth = object(idClaims['https://api.openai.com/auth']);
  const accountId = firstString(
    credentials.chatgpt_account_id, credentials.account_id,
    tokens.chatgpt_account_id, tokens.account_id,
    item.chatgpt_account_id, item.account_id,
    extra.chatgpt_account_id, extra.account_id,
    provider.chatgptAccountId, item.id,
    accessAuth.chatgpt_account_id, idAuth.chatgpt_account_id,
    accessClaims.sid, idClaims.sid,
  );
  if (!accountId) throw new Error(`第 ${index + 1} 个账号缺少 ChatGPT Account ID`);
  const suppliedRefreshToken = firstString(
    credentials.refresh_token, tokens.refresh_token, item.refresh_token, item.refreshToken,
  );
  const temporary = suppliedRefreshToken.length <= 20
    || suppliedRefreshToken === '__missing_refresh_token__'
    || suppliedRefreshToken === 'placeholder';
  const refreshToken = temporary ? accessToken : suppliedRefreshToken;
  const profile = object(accessClaims['https://api.openai.com/profile']);
  const idProfile = object(idClaims['https://api.openai.com/profile']);
  const email = firstString(
    credentials.email, item.email, extra.email, profile.email, idProfile.email, accessClaims.email, idClaims.email,
  );
  const label = firstString(item.name, meta.label, email, `反代账号 ${index + 1}`).slice(0, 60);
  const clientId = firstString(credentials.client_id, tokens.client_id, item.client_id, extra.client_id);
  const auth = {
    auth_mode: 'chatgpt',
    last_refresh: new Date().toISOString(),
    tokens: {
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(idToken ? { id_token: idToken } : {}),
      account_id: accountId,
      ...(clientId ? { client_id: clientId } : {}),
    },
  };
  return {
    label,
    email,
    format: record.format,
    temporary,
    auth,
    expiresAt: Number(accessClaims.exp) > 0 ? new Date(Number(accessClaims.exp) * 1000).toISOString() : null,
  };
}

function parseRelayAccountPackage(value) {
  let payload = value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 2 * 1024 * 1024) throw new Error('第三方数据包不能超过 2 MB');
    try { payload = JSON.parse(value); }
    catch { throw new Error('第三方数据包不是有效 JSON'); }
  }
  const records = expandRecords(payload);
  if (!records.length) throw new Error('没有识别到受支持的反代账号格式');
  if (records.length > MAX_RELAY_ACCOUNTS) throw new Error(`单次最多导入 ${MAX_RELAY_ACCOUNTS} 个反代账号`);
  const normalized = records.map(normalizeRelayRecord);
  const identities = new Set();
  for (const account of normalized) {
    const identity = account.auth.tokens.account_id;
    if (identities.has(identity)) throw new Error(`数据包内存在重复账号：${account.label}`);
    identities.add(identity);
  }
  return normalized;
}

module.exports = { MAX_RELAY_ACCOUNTS, formatOf, parseRelayAccountPackage };

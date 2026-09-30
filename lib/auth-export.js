function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function tokenSet(auth) {
  const source = object(auth);
  return object(source.tokens && typeof source.tokens === 'object' ? source.tokens : source);
}

function exportCredentials(auth, account = {}) {
  const source = object(auth);
  const tokens = tokenSet(auth);
  const accessToken = String(tokens.access_token || '').trim();
  const refreshToken = String(tokens.refresh_token || '').trim();
  if (!accessToken || !refreshToken) throw new Error('授权数据缺少访问令牌，无法导出第三方格式');
  const result = {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...(tokens.id_token ? { id_token: tokens.id_token } : {}),
    ...(tokens.account_id || source.account_id ? { account_id: tokens.account_id || source.account_id } : {}),
    ...(tokens.client_id || source.client_id ? { client_id: tokens.client_id || source.client_id } : {}),
  };
  const email = String(account.emailHint || '').trim();
  if (email) result.email = email;
  return result;
}

function exportSub2Api(auth, account = {}) {
  return {
    type: 'sub2api-data',
    version: 1,
    accounts: [{
      name: String(account.label || 'Codex account').trim(),
      credentials: exportCredentials(auth, account),
    }],
  };
}

function exportSub2ApiBatch(entries = []) {
  return {
    type: 'sub2api-data',
    version: 1,
    accounts: entries.map(({ auth, account }) => ({
      name: String(account?.label || 'Codex account').trim(),
      credentials: exportCredentials(auth, account),
    })),
  };
}

function exportCliProxyApi(auth, account = {}) {
  return {
    type: 'codex',
    name: String(account.label || 'Codex account').trim(),
    account_note: String(account.emailHint || '').trim(),
    ...exportCredentials(auth, account),
  };
}

function exportCliProxyApiBatch(entries = []) {
  return entries.map(({ auth, account }) => exportCliProxyApi(auth, account));
}

function exportAccountCredentials(auth, account, format = 'codexnavo') {
  const normalized = String(format || 'codexnavo').trim().toLowerCase();
  if (normalized === 'sub2' || normalized === 'sub2api' || normalized === 'tosub2') return { format: 'sub2api', extension: 'json', package: exportSub2Api(auth, account) };
  if (normalized === 'cpa' || normalized === 'cliproxyapi') return { format: 'cpa', extension: 'json', package: exportCliProxyApi(auth, account) };
  if (normalized === 'codexnavo' || normalized === 'codex-navo') return { format: 'codexnavo', extension: 'codexnavo', package: null };
  throw new Error('不支持的授权导出格式');
}

module.exports = { exportAccountCredentials, exportCliProxyApi, exportSub2Api, exportSub2ApiBatch, exportCliProxyApiBatch, exportCredentials };

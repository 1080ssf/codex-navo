const { authIdentity, validateAuthPayload } = require('./auth-package');

function chatgptAuth(auth) {
  // An API-only auth file must never be accepted as a regular ChatGPT login.
  if (!auth?.tokens?.access_token || !auth.tokens.refresh_token) throw new Error('该普通账号缺少 ChatGPT 登录凭证，请重新授权；不能使用 API Key 代替');
  const output = { ...auth, auth_mode: 'chatgpt', OPENAI_API_KEY: null };
  validateAuthPayload(output);
  return output;
}

function canSaveChatgptAuth(previous, current) {
  try { const expected = authIdentity(chatgptAuth(previous)); return Boolean(expected) && expected === authIdentity(chatgptAuth(current)); }
  catch { return false; }
}

function chatgptEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_API_BASE|OPENAI_ORG_ID|OPENAI_ORGANIZATION|CODEX_API_KEY|CODEX_BASE_URL)$/i.test(key)));
}

function chatgptConfig(source) {
  const output = [];
  let section = '', skip = false;
  for (const line of String(source || '').split(/\r?\n/)) {
    const header = line.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      section = header[1].trim();
      skip = /^model_providers\.(?:codex_navo|openai)(?:\.|$)/.test(section);
    }
    if (skip) continue;
    if ((!section || /^profiles\./.test(section)) && /^\s*(?:model_provider|cli_auth_credentials_store|forced_login_method|forced_chatgpt_workspace_id)\s*=/.test(line)) continue;
    output.push(line);
  }
  return ['model_provider = "openai"', 'cli_auth_credentials_store = "file"', 'forced_login_method = "chatgpt"', ...output].join('\n');
}

module.exports = { chatgptAuth, canSaveChatgptAuth, chatgptEnvironment, chatgptConfig };

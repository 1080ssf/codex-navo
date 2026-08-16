const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProtocolRunner,
  injectProtocolCookies,
  navigateProtocolPage,
  normalizeChromeCookies,
  parseWindowsProxyServer,
  protocolPromptFromOutput,
  readProtocolOauthExport,
  readProtocolSession,
  resolveProtocolProxyEnvironment,
  validateProtocolInput,
  webSessionAuthenticated,
} = require('../lib/protocol-login');
const { buildCodexAuthFromWebSession } = require('../lib/web-session-auth');
const { isNonRefreshableWebSessionAuth, validateAuthPayload } = require('../lib/auth-package');

class MockChromeSocket {
  constructor() {
    this.listeners = new Map();
    this.methods = [];
    queueMicrotask(() => this.emit('open', {}));
  }
  addEventListener(name, listener, options = {}) {
    const wrapped = options.once ? (event) => { this.removeEventListener(name, wrapped); listener(event); } : listener;
    this.listeners.set(name, [...(this.listeners.get(name) || []), wrapped]);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((item) => item !== listener));
  }
  emit(name, event) { for (const listener of this.listeners.get(name) || []) listener(event); }
  send(raw) {
    const request = JSON.parse(raw);
    this.methods.push(request.method);
    if (request.method === 'Browser.close') return;
    const result = request.method === 'Network.setCookies'
      ? { success: true }
      : request.method === 'Runtime.evaluate'
        ? { result: { value: { ok: false, status: 403, text: 'blocked' } } }
        : {};
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: request.id, result }) }));
  }
  close() {}
}

test('协议登录输出可转换为 Codex auth.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-protocol-'));
  const file = path.join(dir, 'oauth.json');
  fs.writeFileSync(file, JSON.stringify({ type: 'sub2api-data', accounts: [{ credentials: {
    access_token: 'access-token', refresh_token: 'refresh-token', id_token: 'id-token',
    chatgpt_account_id: 'account-id', email: 'tester@example.com',
  } }] }));
  const result = readProtocolOauthExport(file);
  assert.equal(result.email, 'tester@example.com');
  assert.equal(result.auth.auth_mode, 'chatgpt');
  assert.equal(result.auth.tokens.account_id, 'account-id');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('协议 OAuth 使用官方 Codex scopes 并以 JWT 内账号 ID 为准', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-protocol-scopes-'));
  const file = path.join(dir, 'oauth.json');
  const jwt = (payload) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const claims = { 'https://api.openai.com/auth': { chatgpt_account_id: 'jwt-account-id' } };
  fs.writeFileSync(file, JSON.stringify({ type: 'sub2api-data', accounts: [{ credentials: {
    access_token: jwt(claims), refresh_token: 'refresh-token', id_token: jwt(claims),
    chatgpt_account_id: 'stale-export-account-id', email: 'tester@example.com',
  } }] }));
  const result = readProtocolOauthExport(file);
  assert.equal(result.auth.tokens.account_id, 'jwt-account-id');
  assert.match(result.auth.last_refresh, /^\d{4}-\d{2}-\d{2}T/);
  const source = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'tosub2', 'protocol-login.mjs'), 'utf8');
  assert.match(source, /openid profile email offline_access api\.connectors\.read api\.connectors\.invoke/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('协议登录运行器不写入密码或验证码配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-protocol-runner-'));
  const runnerFile = path.join(dir, 'run.ps1');
  createProtocolRunner({ runnerFile, executable: 'node.exe', scriptFile: 'protocol-login.mjs',
    email: 'tester@example.com', outputFile: path.join(dir, 'oauth.json'),
    checkpointFile: path.join(dir, 'checkpoint.json'), statusFile: path.join(dir, 'status.json'), packaged: false });
  const source = fs.readFileSync(runnerFile, 'utf8');
  assert.match(source, /--output-mode sub2api/);
  assert.match(source, /NODE_USE_ENV_PROXY/);
  assert.doesNotMatch(source, /CHATGPT_LOGIN_PASSWORD|CHATGPT_TOTP_SECRET/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('隐藏协议登录能够识别人工验证步骤且不持久化输入', () => {
  assert.equal(protocolPromptFromOutput('[3/5] Email OTP page reached.\nEmail OTP (r=resend, q=quit): ').kind, 'email_otp');
  assert.equal(protocolPromptFromOutput('Password (q=quit): ').kind, 'password');
  assert.equal(protocolPromptFromOutput('2FA OTP (6 digits, q=quit): ').kind, 'totp');
  assert.equal(protocolPromptFromOutput('Phone number, E.164 format (p=quit): ').kind, 'phone');
  assert.equal(protocolPromptFromOutput('Phone OTP (r=resend, p=change phone, q=quit): ').kind, 'phone_otp');
  assert.equal(validateProtocolInput('email_otp', '123456'), '123456');
  assert.equal(validateProtocolInput('totp', '654321'), '654321');
  assert.equal(validateProtocolInput('phone', '+8613800000000'), '+8613800000000');
  assert.equal(validateProtocolInput('phone_otp', '246810'), '246810');
  assert.throws(() => validateProtocolInput('email_otp', '12345'));
});

test('协议登录继承环境代理，并在缺失时读取 Windows 系统代理', () => {
  assert.deepEqual(parseWindowsProxyServer('127.0.0.1:7897'), {
    HTTP_PROXY: 'http://127.0.0.1:7897',
    HTTPS_PROXY: 'http://127.0.0.1:7897',
  });
  assert.deepEqual(parseWindowsProxyServer('http=127.0.0.1:7897;https=127.0.0.1:7898'), {
    HTTP_PROXY: 'http://127.0.0.1:7897',
    HTTPS_PROXY: 'http://127.0.0.1:7898',
  });
  const discovered = resolveProtocolProxyEnvironment({}, { HTTP_PROXY: 'http://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897' });
  assert.equal(discovered.NODE_USE_ENV_PROXY, '1');
  assert.equal(discovered.HTTPS_PROXY, 'http://127.0.0.1:7897');
  assert.equal(discovered.https_proxy, 'http://127.0.0.1:7897');
  const inherited = resolveProtocolProxyEnvironment({ HTTPS_PROXY: 'http://127.0.0.1:9000' }, { HTTPS_PROXY: 'http://127.0.0.1:7897' });
  assert.equal(inherited.HTTPS_PROXY, 'http://127.0.0.1:9000');
});

test('协议网页会话转换为仅供本机 Chrome 写入的 Cookie', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-protocol-session-'));
  const file = path.join(dir, 'session.json');
  fs.writeFileSync(file, JSON.stringify({ cookies: [{
    name: '__Secure-next-auth.session-token', value: 'session-value', domain: '.chatgpt.com',
    path: '/', secure: true, httpOnly: true, sameSite: 'lax', expires: 2_000_000_000_000,
  }] }));
  const session = readProtocolSession(file);
  const [cookie] = normalizeChromeCookies(session.cookies);
  assert.equal(cookie.domain, 'chatgpt.com');
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.expires, 2_000_000_000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('服务端不再暴露协议登录或协议输入入口', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source, /authorize-protocol/);
  assert.doesNotMatch(source, /operation === 'protocol-input'/);
});

test('账号创建只允许官方浏览器登录或授权包导入', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /const loginMethod = 'official'/);
  assert.match(source, /startCodexBrowserLogin\(account, operator\)/);
  assert.doesNotMatch(source, /body\.loginMethod === 'protocol'/);
});

test('Headless Chrome 写入 Cookie 后重试会话校验，并允许 403 延后到可见浏览器验证', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'protocol-login.js'), 'utf8');
  assert.match(source, /verificationAttempts = 3/);
  assert.match(source, /attempt <= attempts/);
  assert.match(source, /allowHeadlessBlocked/);
  assert.match(source, /Number\(value\.status\) === 403/);
  assert.match(source, /method: 'Browser\.close'/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /allowHeadlessBlocked: true, closeBrowser: true/);
});

test('Headless 403 延后验证路径真实执行三次重试并主动关闭浏览器', async () => {
  let socket;
  class WebSocketImpl extends MockChromeSocket { constructor() { super(); socket = this; } }
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://mock' }],
  });
  const result = await injectProtocolCookies({
    port: 12345,
    cookies: [{ name: 'session', value: 'value', domain: '.chatgpt.com', path: '/' }],
    fetchImpl,
    WebSocketImpl,
    allowHeadlessBlocked: true,
    closeBrowser: true,
    verificationDelayMs: 1,
  });
  assert.deepEqual(result, { verified: false, deferred: true, status: 403, session: null });
  assert.equal(socket.methods.filter((method) => method === 'Runtime.evaluate').length, 3);
  assert.ok(socket.methods.includes('Browser.close'));
});

test('官方 OAuth 完成后可以保留 Chrome 并等待 ChatGPT 网页会话建立', async () => {
  let socket;
  class WebSocketImpl extends MockChromeSocket { constructor() { super(); socket = this; } }
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ type: 'page', url: 'https://chatgpt.com/auth/login', webSocketDebuggerUrl: 'ws://mock' }],
  });
  const result = await injectProtocolCookies({
    port: 12345,
    cookies: [],
    fetchImpl,
    WebSocketImpl,
    allowUnauthenticated: true,
    navigationUrl: 'https://chatgpt.com/auth/login?next=/',
    verificationDelayMs: 1,
  });
  assert.equal(result.verified, false);
  assert.equal(result.deferred, false);
  assert.ok(socket.methods.includes('Page.navigate'));
  assert.equal(socket.methods.includes('Browser.close'), false);
});

test('网页会话校验要求真实用户，不能把 user null 或字段名误判为已登录', () => {
  assert.equal(webSessionAuthenticated('{"user":null,"expires":"2026-08-17"}'), false);
  assert.equal(webSessionAuthenticated('{"accessToken":""}'), false);
  assert.equal(webSessionAuthenticated('<html>"user": fake</html>'), false);
  assert.equal(webSessionAuthenticated('{"user":{"email":"fixture@example.invalid"}}'), true);
  assert.equal(webSessionAuthenticated('{"accessToken":"session-token"}'), true);
});

test('一次登录流程会在同一账号 Chrome 中从 ChatGPT 跳转到官方 Codex OAuth', async () => {
  let socket;
  class WebSocketImpl extends MockChromeSocket { constructor() { super(); socket = this; } }
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://mock' }],
  });
  await navigateProtocolPage({
    port: 12345,
    url: 'https://auth.openai.com/oauth/authorize?client_id=fixture',
    fetchImpl,
    WebSocketImpl,
  });
  assert.ok(socket.methods.includes('Page.navigate'));
  await assert.rejects(() => navigateProtocolPage({
    port: 12345,
    url: 'https://example.invalid/',
    fetchImpl,
    WebSocketImpl,
  }), /非官方登录地址/);
});

test('web session builds an identifiable temporary auth.json', () => {
  const jwt = (payload) => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  const accessToken = jwt({
    exp: 2_000_000_000,
    email: 'fixture@example.invalid',
    'https://api.openai.com/auth': { chatgpt_account_id: 'account-from-jwt', chatgpt_plan_type: 'plus' },
  });
  const now = new Date('2026-08-10T00:00:00.000Z');
  const auth = buildCodexAuthFromWebSession({
    accessToken,
    account: { id: 'account-from-session', planType: 'pro' },
    user: { id: 'user-fixture', email: 'fixture@example.invalid' },
  }, now);
  assert.equal(auth.tokens.refresh_token, 'placeholder');
  assert.equal(isNonRefreshableWebSessionAuth(auth), true);
  assert.equal(validateAuthPayload(auth, { allowTemporary: true }), auth);
  assert.throws(() => validateAuthPayload(auth), /OAuth refresh token|Codex/);
});

test('phone binding stays in the official OAuth prompt flow and only real OAuth is pooled', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(source, /if \(prompt\.kind === 'phone'\) \{/);
  assert.doesNotMatch(source, /finalizeTemporaryWebSession|buildCodexAuthFromWebSession/);
  assert.match(source, /pending\.promptKind = prompt\.kind/);
  assert.match(source, /writeJsonAtomic\(path\.join\(codexHomeDir, 'auth\.json'\), validateAuthPayload\(oauth\.auth\)\)/);
  assert.match(source, /authSource = 'protocol-web-and-codex-oauth'/);
  assert.match(source, /setupStage = 'complete'/);
  assert.match(source, /result: 'web-and-codex-pooled'/);
});

test('Chrome closes gracefully so protocol cookies can reach disk', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'protocol-login.js'), 'utf8');
  assert.match(source, /function closeChromeAndWait\(socket, timeoutMs = 5_000\)/);
  assert.match(source, /socket\.addEventListener\('close', finish/);
  assert.match(source, /await closeChromeAndWait\(socket\)/);
});

test('协议登录异常不会带崩本地服务，重启后未完成状态会标记为中断', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /\['starting', 'waiting', 'finalizing', 'web-login'\]\.includes\(attempt\.status\)/);
  assert.doesNotMatch(source, /finalizeTemporaryWebSession/);
  assert.match(source, /const consumeSafely = \(chunk\) =>/);
  assert.match(source, /try \{ cleanupProtocolLoginFiles\(paths\); \} catch \{\}/);
});

test('temporary renewal path is removed in favor of official reauthorization', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /beginProtocolRenewal|runScheduledAuthRenewals|operation === 'renew'/);
  assert.match(server, /const temporary = isNonRefreshableWebSessionAuth\(auth\)/);
  assert.match(server, /if \(temporary && account\.accountKind === 'relay'\)/);
  assert.match(server, /return !temporary/);
  assert.match(server, /requires-official-oauth/);
  assert.match(server, /label: '需要官方授权'/);
});

test('协议登录入池后不自动打开窗口，手动网页端仍绑定账号独立目录', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /`--user-data-dir=\$\{browserDir\}`/);
  assert.match(server, /'--profile-directory=Default'/);
  assert.match(server, /'--remote-debugging-address=127\.0\.0\.1'/);
  assert.match(server, /async function waitForChromeDebugPort/);
  assert.match(server, /throw new Error\('独立 Chrome 环境启动后未绑定到对应账号目录'\)/);
  assert.doesNotMatch(server, /launchProtocolAccountWindow/);
  assert.match(server, /if \(launchType === 'browser'\) \{[\s\S]*const browserUrl = account\.webLoginComplete \? settings\.browserStartUrl : CHATGPT_LOGIN_URL;[\s\S]*launchAccountBrowser\(account, browserUrl/);
  assert.match(server, /watchAccountBrowserWebLogin\(account, browser\)/);
  assert.match(server, /const port = await resolveAccountBrowserDebugPort\(account, browser\)/);
  assert.match(server, /if \(!port\) \{[\s\S]*setTimeout\(check, 1_000\)/);
});

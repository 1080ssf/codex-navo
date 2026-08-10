const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createProtocolRunner,
  injectProtocolCookies,
  normalizeChromeCookies,
  parseWindowsProxyServer,
  protocolPromptFromOutput,
  readProtocolOauthExport,
  readProtocolSession,
  resolveProtocolProxyEnvironment,
  validateProtocolInput,
} = require('../lib/protocol-login');
const { buildCodexAuthFromWebSession } = require('../lib/web-session-auth');

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

test('服务端协议登录使用隐藏子进程连续完成网页会话与 Codex OAuth', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /stdio: \['pipe', 'pipe', 'pipe'\]/);
  assert.match(source, /windowsHide: true/);
  assert.match(source, /--output-mode', 'both'/);
  assert.doesNotMatch(source, /'--web-only'/);
  assert.doesNotMatch(source, /'--no-sub2api-export'/);
  assert.match(source, /'--sub2api-out', paths\.outputFile/);
  assert.match(source, /'--sub2api-name', account\.label/);
  assert.match(source, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(source, /'--headless=new'/);
  assert.match(source, /windowsHide: true/);
  assert.match(source, /stopProtocolBrowser\(browser\)/);
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /injectProtocolCookies/);
  assert.match(source, /readProtocolOauthExport\(paths\.outputFile\)/);
  assert.match(source, /writeJsonAtomic\(path\.join\(codexHomeDir, 'auth\.json'\), validateAuthPayload\(oauth\.auth\)\)/);
  assert.match(source, /webLoginComplete = true/);
  assert.match(source, /setupStage = 'complete'/);
  assert.match(source, /authSource = 'protocol-web-and-codex-oauth'/);
  assert.match(source, /protocol-input/);
  assert.doesNotMatch(source, /Start-Process -FilePath 'powershell\.exe'/);
});

test('邮箱验证码与其他验证步骤均通过账号卡片人工写入当前子进程', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /operation === 'protocol-input'/);
  assert.match(source, /validateProtocolInput\(pending\.promptKind, body\.value\)/);
  assert.match(source, /pending\.child\.stdin\.write\(`\$\{value\}\\n`\)/);
  assert.doesNotMatch(source, /MailOtpSession|mockOtpEndpoint|otpSession|otpController/);
});

test('Headless Chrome 写入 Cookie 后重试会话校验，并允许 403 延后到可见浏览器验证', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'protocol-login.js'), 'utf8');
  assert.match(source, /attempt <= 3/);
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

test('网页会话可转换为经过 Codex 校验的临时 auth.json 结构', () => {
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
  assert.equal(auth.auth_mode, 'chatgpt');
  assert.equal(auth.tokens.account_id, 'account-from-session');
  assert.equal(auth.tokens.access_token, accessToken);
  assert.equal(auth.tokens.refresh_token, accessToken);
  assert.equal(auth.last_refresh, now.toISOString());
  const idClaims = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(idClaims['https://api.openai.com/auth'].chatgpt_account_id, 'account-from-session');
});

test('协议登录遇到手机号绑定时先执行网页凭证在线校验回退', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /if \(prompt\.kind === 'phone'\) \{/);
  assert.match(source, /status: 'finalizing'/);
  assert.match(source, /persistedBrowserResult = await injectProtocolCookies/);
  assert.match(source, /cookies: \[\]/);
  assert.match(source, /独立 Chrome 会话写入后未能持久保存/);
  assert.match(source, /waitForProtocolBrowserExit\(pending\.browser\)/);
  assert.match(source, /launchAccountBrowserForProtocol\(account, \{ visibleOffscreen: true \}\)/);
  assert.match(source, /readCodexQuota\(findCodexCli\(\), stagingHome, 20_000\)/);
  assert.match(source, /authSource = 'web-session-fallback'/);
});

test('Chrome closes gracefully so protocol cookies can reach disk', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'protocol-login.js'), 'utf8');
  assert.match(source, /function closeChromeAndWait\(socket, timeoutMs = 5_000\)/);
  assert.match(source, /socket\.addEventListener\('close', finish/);
  assert.match(source, /await closeChromeAndWait\(socket\)/);
});

test('协议登录异常不会带崩本地服务，重启后 finalizing 会标记为中断', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /\['starting', 'waiting', 'finalizing'\]\.includes\(attempt\.status\)/);
  assert.match(source, /completeWithWebSession\(\)\.catch\(\(error\) => fail/);
  assert.match(source, /const consumeSafely = \(chunk\) =>/);
  assert.match(source, /try \{ cleanupProtocolLoginFiles\(paths\); \} catch \{\}/);
});

test('网页凭证校验目录遇到 Windows EPERM 时延迟清理且不影响入池', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const quota = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-quota.js'), 'utf8');
  assert.match(server, /web-session-check-\$\{process\.pid\}-\$\{Date\.now\(\)\}/);
  assert.match(server, /async function removeDirectoryWithRetry/);
  assert.match(server, /\['EPERM', 'EBUSY', 'ENOTEMPTY'\]/);
  assert.match(server, /cleanupDirectoryEventually\(stagingHome\)/);
  assert.match(quota, /child\.once\('exit', complete\)/);
  assert.match(quota, /setTimeout\(complete, 2_000\)/);
});

test('协议登录入池后不自动打开窗口，手动网页端仍绑定账号独立目录', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /`--user-data-dir=\$\{browserDir\}`/);
  assert.match(server, /'--profile-directory=Default'/);
  assert.match(server, /'--remote-debugging-address=127\.0\.0\.1'/);
  assert.match(server, /async function waitForChromeDebugPort/);
  assert.match(server, /throw new Error\('独立 Chrome 环境启动后未绑定到对应账号目录'\)/);
  assert.doesNotMatch(server, /launchProtocolAccountWindow/);
  assert.match(server, /if \(launchType === 'browser'\) \{[\s\S]*launchAccountBrowser\(account, settings\.browserStartUrl/);
});

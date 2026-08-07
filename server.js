const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  acquireLease,
  cleanExpiredLeases,
  isWithin,
  normalizeOperator,
  validateAccountId,
} = require('./lib/core');
const { readCodexQuota } = require('./lib/codex-quota');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(ROOT, 'config');
const DATA_DIR = path.join(ROOT, 'data');
const PROFILES_DIR = path.join(ROOT, 'profiles');
const BROWSER_PROFILES_DIR = path.join(PROFILES_DIR, 'browser');
const CODEX_PROFILES_DIR = path.join(PROFILES_DIR, 'codex');
const ACCOUNTS_FILE = path.join(CONFIG_DIR, 'accounts.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const LEASES_FILE = path.join(DATA_DIR, 'leases.json');
const ACCESS_TOKEN_FILE = path.join(DATA_DIR, 'access-token.txt');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const ACTIVE_CODEX_AUTH_FILE = path.join(DATA_DIR, 'active-codex-auth.json');
const SHARED_CODEX_HOME = path.join(os.homedir(), '.codex');
const SHARED_CODEX_AUTH_FILE = path.join(SHARED_CODEX_HOME, 'auth.json');
const SHARED_AUTH_BACKUP_DIR = path.join(CODEX_PROFILES_DIR, '_shared');
const SHARED_AUTH_BACKUP_FILE = path.join(SHARED_AUTH_BACKUP_DIR, 'original-auth.json');

for (const directory of [PUBLIC_DIR, CONFIG_DIR, DATA_DIR, BROWSER_PROFILES_DIR, CODEX_PROFILES_DIR]) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取 ${path.basename(file)}：${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function copyFileAtomic(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temporary);
  try { fs.chmodSync(temporary, 0o600); } catch {}
  fs.renameSync(temporary, destination);
}

function loadSettings() {
  const value = readJson(SETTINGS_FILE, {});
  const environmentPort = Number.parseInt(process.env.CODEX_MANAGER_PORT || '', 10);
  return {
    port: Number.isInteger(environmentPort) && environmentPort >= 0 && environmentPort <= 65_535
      ? environmentPort
      : Number.isInteger(value.port) ? value.port : 47821,
    operators: Array.isArray(value.operators) ? value.operators.map(normalizeOperator).filter(Boolean) : [],
    browserExecutable: typeof value.browserExecutable === 'string' ? value.browserExecutable.trim() : '',
    codexDesktopExecutable: typeof value.codexDesktopExecutable === 'string' ? value.codexDesktopExecutable.trim() : '',
    codexCliExecutable: typeof value.codexCliExecutable === 'string' ? value.codexCliExecutable.trim() : '',
    browserStartUrl: typeof value.browserStartUrl === 'string' && /^https:\/\/chatgpt\.com(?:\/|$)/i.test(value.browserStartUrl)
      ? value.browserStartUrl
      : 'https://chatgpt.com/',
    mockLaunch: value.mockLaunch === true || process.env.CODEX_MANAGER_MOCK_LAUNCH === '1',
  };
}

let settings = loadSettings();
let accounts = readJson(ACCOUNTS_FILE, []);
let leases = Object.fromEntries(Object.entries(readJson(LEASES_FILE, {})).map(([accountId, lease]) => [
  accountId,
  { ...lease, operator: '本机用户' },
]));
const pendingCodexLogins = new Map();
const csrfToken = crypto.randomBytes(24).toString('base64url');

function getAccessToken() {
  try {
    return fs.readFileSync(ACCESS_TOKEN_FILE, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(ACCESS_TOKEN_FILE, value, { mode: 0o600 });
    return value;
  }
}

const accessToken = getAccessToken();

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorized(request) {
  const cookies = Object.fromEntries(
    String(request.headers.cookie || '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)]),
  );
  return safeEqual(cookies.codex_manager_session, accessToken);
}

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { ok: false, error: message });
}

function audit(event, details = {}) {
  const record = {
    time: new Date().toISOString(),
    event,
    operator: normalizeOperator(details.operator || ''),
    accountId: validateAccountId(details.accountId) ? details.accountId : undefined,
    result: String(details.result || 'ok').replace(/[\r\n]/g, ' ').slice(0, 100),
  };
  fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(record)}\n`);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 32_768) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('请求不是有效的 JSON'));
      }
    });
    request.on('error', reject);
  });
}

function requireOperator() {
  return '本机用户';
}

function findBrowser(browserType) {
  if (settings.browserExecutable) {
    if (!fs.existsSync(settings.browserExecutable)) throw new Error('settings.json 中配置的浏览器路径不存在');
    return settings.browserExecutable;
  }
  const candidates = browserType === 'chrome'
    ? [
        path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : [
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ];
  const executable = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!executable) throw new Error(`没有找到 ${browserType === 'chrome' ? 'Chrome' : 'Edge'}，请在 settings.json 中配置 browserExecutable`);
  return executable;
}

function findCodexDesktop() {
  if (settings.codexDesktopExecutable) {
    if (!fs.existsSync(settings.codexDesktopExecutable)) {
      throw new Error('settings.json 中配置的 Codex 桌面端路径不存在');
    }
    return settings.codexDesktopExecutable;
  }

  const query = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '(Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
  );
  const installLocation = String(query.stdout || '').trim();
  const executable = installLocation ? path.join(installLocation, 'app', 'ChatGPT.exe') : '';
  if (!executable || !fs.existsSync(executable)) {
    throw new Error('没有找到 Windows Codex 桌面应用，请先从官方渠道安装，或在 settings.json 中配置 codexDesktopExecutable');
  }
  return executable;
}

function findCodexCli() {
  if (settings.codexCliExecutable) {
    if (!fs.existsSync(settings.codexCliExecutable)) {
      throw new Error('settings.json 中配置的 Codex CLI 路径不存在');
    }
    return settings.codexCliExecutable;
  }

  const npmExecutable = path.join(
    process.env.APPDATA || '',
    'npm',
    'node_modules',
    '@openai',
    'codex',
    'node_modules',
    '@openai',
    'codex-win32-x64',
    'vendor',
    'x86_64-pc-windows-msvc',
    'bin',
    'codex.exe',
  );
  if (fs.existsSync(npmExecutable)) return npmExecutable;

  const managedBin = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(managedBin)) {
    const managedExecutables = fs.readdirSync(managedBin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(managedBin, entry.name, 'codex.exe'))
      .filter((candidate) => fs.existsSync(candidate))
      .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    if (managedExecutables.length) return managedExecutables[0];
  }

  throw new Error('没有找到 Codex CLI，无法启动首次设备授权');
}

function findRunningCodexDesktopPid() {
  const query = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' } | Select-Object -First 1 -ExpandProperty ProcessId",
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
  );
  if (query.error || query.status !== 0) {
    throw new Error('无法检查 Codex 桌面端运行状态，请稍后重试');
  }
  const pid = Number.parseInt(String(query.stdout || '').trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function accountPaths(account) {
  const browserDir = path.join(BROWSER_PROFILES_DIR, account.id);
  const codexDir = path.join(CODEX_PROFILES_DIR, account.id);
  if (!isWithin(BROWSER_PROFILES_DIR, browserDir) || !isWithin(CODEX_PROFILES_DIR, codexDir)) {
    throw new Error('账号目录超出允许范围');
  }
  return {
    browserDir,
    codexDir,
    codexHomeDir: path.join(codexDir, 'home'),
    codexDesktopDir: path.join(codexDir, 'desktop'),
    codexSqliteDir: path.join(codexDir, 'sqlite'),
  };
}

function isCodexAuthenticated(account) {
  const { codexDir, codexHomeDir } = accountPaths(account);
  return fs.existsSync(path.join(codexHomeDir, 'auth.json')) || fs.existsSync(path.join(codexDir, 'auth.json'));
}

function readActiveCodexAuth() {
  const active = readJson(ACTIVE_CODEX_AUTH_FILE, null);
  return active && validateAccountId(active.accountId) ? active : null;
}

function activateSharedCodexAuth(account) {
  const { codexHomeDir } = accountPaths(account);
  const accountAuthFile = path.join(codexHomeDir, 'auth.json');
  if (!fs.existsSync(accountAuthFile)) throw new Error('该账号还没有完成 Codex 授权');

  const active = readActiveCodexAuth();
  if (active && active.accountId !== account.id) {
    throw new Error('另一个 Codex 账号认证仍处于激活状态，请先关闭其桌面端');
  }
  if (active?.accountId === account.id) return;

  fs.mkdirSync(SHARED_CODEX_HOME, { recursive: true });
  fs.mkdirSync(SHARED_AUTH_BACKUP_DIR, { recursive: true });
  const hadOriginalAuth = fs.existsSync(SHARED_CODEX_AUTH_FILE);
  if (hadOriginalAuth) copyFileAtomic(SHARED_CODEX_AUTH_FILE, SHARED_AUTH_BACKUP_FILE);
  copyFileAtomic(accountAuthFile, SHARED_CODEX_AUTH_FILE);
  writeJsonAtomic(ACTIVE_CODEX_AUTH_FILE, {
    accountId: account.id,
    hadOriginalAuth,
    activatedAt: new Date().toISOString(),
  });
}

function restoreSharedCodexAuth(accountId) {
  const active = readActiveCodexAuth();
  if (!active || active.accountId !== accountId) return;
  const account = accounts.find((item) => item.id === accountId);
  if (account && fs.existsSync(SHARED_CODEX_AUTH_FILE)) {
    const { codexHomeDir } = accountPaths(account);
    copyFileAtomic(SHARED_CODEX_AUTH_FILE, path.join(codexHomeDir, 'auth.json'));
  }
  if (active.hadOriginalAuth && fs.existsSync(SHARED_AUTH_BACKUP_FILE)) {
    copyFileAtomic(SHARED_AUTH_BACKUP_FILE, SHARED_CODEX_AUTH_FILE);
  } else {
    fs.rmSync(SHARED_CODEX_AUTH_FILE, { force: true });
  }
  fs.rmSync(ACTIVE_CODEX_AUTH_FILE, { force: true });
  audit('codex.auth.restored', { accountId, result: 'shared-projects' });
}

function ensureCodexProfileConfig(codexHomeDir) {
  fs.mkdirSync(codexHomeDir, { recursive: true });
  const configFile = path.join(codexHomeDir, 'config.toml');
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  }
}

function launchAccountBrowser(account, url) {
  const { browserDir } = accountPaths(account);
  fs.mkdirSync(browserDir, { recursive: true });
  const executable = findBrowser(account.browserType || 'edge');
  const child = spawn(executable, [`--user-data-dir=${browserDir}`, '--no-first-run', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

function launchCodexDesktop(account) {
  const { codexHomeDir } = accountPaths(account);
  ensureCodexProfileConfig(codexHomeDir);
  const runningPid = findRunningCodexDesktopPid();
  if (runningPid) {
    const active = readActiveCodexAuth();
    if (!active || active.accountId === account.id) {
      throw new Error('Codex 桌面端已在运行，请先退出当前窗口');
    }
    stopManagedCodexDesktop(active.accountId);
  }
  const executable = findCodexDesktop();
  activateSharedCodexAuth(account);
  const environment = { ...process.env, CODEX_HOME: SHARED_CODEX_HOME };
  delete environment.CODEX_ELECTRON_USER_DATA_PATH;
  delete environment.CODEX_SQLITE_HOME;
  let child;
  try {
    child = spawn(executable, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: environment,
    });
  } catch (error) {
    restoreSharedCodexAuth(account.id);
    throw error;
  }
  child.once('error', () => restoreSharedCodexAuth(account.id));
  child.unref();
  return child.pid;
}

function stopManagedCodexDesktop(accountId) {
  const active = readActiveCodexAuth();
  if (!active || active.accountId !== accountId) throw new Error('无法确认当前 Codex 属于这个账号');
  const processPid = findRunningCodexDesktopPid();
  if (processPid) {
    try { process.kill(processPid, 'SIGTERM'); }
    catch (error) { throw new Error(`无法退出 Codex：${error.message}`); }
    spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Wait-Process -Id ${processPid} -Timeout 8 -ErrorAction SilentlyContinue`], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    if (isProcessAlive(processPid)) throw new Error('Codex 尚未退出，请关闭窗口后重试');
  }
  restoreSharedCodexAuth(accountId);
  const next = { ...leases };
  delete next[accountId];
  saveLeases(next);
  audit('codex.desktop.stopped', { accountId, result: 'user-request' });
}

function cancelPendingCodexLogin(accountId) {
  const pending = pendingCodexLogins.get(accountId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.status = 'error';
  if (pending.child && isProcessAlive(pending.child.pid)) {
    try { pending.child.kill(); } catch {}
  }
  pendingCodexLogins.delete(accountId);
}

function startCodexDeviceLogin(account, operator) {
  cancelPendingCodexLogin(account.id);
  const { codexHomeDir } = accountPaths(account);
  ensureCodexProfileConfig(codexHomeDir);
  const executable = findCodexCli();
  const child = spawn(executable, ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHomeDir, NO_COLOR: '1', TERM: 'dumb' },
  });
  const pending = {
    child,
    operator,
    status: 'starting',
    userCode: '',
    deviceUrl: 'https://auth.openai.com/codex/device',
    output: '',
    browserOpened: false,
    startedAt: new Date().toISOString(),
    timeout: null,
  };
  pendingCodexLogins.set(account.id, pending);

  const fail = (message) => {
    if (pending.status === 'complete' || pending.status === 'error') return;
    pending.status = 'error';
    pending.error = message;
    clearTimeout(pending.timeout);
    const lease = leases[account.id];
    if (lease?.operator === operator) {
      const next = { ...leases };
      delete next[account.id];
      saveLeases(next);
    }
    audit('codex.login.failed', { accountId: account.id, operator, result: message });
  };

  const consume = (chunk) => {
    pending.output = `${pending.output}${chunk}`.slice(-12_000);
    const plain = pending.output.replace(/\x1b\[[0-9;]*m/g, '');
    const code = plain.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0];
    if (!code || pending.browserOpened) return;
    pending.userCode = code;
    pending.status = 'waiting';
    pending.browserOpened = true;
    try {
      launchAccountBrowser(account, pending.deviceUrl);
      audit('codex.login.browser-opened', { accountId: account.id, operator, result: 'device-auth' });
    } catch (error) {
      fail(error.message);
      try { child.kill(); } catch {}
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', consume);
  child.stderr.on('data', consume);
  child.on('error', (error) => fail(`无法启动 Codex 登录：${error.message}`));
  child.on('exit', (code) => {
    clearTimeout(pending.timeout);
    if (pending.status === 'error') return;
    if (code !== 0 || !isCodexAuthenticated(account)) {
      fail('Codex 登录没有完成，请重新发起授权');
      return;
    }
    pending.status = 'complete';
    pendingCodexLogins.delete(account.id);
    account.setupStage = 'complete';
    saveAccounts([...accounts]);
    const lease = leases[account.id];
    if (lease?.operator === operator) {
      const next = { ...leases };
      delete next[account.id];
      saveLeases(next);
    }
    audit('codex.login.success', { accountId: account.id, operator, result: 'pooled' });
  });
  pending.timeout = setTimeout(() => {
    fail('Codex 登录验证码已过期，请重新发起授权');
    try { child.kill(); } catch {}
  }, 15 * 60 * 1000);
  return child.pid;
}

function launchAccount(account, launchType, operator) {
  const { browserDir, codexDir, codexHomeDir, codexDesktopDir, codexSqliteDir } = accountPaths(account);
  fs.mkdirSync(browserDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  if (settings.mockLaunch) return null;

  if (launchType === 'browser') {
    return launchAccountBrowser(account, settings.browserStartUrl);
  }

  if (findRunningCodexDesktopPid()) {
    throw new Error('Codex 桌面端是单实例应用。请先关闭当前 Codex 窗口，再从账号池启动目标账号');
  }
  if (!isCodexAuthenticated(account) || account.quotaErrorCode === 'auth_expired') {
    throw new Error('该账号授权已失效，请先点击“重新授权”');
  }
  return launchCodexDesktop(account);
}

function accountView(account) {
  const { browserDir, codexDir, codexHomeDir, codexDesktopDir } = accountPaths(account);
  const codexInitialized = isCodexAuthenticated(account) && account.quotaErrorCode !== 'auth_expired';
  return {
    id: account.id,
    label: account.label,
    emailHint: account.emailHint || '',
    browserType: account.browserType || 'edge',
    enabled: account.enabled !== false,
    createdAt: account.createdAt,
    quota: account.quota || null,
    codexActive: readActiveCodexAuth()?.accountId === account.id,
    browserInitialized: fs.existsSync(path.join(browserDir, 'Local State')),
    codexInitialized,
    setupStage: codexInitialized ? 'complete' : account.setupStage || 'web-login',
    quotaError: account.quotaError || '',
    quotaErrorCode: account.quotaErrorCode || '',
    quotaCheckedAt: account.quotaCheckedAt || null,
    codexLogin: pendingCodexLogins.has(account.id) ? (() => {
      const login = pendingCodexLogins.get(account.id);
      return {
        status: login.status,
        userCode: login.userCode,
        deviceUrl: login.deviceUrl,
        error: login.error || '',
      };
    })() : null,
    lease: leases[account.id] ? {
      accountId: leases[account.id].accountId,
      operator: leases[account.id].operator,
      acquiredAt: leases[account.id].acquiredAt,
      launchType: leases[account.id].launchType,
    } : null,
  };
}

function saveLeases(next) {
  leases = next;
  writeJsonAtomic(LEASES_FILE, leases);
}

function saveAccounts(next) {
  accounts = next;
  writeJsonAtomic(ACCOUNTS_FILE, accounts);
}

function cleanLeases() {
  const result = cleanExpiredLeases(leases);
  let changed = result.changed;
  const next = { ...result.leases };
  for (const [accountId, lease] of Object.entries(next)) {
    if (lease.processPid && !isProcessAlive(lease.processPid)) {
      if (lease.launchType === 'codex') restoreSharedCodexAuth(accountId);
      delete next[accountId];
      changed = true;
      audit('lease.auto-release', { accountId, operator: lease.operator, result: 'process-exited' });
    }
  }
  const activeAuth = readActiveCodexAuth();
  if (activeAuth && !findRunningCodexDesktopPid()) restoreSharedCodexAuth(activeAuth.accountId);
  if (changed) saveLeases(next);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function serveFile(requestPath, response) {
  const fileName = requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const fullPath = path.resolve(PUBLIC_DIR, fileName);
  if (!isWithin(PUBLIC_DIR, fullPath) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    sendError(response, 404, '页面不存在');
    return;
  }
  const type = path.extname(fullPath) === '.css' ? 'text/css' : path.extname(fullPath) === '.js' ? 'text/javascript' : 'text/html';
  response.writeHead(200, securityHeaders({ 'Content-Type': `${type}; charset=utf-8` }));
  fs.createReadStream(fullPath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (!safeEqual(url.searchParams.get('token'), accessToken)) return sendError(response, 403, '启动令牌无效');
      response.writeHead(302, securityHeaders({
        Location: '/',
        'Set-Cookie': `codex_manager_session=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Strict; Path=/`,
      }));
      response.end();
      return;
    }
    if (!isAuthorized(request)) return sendError(response, 401, '请通过 start.bat 启动并打开管理器');

    if (request.method === 'GET' && url.pathname === '/favicon.ico') {
      response.writeHead(204, securityHeaders());
      response.end();
      return;
    }

    if (url.pathname.startsWith('/api/') && request.method !== 'GET' && !safeEqual(request.headers['x-csrf-token'], csrfToken)) {
      return sendError(response, 403, '页面令牌已失效，请刷新后重试');
    }

    if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
      cleanLeases();
      return sendJson(response, 200, {
        ok: true,
        data: {
          accounts: accounts.map(accountView),
          codexRunning: Boolean(findRunningCodexDesktopPid()),
          csrfToken,
          operators: settings.operators,
          mockLaunch: settings.mockLaunch,
        },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/accounts') {
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      const label = String(body.label || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60);
      if (!label) return sendError(response, 400, '请输入账号名称');
      const account = {
        id: `account-${crypto.randomBytes(6).toString('hex')}`,
        label,
        emailHint: String(body.emailHint || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 100),
        browserType: body.browserType === 'chrome' ? 'chrome' : 'edge',
        enabled: true,
        setupStage: 'web-login',
        createdAt: new Date().toISOString(),
      };
      saveAccounts([...accounts, account]);
      audit('account.add', { accountId: account.id, operator });
      if (!settings.mockLaunch) {
        const result = acquireLease(leases, account.id, operator, 'setup');
        saveLeases(result.leases);
        try {
          const processPid = launchAccountBrowser(account, settings.browserStartUrl);
          result.lease.processPid = processPid;
          saveLeases({ ...leases, [account.id]: result.lease });
          audit('account.web-login.opened', { accountId: account.id, operator, result: 'first-step' });
        } catch (error) {
          const next = { ...leases };
          delete next[account.id];
          saveLeases(next);
          audit('account.web-login.failed', { accountId: account.id, operator, result: error.message });
          return sendError(response, 500, `账号已创建，但网页登录窗口未打开：${error.message}`);
        }
      }
      return sendJson(response, 201, { ok: true, data: accountView(account) });
    }

    const match = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)\/(launch|release|toggle|authorize|quota|quit-codex)$/);
    if (match && request.method === 'POST') {
      const [, accountId, operation] = match;
      if (!validateAccountId(accountId)) return sendError(response, 400, '账号 ID 无效');
      const account = accounts.find((item) => item.id === accountId);
      if (!account) return sendError(response, 404, '账号不存在');
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      cleanLeases();

      if (operation === 'quit-codex') {
        const lease = leases[accountId];
        if (lease && lease.operator !== operator) return sendError(response, 409, `账号由 ${lease.operator} 使用，只能由本人退出`);
        try {
          stopManagedCodexDesktop(accountId);
          return sendJson(response, 200, { ok: true, data: accountView(account) });
        } catch (error) {
          return sendError(response, 409, error.message);
        }
      }

      if (operation === 'quota') {
        if (!isCodexAuthenticated(account)) return sendError(response, 409, '请先完成该账号的入池授权');
        try {
          const { codexHomeDir } = accountPaths(account);
          account.quota = await readCodexQuota(findCodexCli(), codexHomeDir);
          account.quotaError = '';
          account.quotaErrorCode = '';
          account.quotaCheckedAt = account.quota.refreshedAt;
          saveAccounts([...accounts]);
          audit('quota.refresh', { accountId, operator, result: 'success' });
          return sendJson(response, 200, { ok: true, data: accountView(account) });
        } catch (error) {
          const authExpired = /401|unauthorized|token_revoked|invalidated oauth/i.test(error.message);
          account.quotaError = authExpired ? '登录已失效，请重新授权' : '额度读取失败，请稍后重试';
          account.quotaErrorCode = authExpired ? 'auth_expired' : 'fetch_failed';
          account.quotaCheckedAt = new Date().toISOString();
          saveAccounts([...accounts]);
          audit('quota.refresh', { accountId, operator, result: error.message });
          return sendError(response, authExpired ? 401 : 502, account.quotaError);
        }
      }

      if (operation === 'authorize') {
        if (isCodexAuthenticated(account) && account.quotaErrorCode !== 'auth_expired') {
          return sendJson(response, 200, { ok: true, data: accountView(account) });
        }
        if (account.quotaErrorCode === 'auth_expired') {
          const { codexHomeDir } = accountPaths(account);
          const authFile = path.join(codexHomeDir, 'auth.json');
          if (fs.existsSync(authFile)) {
            const backupFile = path.join(codexHomeDir, `auth.invalid-${Date.now()}.bak`);
            fs.renameSync(authFile, backupFile);
          }
          account.quota = null;
          account.quotaError = '';
          account.quotaErrorCode = '';
          account.quotaCheckedAt = null;
          saveAccounts([...accounts]);
        }
        const result = acquireLease(leases, accountId, operator, 'setup');
        if (!result.ok) return sendError(response, 409, `账号正在由 ${result.existing.operator} 使用`);
        saveLeases(result.leases);
        try {
          account.setupStage = 'device-auth';
          saveAccounts([...accounts]);
          const processPid = startCodexDeviceLogin(account, operator);
          result.lease.processPid = processPid;
          saveLeases({ ...leases, [accountId]: result.lease });
          audit('codex.login.started', { accountId, operator, result: 'manual-retry' });
          return sendJson(response, 200, { ok: true, data: accountView(account) });
        } catch (error) {
          account.setupStage = 'web-login';
          saveAccounts([...accounts]);
          const next = { ...leases };
          delete next[accountId];
          saveLeases(next);
          return sendError(response, 500, error.message);
        }
      }

      if (operation === 'release') {
        const lease = leases[accountId];
        if (!lease) return sendJson(response, 200, { ok: true, data: accountView(account) });
        if (lease.operator !== operator) return sendError(response, 409, `账号由 ${lease.operator} 占用，只能由本人释放`);
        cancelPendingCodexLogin(accountId);
        const next = { ...leases };
        delete next[accountId];
        saveLeases(next);
        audit('lease.release', { accountId, operator });
        return sendJson(response, 200, { ok: true, data: accountView(account) });
      }

      if (operation === 'toggle') {
        account.enabled = !account.enabled;
        saveAccounts([...accounts]);
        audit('account.toggle', { accountId, operator, result: account.enabled ? 'enabled' : 'disabled' });
        return sendJson(response, 200, { ok: true, data: accountView(account) });
      }

      if (account.enabled === false) return sendError(response, 409, '账号已停用');
      const launchType = body.launchType === 'codex' ? 'codex' : 'browser';
      const result = acquireLease(leases, accountId, operator, launchType);
      if (!result.ok) {
        audit('launch.denied', { accountId, operator, result: 'occupied' });
        return sendError(response, 409, `账号正在由 ${result.existing.operator} 使用`);
      }
      saveLeases(result.leases);
      try {
        const processPid = launchAccount(account, launchType, operator);
        if (processPid) {
          result.lease.processPid = processPid;
          saveLeases({ ...leases, [accountId]: result.lease });
        }
      } catch (error) {
        const rollback = { ...leases };
        if (result.previous) rollback[accountId] = result.previous;
        else delete rollback[accountId];
        saveLeases(rollback);
        audit('launch.failed', { accountId, operator, result: error.message });
        return sendError(response, 500, error.message);
      }
      audit('launch.success', { accountId, operator, result: launchType });
      return sendJson(response, 200, { ok: true, data: accountView(account) });
    }

    if (request.method === 'DELETE' && url.pathname.startsWith('/api/accounts/')) {
      const accountId = url.pathname.split('/').pop();
      if (!validateAccountId(accountId)) return sendError(response, 400, '账号 ID 无效');
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      if (leases[accountId]) return sendError(response, 409, '请先释放账号再移除');
      if (!accounts.some((item) => item.id === accountId)) return sendError(response, 404, '账号不存在');
      saveAccounts(accounts.filter((item) => item.id !== accountId));
      audit('account.remove', { accountId, operator });
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === 'GET' && !url.pathname.startsWith('/api/')) return serveFile(url.pathname, response);
    return sendError(response, 404, '接口不存在');
  } catch (error) {
    console.error(error);
    return sendError(response, 500, error.message || '服务器发生错误');
  }
});

server.listen(settings.port, '127.0.0.1', () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  const url = `http://127.0.0.1:${settings.port}/?token=${encodeURIComponent(accessToken)}`;
  if (process.env.CODEX_MANAGER_NO_OPEN === '1') console.log('\nCodex Switchboard 已启动（测试模式）。\n');
  else console.log(`\nCodex Switchboard 已启动：\n${url}\n`);
  console.log('此窗口用于运行本地服务，使用完毕后可以关闭。');
  if (process.env.CODEX_MANAGER_NO_OPEN !== '1') {
    const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
});

server.on('error', (error) => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});

function cleanupPidFile() {
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(PID_FILE, { force: true });
  } catch {}
}

server.on('close', cleanupPidFile);
process.on('exit', cleanupPidFile);

module.exports = { server };

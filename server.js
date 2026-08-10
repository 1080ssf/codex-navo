const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const {
  acquireLease,
  cleanExpiredLeases,
  isWithin,
  normalizeOperator,
  validateAccountId,
} = require('./lib/core');
const { readCodexQuota } = require('./lib/codex-quota');
const { CodexUsageTracker } = require('./lib/codex-usage');
const { readModelCatalog } = require('./lib/model-catalog');
const { detectQuotaReset, localDateKey, normalizeWakeSettings, quotaObservation, shouldWakeAccount } = require('./lib/wake');
const { authIdentity, createAuthPackage, readAuthPackage, validateAuthPayload } = require('./lib/auth-package');
const { buildCodexAuthFromWebSession } = require('./lib/web-session-auth');
const {
  injectProtocolCookies,
  protocolPromptFromOutput,
  readProtocolCookies,
  readProtocolOauthExport,
  readProtocolSession,
  resolveProtocolProxyEnvironment,
  validateProtocolInput,
} = require('./lib/protocol-login');
const { version: APP_VERSION } = require('./package.json');

const ROOT = __dirname;
const RUNTIME_ROOT = process.env.CODEX_SWITCHBOARD_USER_DATA
  ? path.resolve(process.env.CODEX_SWITCHBOARD_USER_DATA)
  : ROOT;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_DIR = path.join(RUNTIME_ROOT, 'config');
const DATA_DIR = path.join(RUNTIME_ROOT, 'data');
const PROFILES_DIR = path.join(RUNTIME_ROOT, 'profiles');
const BROWSER_PROFILES_DIR = path.join(PROFILES_DIR, 'browser');
const CODEX_PROFILES_DIR = path.join(PROFILES_DIR, 'codex');
const ACCOUNTS_FILE = path.join(CONFIG_DIR, 'accounts.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const WAKE_SETTINGS_FILE = path.join(CONFIG_DIR, 'wake-settings.json');
const LEASES_FILE = path.join(DATA_DIR, 'leases.json');
const ACCESS_TOKEN_FILE = path.join(DATA_DIR, 'access-token.txt');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const ACTIVE_CODEX_AUTH_FILE = path.join(DATA_DIR, 'active-codex-auth.json');
const CODEX_USAGE_FILE = path.join(DATA_DIR, 'codex-usage.json');
const AUTH_ATTEMPTS_FILE = path.join(DATA_DIR, 'auth-attempts.json');
const SHARED_CODEX_HOME = process.env.CODEX_MANAGER_MOCK_LAUNCH === '1'
  ? path.join(RUNTIME_ROOT, 'shared-codex')
  : path.join(os.homedir(), '.codex');
const SHARED_CODEX_AUTH_FILE = path.join(SHARED_CODEX_HOME, 'auth.json');
const SHARED_AUTH_BACKUP_DIR = path.join(CODEX_PROFILES_DIR, '_shared');
const SHARED_AUTH_BACKUP_FILE = path.join(SHARED_AUTH_BACKUP_DIR, 'original-auth.json');
const IP_CHECK_URL = 'https://ipip.la/';

for (const directory of [CONFIG_DIR, DATA_DIR, BROWSER_PROFILES_DIR, CODEX_PROFILES_DIR]) {
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
let wakeSettings = normalizeWakeSettings(readJson(WAKE_SETTINGS_FILE, {}));
let leases = Object.fromEntries(Object.entries(readJson(LEASES_FILE, {})).map(([accountId, lease]) => [
  accountId,
  { ...lease, operator: '本机用户' },
]));
let authAttempts = readJson(AUTH_ATTEMPTS_FILE, {});
for (const [accountId, attempt] of Object.entries(authAttempts)) {
  if (!validateAccountId(accountId) || !attempt || typeof attempt !== 'object') {
    delete authAttempts[accountId];
  } else if (['starting', 'waiting', 'finalizing'].includes(attempt.status)) {
    authAttempts[accountId] = {
      ...attempt,
      status: 'interrupted',
      updatedAt: new Date().toISOString(),
      error: '上次授权因应用关闭而中断，可以继续发起官方授权',
    };
  }
}
writeJsonAtomic(AUTH_ATTEMPTS_FILE, authAttempts);
const pendingCodexLogins = new Map();
const protocolLoginImports = new Set();
const wakeRuns = new Map();
let wakeScheduleRunning = false;
let usageTracker = null;
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

let usageIntervalsCache = { modified: -1, activeSignature: '', intervals: [] };

function codexUsageIntervals() {
  let modified = 0;
  try { modified = fs.statSync(AUDIT_FILE).mtimeMs; } catch {}
  const active = readJson(ACTIVE_CODEX_AUTH_FILE, null);
  const activeSignature = active ? `${active.accountId}:${active.activatedAt}` : '';
  if (usageIntervalsCache.modified === modified && usageIntervalsCache.activeSignature === activeSignature) {
    return usageIntervalsCache.intervals;
  }

  const intervals = [];
  let open = null;
  let lines = [];
  try { lines = fs.readFileSync(AUDIT_FILE, 'utf8').split(/\r?\n/); } catch {}
  for (const line of lines) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const time = Date.parse(entry.time || '');
    if (!Number.isFinite(time)) continue;
    if (entry.event === 'launch.success' && entry.result === 'codex' && validateAccountId(entry.accountId)) {
      if (open) open.endMs = Math.max(open.startMs, time - 1);
      open = { accountId: entry.accountId, startMs: time, endMs: null };
      intervals.push(open);
    } else if (entry.event === 'codex.auth.restored' && open && (!entry.accountId || entry.accountId === open.accountId)) {
      open.endMs = Math.max(open.startMs, time);
      open = null;
    }
  }
  if (active && validateAccountId(active.accountId)) {
    const activatedAt = Date.parse(active.activatedAt || '');
    const current = intervals.at(-1);
    if (!current || current.endMs != null || current.accountId !== active.accountId) {
      intervals.push({
        accountId: active.accountId,
        startMs: Number.isFinite(activatedAt) ? activatedAt : Date.now(),
        endMs: null,
      });
    }
  }
  usageIntervalsCache = { modified, activeSignature, intervals };
  return intervals;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
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

function findBrowser() {
  if (settings.browserExecutable) {
    if (!fs.existsSync(settings.browserExecutable)) throw new Error('settings.json 中配置的浏览器路径不存在');
    return settings.browserExecutable;
  }
  const candidates = [
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  const executable = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!executable) throw new Error('没有找到 Google Chrome，请先安装 Chrome，或在 settings.json 中配置 browserExecutable');
  return executable;
}

function findCodexDesktop() {
  if (settings.codexDesktopExecutable) {
    if (!fs.existsSync(settings.codexDesktopExecutable)) {
      throw new Error('settings.json 中配置的 Codex 桌面端路径不存在');
    }
    return { executable: settings.codexDesktopExecutable, appUserModelId: '' };
  }

  const query = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($package) { $applicationId = (Get-AppxPackageManifest -Package $package.PackageFullName).Package.Applications.Application.Id | Select-Object -First 1; [PSCustomObject]@{ InstallLocation = $package.InstallLocation; AppUserModelId = \"$($package.PackageFamilyName)!$applicationId\" } | ConvertTo-Json -Compress }",
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 },
  );
  let packageInfo = null;
  try { packageInfo = JSON.parse(String(query.stdout || '').trim()); } catch {}
  const installLocation = String(packageInfo?.InstallLocation || '').trim();
  const executable = installLocation ? path.join(installLocation, 'app', 'ChatGPT.exe') : '';
  if (!executable || !fs.existsSync(executable)) {
    throw new Error('没有找到 Windows Codex 桌面应用，请先从官方渠道安装，或在 settings.json 中配置 codexDesktopExecutable');
  }
  return { executable, appUserModelId: String(packageInfo?.AppUserModelId || '').trim() };
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

function protocolLoginPaths(account) {
  const { codexDir } = accountPaths(account);
  const directory = path.join(codexDir, 'protocol-login');
  return {
    directory,
    outputFile: path.join(directory, 'oauth.json'),
    sessionFile: path.join(directory, 'session.json'),
    checkpointFile: path.join(directory, 'checkpoint.json'),
    statusFile: path.join(directory, 'status.json'),
  };
}

function cleanupProtocolLoginFiles(paths) {
  for (const file of [paths.outputFile, paths.sessionFile, paths.statusFile, paths.checkpointFile]) {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

async function removeDirectoryWithRetry(directory, attempts = 12, delayMs = 250) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return true;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

function cleanupDirectoryEventually(directory) {
  setTimeout(() => {
    void removeDirectoryWithRetry(directory, 20, 500).catch(() => {});
  }, 500).unref?.();
}

async function startProtocolLogin(account, operator) {
  cancelPendingCodexLogin(account.id);
  const email = String(account.emailHint || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('协议登录需要填写完整邮箱地址');
  }
  const paths = protocolLoginPaths(account);
  fs.mkdirSync(paths.directory, { recursive: true });
  cleanupProtocolLoginFiles(paths);
  const protocolScript = path.join(ROOT, 'vendor', 'tosub2', 'protocol-login.mjs');
  if (!fs.existsSync(protocolScript)) throw new Error('协议登录组件缺失');
  const browser = await launchAccountBrowserForProtocol(account);
  const environment = resolveProtocolProxyEnvironment({
    ...process.env,
    NODE_NO_WARNINGS: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  });
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(process.execPath, [
    protocolScript,
    '--email', email,
    '--output-mode', 'both',
    '--out', paths.sessionFile,
    '--sub2api-out', paths.outputFile,
    '--sub2api-name', account.label,
    '--checkpoint', paths.checkpointFile,
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: environment,
  });
  const pending = {
    child,
    operator,
    flow: 'protocol',
    status: 'starting',
    promptKind: '',
    promptLabel: '',
    promptHint: '',
    promptSecret: false,
    output: '',
    browser,
    startedAt: new Date().toISOString(),
    timeout: null,
    fail: null,
    lastProtocolError: '',
    webFallbackStarted: false,
  };
  pendingCodexLogins.set(account.id, pending);
  const fail = (message) => {
    if (pending.status === 'complete' || pending.status === 'error') return;
    pending.status = 'error';
    pending.error = String(message || '协议登录没有完成').slice(0, 500);
    try { saveAuthAttempt(account.id, { method: 'protocol', flow: 'protocol', status: 'error', error: pending.error }); } catch {}
    clearTimeout(pending.timeout);
    const next = { ...leases };
    delete next[account.id];
    try { saveLeases(next); } catch {}
    try { cleanupProtocolLoginFiles(paths); } catch {}
    try { audit('codex.protocol-login.failed', { accountId: account.id, operator, result: pending.error }); } catch {}
    if (isProcessAlive(child.pid)) try { child.kill(); } catch {}
    try { stopProtocolBrowser(pending.browser || browser); } catch {}
  };
  pending.fail = fail;
  const completeWithWebSession = async () => {
    if (pending.webFallbackStarted || pending.status === 'complete' || pending.status === 'error') return;
    pending.webFallbackStarted = true;
    pending.status = 'finalizing';
    saveAuthAttempt(account.id, {
      method: 'protocol', flow: 'protocol', status: 'finalizing', promptKind: '',
      promptLabel: '', promptHint: '检测到手机号绑定，正在从已登录网页会话同步 Codex 凭证', error: '',
    });
    const stagingHome = path.join(paths.directory, `web-session-check-${process.pid}-${Date.now()}`);
    try {
      const checkpoint = readJson(paths.checkpointFile, null);
      if (!Array.isArray(checkpoint?.cookies) || !checkpoint.cookies.length) {
        throw new Error('协议网页登录状态尚未保存');
      }
      stopProtocolBrowser(pending.browser);
      await new Promise((resolve) => setTimeout(resolve, 350));
      pending.browser = await launchAccountBrowserForProtocol(account, { visibleOffscreen: true });
      const browserResult = await injectProtocolCookies({
        port: pending.browser.port,
        cookies: checkpoint.cookies,
        closeBrowser: true,
        verificationDelayMs: 1_000,
      });
      if (!browserResult.verified || !browserResult.session) throw new Error('独立 Chrome 网页会话校验失败');
      if (!await waitForProtocolBrowserExit(pending.browser)) stopProtocolBrowser(pending.browser);
      await new Promise((resolve) => setTimeout(resolve, 500));
      pending.browser = await launchAccountBrowserForProtocol(account, { visibleOffscreen: true });
      const persistedBrowserResult = await injectProtocolCookies({
        port: pending.browser.port,
        cookies: [],
        closeBrowser: true,
        verificationDelayMs: 1_000,
      });
      if (!persistedBrowserResult.verified || !persistedBrowserResult.session) {
        throw new Error('独立 Chrome 会话写入后未能持久保存');
      }
      const auth = validateAuthPayload(buildCodexAuthFromWebSession(persistedBrowserResult.session));
      ensureCodexProfileConfig(stagingHome);
      writeJsonAtomic(path.join(stagingHome, 'auth.json'), auth);
      const quota = settings.mockLaunch ? null : await readCodexQuota(findCodexCli(), stagingHome, 20_000);
      if (!await removeDirectoryWithRetry(stagingHome)) cleanupDirectoryEventually(stagingHome);
      const { codexHomeDir } = accountPaths(account);
      ensureCodexProfileConfig(codexHomeDir);
      writeJsonAtomic(path.join(codexHomeDir, 'auth.json'), auth);
      account.webLoginComplete = true;
      account.setupStage = 'complete';
      account.authSource = 'web-session-fallback';
      account.quota = quota;
      account.quotaCheckedAt = quota?.refreshedAt || new Date().toISOString();
      account.quotaError = '';
      account.quotaErrorCode = '';
      saveAccounts([...accounts]);
      pending.status = 'complete';
      clearTimeout(pending.timeout);
      pendingCodexLogins.delete(account.id);
      clearAuthAttempt(account.id);
      const next = { ...leases };
      delete next[account.id];
      saveLeases(next);
      if (isProcessAlive(child.pid)) try { child.kill(); } catch {}
      stopProtocolBrowser(pending.browser);
      try { cleanupProtocolLoginFiles(paths); } catch {}
      audit('codex.protocol-login.web-session-fallback', { accountId: account.id, operator, result: 'validated-and-pooled' });
    } catch (error) {
      cleanupDirectoryEventually(stagingHome);
      try { stopProtocolBrowser(pending.browser); } catch {}
      pending.webFallbackStarted = false;
      pending.status = 'waiting';
      pending.promptKind = 'phone';
      pending.promptLabel = '手机号验证';
      pending.promptHint = `网页凭证导入失败：${String(error.message).slice(0, 180)}；可填写手机号继续官方授权`;
      pending.promptSecret = false;
      try {
        saveAuthAttempt(account.id, {
          method: 'protocol', flow: 'protocol', status: 'waiting', promptKind: 'phone',
          promptLabel: pending.promptLabel, promptHint: pending.promptHint, promptSecret: false, error: '',
        });
      } catch {}
      try { audit('codex.protocol-login.web-session-fallback', { accountId: account.id, operator, result: `failed: ${error.message}` }); } catch {}
    }
  };
  const submitProtocolInput = (kind, input) => {
    const value = validateProtocolInput(kind, input);
    if (pending.child.stdin.destroyed) throw new Error('协议登录输入通道已关闭');
    pending.child.stdin.write(`${value}\n`);
    pending.status = 'starting';
    pending.promptKind = '';
    pending.promptLabel = '';
    pending.promptHint = '';
    pending.promptSecret = false;
    pending.output = '';
    saveAuthAttempt(account.id, {
      method: 'protocol', flow: 'protocol', status: 'starting', promptKind: '',
      promptLabel: '', promptHint: '', promptSecret: false, error: '',
    });
  };
  const consume = (chunk) => {
    pending.output = `${pending.output}${chunk}`.slice(-16_000);
    const protocolError = [...pending.output.matchAll(/\[error\]\s*([^\r\n]+)/gi)].at(-1)?.[1];
    if (protocolError) pending.lastProtocolError = protocolError.trim().slice(0, 320);
    const prompt = protocolPromptFromOutput(pending.output);
    if (!prompt || prompt.kind === pending.promptKind) return;
    if (prompt.kind === 'phone') {
      pending.promptKind = '';
      pending.promptLabel = '';
      pending.promptHint = '官方授权要求绑定手机号，正在验证已经取得的 Codex 凭证与独立 Chrome 会话';
      pending.promptSecret = false;
      pending.status = 'finalizing';
      saveAuthAttempt(account.id, {
        method: 'protocol', flow: 'protocol', status: 'finalizing',
        promptKind: '', promptLabel: '', promptHint: pending.promptHint, promptSecret: false, error: '',
      });
      void completeWithWebSession().catch((error) => fail(`网页凭证验证异常：${error.message}`));
      return;
    }
    pending.promptKind = prompt.kind;
    pending.promptLabel = prompt.label;
    pending.promptHint = prompt.hint;
    pending.promptSecret = Boolean(prompt.secret);
    pending.status = 'waiting';
    saveAuthAttempt(account.id, {
      method: 'protocol', flow: 'protocol', status: 'waiting',
      promptKind: prompt.kind, promptLabel: prompt.label, promptHint: pending.promptHint, promptSecret: Boolean(prompt.secret), error: '',
    });
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const consumeSafely = (chunk) => {
    try { consume(chunk); } catch (error) { fail(`协议登录状态处理失败：${error.message}`); }
  };
  child.stdout.on('data', consumeSafely);
  child.stderr.on('data', consumeSafely);
  child.stdin.on('error', (error) => fail(`协议登录输入失败：${error.message}`));
  child.on('error', (error) => fail(`无法启动协议登录：${error.message}`));
  child.on('exit', async (code) => {
    if (pending.status === 'error' || pending.status === 'complete') return;
    if (code !== 0) {
      fail(pending.lastProtocolError
        ? `协议登录失败：${pending.lastProtocolError}`
        : `协议登录没有完成（退出码 ${code ?? '未知'}）`);
      return;
    }
    try {
      pending.status = 'finalizing';
      saveAuthAttempt(account.id, { method: 'protocol', flow: 'protocol', status: 'finalizing', promptKind: '', error: '' });
      const session = readProtocolSession(paths.sessionFile);
      const oauth = readProtocolOauthExport(paths.outputFile);
      await injectProtocolCookies({ port: browser.port, cookies: session.cookies, allowHeadlessBlocked: true, closeBrowser: true });
      const { codexHomeDir } = accountPaths(account);
      ensureCodexProfileConfig(codexHomeDir);
      writeJsonAtomic(path.join(codexHomeDir, 'auth.json'), validateAuthPayload(oauth.auth));
      stopProtocolBrowser(browser);
      account.webLoginComplete = true;
      account.setupStage = 'complete';
      account.authSource = 'protocol-web-and-codex-oauth';
      if (oauth.email && !account.emailHint) account.emailHint = oauth.email;
      account.quotaError = '';
      account.quotaErrorCode = '';
      saveAccounts([...accounts]);
      pending.status = 'complete';
      clearTimeout(pending.timeout);
      pendingCodexLogins.delete(account.id);
      clearAuthAttempt(account.id);
      const next = { ...leases };
      delete next[account.id];
      saveLeases(next);
      cleanupProtocolLoginFiles(paths);
      audit('codex.protocol-login.completed', { accountId: account.id, operator, result: 'web-and-codex-pooled' });
    } catch (error) {
      fail(error.message);
    }
  });
  saveAuthAttempt(account.id, {
    method: 'protocol',
    flow: 'protocol',
    status: 'starting',
    startedAt: pending.startedAt,
    processPid: child.pid,
    promptKind: '',
    error: '',
  });
  pending.timeout = setTimeout(() => fail('协议登录已超时，请重新发起'), 15 * 60 * 1000);
  audit('codex.protocol-login.started', { accountId: account.id, operator, result: 'hidden-web-and-codex' });
  return child.pid;
}

function pollProtocolLoginResults() {
  // 协议登录现在由隐藏子进程直接驱动；保留空轮询入口兼容旧定时器。
}

usageTracker = new CodexUsageTracker({
  storeFile: CODEX_USAGE_FILE,
  sharedCodexHome: SHARED_CODEX_HOME,
  getAccounts: () => accounts,
  getAccountHome: (account) => accountPaths(account).codexHomeDir,
  getActiveAccountId: () => readActiveCodexAuth()?.accountId || null,
  getSharedIntervals: codexUsageIntervals,
});

function isCodexAuthenticated(account) {
  const { codexDir, codexHomeDir } = accountPaths(account);
  return fs.existsSync(path.join(codexHomeDir, 'auth.json')) || fs.existsSync(path.join(codexDir, 'auth.json'));
}

function accountAuthFile(account) {
  const { codexDir, codexHomeDir } = accountPaths(account);
  const current = path.join(codexHomeDir, 'auth.json');
  const legacy = path.join(codexDir, 'auth.json');
  return fs.existsSync(current) ? current : legacy;
}

function readAccountAuth(account) {
  if (!isCodexAuthenticated(account)) throw new Error('该账号还没有 Codex 授权');
  const auth = readJson(accountAuthFile(account), null);
  return validateAuthPayload(auth);
}

function saveAuthAttempt(accountId, patch) {
  const previous = authAttempts[accountId] || {};
  authAttempts = {
    ...authAttempts,
    [accountId]: {
      ...previous,
      ...patch,
      accountId,
      updatedAt: new Date().toISOString(),
    },
  };
  writeJsonAtomic(AUTH_ATTEMPTS_FILE, authAttempts);
}

function clearAuthAttempt(accountId) {
  if (!authAttempts[accountId]) return;
  const next = { ...authAttempts };
  delete next[accountId];
  authAttempts = next;
  writeJsonAtomic(AUTH_ATTEMPTS_FILE, authAttempts);
}

function publicAuthAttempt(accountId) {
  const pending = pendingCodexLogins.get(accountId);
  const attempt = pending || authAttempts[accountId];
  if (!attempt) return null;
  return {
    flow: attempt.flow || attempt.method || 'browser',
    status: attempt.status,
    userCode: pending?.userCode || '',
    deviceUrl: pending?.deviceUrl || '',
    error: attempt.error || '',
    promptKind: pending?.promptKind || attempt.promptKind || '',
    promptLabel: pending?.promptLabel || attempt.promptLabel || '',
    promptHint: pending?.promptHint || attempt.promptHint || '',
    promptSecret: Boolean(pending?.promptSecret || attempt.promptSecret),
    startedAt: attempt.startedAt || attempt.updatedAt || null,
  };
}

function inspectAccountHealth(account) {
  const checkedAt = new Date().toISOString();
  const attempt = publicAuthAttempt(account.id);
  if (attempt && ['starting', 'waiting', 'finalizing'].includes(attempt.status)) {
    return { status: 'authorizing', label: '正在授权', detail: attempt.flow === 'protocol' ? '协议登录正在后台运行，请在应用内完成验证' : '请在账号独立浏览器中完成官方流程', checkedAt };
  }
  if (attempt?.status === 'interrupted') {
    return { status: 'interrupted', label: '授权已中断', detail: '可以从当前账号继续发起官方授权', checkedAt };
  }
  if (!isCodexAuthenticated(account)) {
    return { status: 'needs_auth', label: '需要授权', detail: '尚未保存 Codex 登录凭证', checkedAt };
  }
  try {
    readAccountAuth(account);
  } catch {
    return { status: 'invalid', label: '凭证异常', detail: '授权文件无法识别，请重新授权', checkedAt };
  }
  if (account.quotaErrorCode === 'auth_expired') {
    return { status: 'expired', label: '授权已失效', detail: '官方服务拒绝了当前凭证，请重新授权', checkedAt };
  }
  if (account.quotaErrorCode === 'fetch_failed') {
    return { status: 'attention', label: '需要检查', detail: '凭证存在，但最近一次在线检查失败', checkedAt };
  }
  return { status: 'healthy', label: '授权正常', detail: '本地凭证完整，可直接启动 Codex', checkedAt };
}

function saveWakeSettings(next) {
  wakeSettings = normalizeWakeSettings(next);
  writeJsonAtomic(WAKE_SETTINGS_FILE, wakeSettings);
}

function publicWakeSettings() {
  return {
    enabled: wakeSettings.enabled,
    mode: wakeSettings.mode,
    dailyTime: wakeSettings.dailyTime,
    model: wakeSettings.model,
    reasoningEffort: wakeSettings.reasoningEffort,
    prompt: wakeSettings.prompt,
  };
}

function wakeModelCatalog() {
  const files = [path.join(SHARED_CODEX_HOME, 'models_cache.json')];
  for (const account of accounts) files.push(path.join(accountPaths(account).codexHomeDir, 'models_cache.json'));
  return readModelCatalog(files);
}

function validateWakeModelSelection(model, reasoningEffort) {
  const catalog = wakeModelCatalog();
  const selected = model ? catalog.find((item) => item.slug === model) : catalog[0];
  if (!selected) throw new Error('所选模型当前不可用，请重新选择');
  if (reasoningEffort && !selected.reasoningEfforts.includes(reasoningEffort)) {
    throw new Error(`${selected.displayName} 不支持所选推理强度`);
  }
}

function wakeState(accountId) {
  return wakeSettings.accountStates[accountId] || {};
}

function updateWakeState(accountId, patch) {
  saveWakeSettings({
    ...wakeSettings,
    accountStates: {
      ...wakeSettings.accountStates,
      [accountId]: { ...wakeState(accountId), ...patch },
    },
  });
}

function recordWakeAttempt(account, trigger, status, error = '') {
  const previous = wakeState(account.id);
  const next = {
    ...previous,
    lastWakeAt: new Date().toISOString(),
    lastWakeStatus: status,
    lastWakeError: String(error || '').slice(0, 500),
  };
  if (trigger === 'daily') next.lastDailyDate = localDateKey();
  if (trigger === 'after-reset') {
    const event = previous.pendingResetEvent;
    if (status === 'success') {
      next.lastHandledResetEventKey = event?.key || previous.lastHandledResetEventKey || '';
      next.pendingResetEvent = null;
      next.lastResetAttemptAt = '';
    } else {
      next.lastResetAttemptAt = next.lastWakeAt;
    }
  }
  saveWakeSettings({
    ...wakeSettings,
    accountStates: { ...wakeSettings.accountStates, [account.id]: next },
  });
}

function runWakeCommand(account) {
  if (!isCodexAuthenticated(account) || account.quotaErrorCode === 'auth_expired') {
    throw new Error('该账号尚未完成 Codex 授权，无法唤醒');
  }
  if (wakeRuns.has(account.id)) throw new Error('该账号正在唤醒，请稍候');
  if (settings.mockLaunch) return Promise.resolve({ output: 'mock wake success' });

  const executable = findCodexCli();
  const { codexDir, codexHomeDir } = accountPaths(account);
  const workspace = path.join(codexDir, 'wake-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  ensureCodexProfileConfig(codexHomeDir);
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--color', 'never', '-C', workspace,
  ];
  if (wakeSettings.model) args.push('--model', wakeSettings.model);
  if (wakeSettings.reasoningEffort) args.push('--config', `model_reasoning_effort="${wakeSettings.reasoningEffort}"`);
  args.push(wakeSettings.prompt);

  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, CODEX_HOME: codexHomeDir, NO_COLOR: '1', TERM: 'dumb' },
    });
    wakeRuns.set(account.id, child);
    const consume = (chunk) => { output = `${output}${chunk}`.slice(-12_000); };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      wakeRuns.delete(account.id);
      if (error) reject(error);
      else resolve({ output });
    };
    child.on('error', (error) => finish(new Error(`无法启动 Codex 唤醒请求：${error.message}`)));
    child.on('exit', (code) => finish(code === 0
      ? null
      : new Error(`Codex 唤醒请求失败（退出码 ${code}）：${output.trim().slice(-600) || '没有返回错误详情'}`)));
    const timeout = setTimeout(() => {
      try { child.kill(); } catch {}
      finish(new Error('Codex 唤醒请求超时，请检查网络或账号状态'));
    }, 120_000);
  });
}

async function wakeAccount(account, trigger = 'manual', operator = '本机用户') {
  try {
    await runWakeCommand(account);
    recordWakeAttempt(account, trigger, 'success');
    audit('account.wake', { accountId: account.id, operator, result: trigger });
    try {
      if (settings.mockLaunch) return accountView(account);
      const { codexHomeDir } = accountPaths(account);
      account.quota = await readCodexQuota(findCodexCli(), codexHomeDir);
      account.quotaError = '';
      account.quotaErrorCode = '';
      account.quotaCheckedAt = account.quota.refreshedAt;
      saveAccounts([...accounts]);
      if (trigger === 'after-reset') updateWakeState(account.id, { quotaObservation: quotaObservation(account.quota) });
    } catch {}
    return accountView(account);
  } catch (error) {
    recordWakeAttempt(account, trigger, 'failed', error.message);
    audit('account.wake.failed', { accountId: account.id, operator, result: error.message });
    throw error;
  }
}

async function refreshQuotaForResetDetection(account) {
  const state = wakeState(account.id);
  const lastProbe = Date.parse(state.lastQuotaProbeAt || '');
  if (Number.isFinite(lastProbe) && Date.now() - lastProbe < 5 * 60_000) return;
  updateWakeState(account.id, { lastQuotaProbeAt: new Date().toISOString() });
  try {
    const { codexHomeDir } = accountPaths(account);
    account.quota = await readCodexQuota(findCodexCli(), codexHomeDir);
    account.quotaError = '';
    account.quotaErrorCode = '';
    account.quotaCheckedAt = account.quota.refreshedAt;
    saveAccounts([...accounts]);
  } catch (error) {
    audit('wake.quota-probe.failed', { accountId: account.id, result: error.message });
  }
}

async function detectResetForAccount(account) {
  const before = wakeState(account.id);
  const previous = before.quotaObservation || quotaObservation(account.quota);
  await refreshQuotaForResetDetection(account);
  const current = quotaObservation(account.quota);
  if (!current) return;
  const event = detectQuotaReset(previous, current);
  const latest = wakeState(account.id);
  const patch = { quotaObservation: current };
  if (event && event.key !== latest.lastHandledResetEventKey && event.key !== latest.pendingResetEvent?.key) {
    patch.pendingResetEvent = event;
    audit('wake.reset.detected', { accountId: account.id, result: event.reason });
  }
  updateWakeState(account.id, patch);
}

async function runScheduledWakes() {
  if (wakeScheduleRunning || !wakeSettings.enabled || wakeSettings.mode === 'manual') return;
  wakeScheduleRunning = true;
  try {
    for (const account of accounts) {
      if (!isCodexAuthenticated(account) || account.quotaErrorCode === 'auth_expired') continue;
      if (wakeSettings.mode === 'after-reset') await detectResetForAccount(account);
      if (!shouldWakeAccount(wakeSettings, account)) continue;
      const lastAttempt = Date.parse(wakeState(account.id).lastResetAttemptAt || '');
      if (wakeSettings.mode === 'after-reset' && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 30 * 60_000) continue;
      try { await wakeAccount(account, wakeSettings.mode, '自动唤醒'); } catch {}
    }
  } finally {
    wakeScheduleRunning = false;
  }
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
  usageTracker?.sync(true);
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

function hasRestorableBrowserSession(browserDir) {
  const sessionDir = path.join(browserDir, 'Default', 'Sessions');
  try {
    if (fs.existsSync(sessionDir) && fs.readdirSync(sessionDir).some((name) => /^(?:Session|Tabs)_/.test(name))) return true;
  } catch {}
  return ['Last Session', 'Last Tabs'].some((name) => fs.existsSync(path.join(browserDir, 'Default', name)));
}

async function launchAccountBrowser(account, url, options = {}) {
  const { browserDir } = accountPaths(account);
  fs.mkdirSync(browserDir, { recursive: true });
  const activePortFile = path.join(browserDir, 'DevToolsActivePort');
  const existingPort = await readLiveChromeDebugPort(activePortFile);
  if (!existingPort) fs.rmSync(activePortFile, { force: true });
  const executable = findBrowser();
  const args = [
    `--user-data-dir=${browserDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--disable-background-mode',
    '--remote-debugging-address=127.0.0.1',
    existingPort ? `--remote-debugging-port=${existingPort}` : '--remote-debugging-port=0',
  ];
  if (options.restoreLastSession && hasRestorableBrowserSession(browserDir)) {
    args.push('--restore-last-session');
  } else {
    const initialUrls = Array.isArray(options.initialUrls) && options.initialUrls.length
      ? options.initialUrls
      : [url];
    args.push('--new-window', ...initialUrls);
  }
  const processPid = await spawnDetached(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  const verifiedPort = existingPort || await waitForChromeDebugPort(activePortFile);
  if (!verifiedPort) {
    throw new Error('独立 Chrome 环境启动后未绑定到对应账号目录');
  }
  return processPid;
}

function readChromeDebugPort(activePortFile) {
  try {
    const [portText] = fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/);
    const port = Number.parseInt(portText, 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
  } catch {
    return 0;
  }
}

async function isChromeDebugPortReady(port) {
  if (!port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(600) });
    return response.ok;
  } catch {
    return false;
  }
}

async function readLiveChromeDebugPort(activePortFile) {
  const port = readChromeDebugPort(activePortFile);
  return await isChromeDebugPortReady(port) ? port : 0;
}

async function waitForChromeDebugPort(activePortFile, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = await readLiveChromeDebugPort(activePortFile);
    if (port) return port;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 0;
}

async function launchAccountBrowserForProtocol(account, options = {}) {
  const { browserDir } = accountPaths(account);
  fs.mkdirSync(browserDir, { recursive: true });
  const activePortFile = path.join(browserDir, 'DevToolsActivePort');
  fs.rmSync(activePortFile, { force: true });
  const executable = findBrowser();
  const browserArgs = [
    `--user-data-dir=${browserDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--disable-background-mode',
    '--window-size=1280,900',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    settings.browserStartUrl,
  ];
  if (options.visibleOffscreen) browserArgs.splice(3, 0, '--window-position=-32000,-32000');
  else browserArgs.splice(3, 0, '--headless=new');
  const processPid = await spawnDetached(executable, browserArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const [portText] = fs.readFileSync(activePortFile, 'utf8').split(/\r?\n/);
      const port = Number.parseInt(portText, 10);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return { processPid, port };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('账号 Chrome 调试通道启动超时，请关闭该账号已有的 Chrome 窗口后重试');
}

function stopProtocolBrowser(browser) {
  const processPid = Number(browser?.processPid);
  if (!Number.isInteger(processPid) || processPid <= 0 || !isProcessAlive(processPid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(processPid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try { process.kill(processPid, 'SIGTERM'); } catch {}
}

async function waitForProtocolBrowserExit(browser, timeoutMs = 5_000) {
  const processPid = Number(browser?.processPid);
  if (!Number.isInteger(processPid) || processPid <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(processPid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(processPid);
}

function transferableWebCookies(cookies) {
  return cookies.filter((cookie) => {
    const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
    return cookie?.name && typeof cookie.value === 'string' && cookie.value
      && (domain === 'chatgpt.com' || domain.endsWith('.chatgpt.com')
        || domain === 'openai.com' || domain.endsWith('.openai.com'));
  });
}

async function exportAccountWebSession(account) {
  const { browserDir } = accountPaths(account);
  const activePortFile = path.join(browserDir, 'DevToolsActivePort');
  let port = await readLiveChromeDebugPort(activePortFile);
  let browser = null;
  try {
    if (!port) {
      browser = await launchAccountBrowserForProtocol(account);
      port = browser.port;
    }
    const cookies = transferableWebCookies(await readProtocolCookies({
      port,
      closeBrowser: Boolean(browser),
    }));
    if (!cookies.some((cookie) => /(?:^|-)next-auth\.session-token$/i.test(cookie.name))) return null;
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      cookies,
    };
  } finally {
    if (browser && !await waitForProtocolBrowserExit(browser, 2_000)) stopProtocolBrowser(browser);
  }
}

async function importAccountWebSession(account, webSession) {
  let browser = null;
  try {
    browser = await launchAccountBrowserForProtocol(account, { visibleOffscreen: true });
    const imported = await injectProtocolCookies({
      port: browser.port,
      cookies: webSession.cookies,
      closeBrowser: true,
      verificationDelayMs: 1_000,
    });
    if (!imported.verified) throw new Error(`网页会话验证失败（HTTP ${imported.status || '未知'}）`);
    if (!await waitForProtocolBrowserExit(browser, 3_000)) stopProtocolBrowser(browser);
    await new Promise((resolve) => setTimeout(resolve, 300));
    browser = await launchAccountBrowserForProtocol(account, { visibleOffscreen: true });
    const persisted = await injectProtocolCookies({
      port: browser.port,
      cookies: [],
      closeBrowser: true,
      verificationDelayMs: 1_000,
    });
    if (!persisted.verified) throw new Error('网页会话写入后未能持久保存');
    account.webLoginComplete = true;
    return true;
  } finally {
    if (browser && !await waitForProtocolBrowserExit(browser, 2_000)) stopProtocolBrowser(browser);
  }
}

function spawnDetached(executable, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, options);
    child.once('spawn', () => {
      child.unref();
      resolve(child.pid);
    });
    child.once('error', reject);
  });
}

async function waitForCodexDesktop(timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = findRunningCodexDesktopPid();
    if (pid) return pid;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function launchCodexDesktop(account) {
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
  const installation = findCodexDesktop();
  activateSharedCodexAuth(account);
  const environment = { ...process.env, CODEX_HOME: SHARED_CODEX_HOME };
  delete environment.CODEX_ELECTRON_USER_DATA_PATH;
  delete environment.CODEX_SQLITE_HOME;
  try {
    return await spawnDetached(installation.executable, [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: environment,
    });
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code) || !installation.appUserModelId) {
      restoreSharedCodexAuth(account.id);
      throw new Error(`Windows 无法启动 Codex（${error.code || '启动失败'}）。请确认 Codex 已正确安装，并检查安全软件的拦截记录。`);
    }
  }

  try {
    await spawnDetached('explorer.exe', [`shell:AppsFolder\\${installation.appUserModelId}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    const processPid = await waitForCodexDesktop();
    if (!processPid) throw new Error('系统已接收启动请求，但没有检测到 Codex 进程');
    return processPid;
  } catch (error) {
    restoreSharedCodexAuth(account.id);
    throw new Error(`Windows 拒绝启动 Codex。请在安全软件中允许 Codex Navo 和 Codex，或先手动启动一次 Codex 后重试。详细信息：${error.message}`);
  }
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

function stopExternalCodexDesktop() {
  if (readActiveCodexAuth()) {
    throw new Error('当前 Codex 由账号池管理，请使用对应账号上的“退出 Codex”按钮');
  }
  const processPid = findRunningCodexDesktopPid();
  if (!processPid) return;
  try { process.kill(processPid, 'SIGTERM'); }
  catch (error) { throw new Error(`无法关闭外部 Codex：${error.message}`); }
  spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Wait-Process -Id ${processPid} -Timeout 8 -ErrorAction SilentlyContinue`], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
  });
  if (isProcessAlive(processPid)) throw new Error('Codex 尚未退出，请关闭窗口后重试');
  audit('codex.desktop.external-stopped', { result: 'user-request' });
}

function cancelPendingCodexLogin(accountId) {
  const pending = pendingCodexLogins.get(accountId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.status = 'error';
  if (pending.child && isProcessAlive(pending.child.pid)) {
    try { pending.child.kill(); } catch {}
  }
  if (pending.flow === 'protocol') stopProtocolBrowser(pending.browser);
  pendingCodexLogins.delete(accountId);
}

function completeCodexLogin(account, operator, pending) {
  if (pending.status === 'complete' || pending.status === 'error') return;
  if (!isCodexAuthenticated(account)) {
    pending.credentialDeadline ||= Date.now() + 5_000;
    if (Date.now() < pending.credentialDeadline) {
      setTimeout(() => completeCodexLogin(account, operator, pending), 150);
      return;
    }
    pending.fail('Codex 登录已返回成功，但没有保存账号凭证，请重新发起授权');
    return;
  }
  pending.status = 'complete';
  clearTimeout(pending.timeout);
  pendingCodexLogins.delete(account.id);
  clearAuthAttempt(account.id);
  account.setupStage = 'complete';
  account.quotaError = '';
  account.quotaErrorCode = '';
  saveAccounts([...accounts]);
  const lease = leases[account.id];
  if (lease?.operator === operator) {
    const next = { ...leases };
    delete next[account.id];
    saveLeases(next);
  }
  audit('codex.login.success', { accountId: account.id, operator, result: 'pooled' });
  if (pending.child && isProcessAlive(pending.child.pid)) {
    try { pending.child.kill(); } catch {}
  }
}

function startCodexBrowserLogin(account, operator) {
  cancelPendingCodexLogin(account.id);
  const { codexHomeDir } = accountPaths(account);
  ensureCodexProfileConfig(codexHomeDir);
  const executable = findCodexCli();
  const child = spawn(executable, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, CODEX_HOME: codexHomeDir, NO_COLOR: '1', TERM: 'dumb' },
  });
  const pending = {
    child,
    operator,
    flow: 'browser',
    status: 'starting',
    authUrl: '',
    loginId: '',
    output: '',
    browserOpened: false,
    startedAt: new Date().toISOString(),
    timeout: null,
    fail: null,
  };
  pendingCodexLogins.set(account.id, pending);
  saveAuthAttempt(account.id, { flow: 'browser', status: 'starting', startedAt: pending.startedAt, error: '' });

  const fail = (message) => {
    if (pending.status === 'complete' || pending.status === 'error') return;
    pending.status = 'error';
    pending.error = message;
    saveAuthAttempt(account.id, { flow: 'browser', status: 'error', error: message });
    clearTimeout(pending.timeout);
    const lease = leases[account.id];
    if (lease?.operator === operator) {
      const next = { ...leases };
      delete next[account.id];
      saveLeases(next);
    }
    audit('codex.login.failed', { accountId: account.id, operator, result: message });
    if (pending.child && isProcessAlive(pending.child.pid)) {
      try { pending.child.kill(); } catch {}
    }
  };
  pending.fail = fail;

  const send = (message) => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      pending.output = `${pending.output}${line}\n`.slice(-12_000);
      return;
    }
    if (message.id === 1) {
      if (message.error) {
        fail(`Codex 登录服务初始化失败：${message.error.message || '未知错误'}`);
        return;
      }
      send({ method: 'initialized', params: {} });
      send({
        method: 'account/login/start',
        id: 2,
        params: { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' },
      });
      return;
    }
    if (message.id === 2) {
      if (message.error) {
        fail(`无法发起 Codex 浏览器授权：${message.error.message || '未知错误'}`);
        return;
      }
      const authUrl = String(message.result?.authUrl || '');
      if (!/^https:\/\/(?:chatgpt\.com|auth\.openai\.com)\//i.test(authUrl)) {
        fail('Codex 登录服务没有返回有效的官方授权地址');
        return;
      }
      pending.authUrl = authUrl;
      pending.loginId = String(message.result?.loginId || '');
      pending.status = 'waiting';
      saveAuthAttempt(account.id, { flow: 'browser', status: 'waiting', error: '' });
      if (!pending.browserOpened) {
        pending.browserOpened = true;
        launchAccountBrowser(account, authUrl)
          .then(() => audit('codex.login.browser-opened', { accountId: account.id, operator, result: 'browser-oauth' }))
          .catch((error) => fail(`无法打开账号独立浏览器：${error.message}`));
      }
      return;
    }
    if (message.method === 'account/login/completed') {
      if (pending.loginId && message.params?.loginId !== pending.loginId) return;
      if (!message.params?.success) {
        fail(message.params?.error || 'Codex 登录授权没有完成');
        return;
      }
      setTimeout(() => completeCodexLogin(account, operator, pending), 150);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { pending.output = `${pending.output}${chunk}`.slice(-12_000); });
  child.stdin.on('error', (error) => fail(`Codex 登录服务通信失败：${error.message}`));
  child.on('error', (error) => fail(`无法启动 Codex 登录服务：${error.message}`));
  child.on('exit', (code) => {
    if (pending.status === 'complete' || pending.status === 'error') return;
    fail(`Codex 登录服务提前退出（退出码 ${code ?? '未知'}）`);
  });
  child.once('spawn', () => {
    send({
      method: 'initialize',
      id: 1,
      params: { clientInfo: { name: 'codex_navo', title: 'Codex Navo', version: APP_VERSION } },
    });
  });
  pending.timeout = setTimeout(() => fail('Codex 浏览器授权已超时，请重新发起登录'), 15 * 60 * 1000);
  return child.pid;
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
    flow: 'device',
    status: 'starting',
    userCode: '',
    deviceUrl: 'https://auth.openai.com/codex/device',
    output: '',
    browserOpened: false,
    startedAt: new Date().toISOString(),
    timeout: null,
  };
  pendingCodexLogins.set(account.id, pending);
  saveAuthAttempt(account.id, { flow: 'device', status: 'starting', startedAt: pending.startedAt, error: '' });

  const fail = (message) => {
    if (pending.status === 'complete' || pending.status === 'error') return;
    pending.status = 'error';
    pending.error = message;
    saveAuthAttempt(account.id, { flow: 'device', status: 'error', error: message });
    clearTimeout(pending.timeout);
    const lease = leases[account.id];
    if (lease?.operator === operator) {
      const next = { ...leases };
      delete next[account.id];
      saveLeases(next);
    }
    audit('codex.login.failed', { accountId: account.id, operator, result: message });
  };
  pending.fail = fail;

  const consume = async (chunk) => {
    pending.output = `${pending.output}${chunk}`.slice(-12_000);
    const plain = pending.output.replace(/\x1b\[[0-9;]*m/g, '');
    const code = plain.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0];
    if (!code || pending.browserOpened) return;
    pending.userCode = code;
    pending.status = 'waiting';
    saveAuthAttempt(account.id, { flow: 'device', status: 'waiting', error: '' });
    pending.browserOpened = true;
    try {
      await launchAccountBrowser(account, pending.deviceUrl);
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
    completeCodexLogin(account, operator, pending);
  });
  pending.timeout = setTimeout(() => {
    fail('Codex 登录验证码已过期，请重新发起授权');
    try { child.kill(); } catch {}
  }, 15 * 60 * 1000);
  return child.pid;
}

async function launchAccount(account, launchType, operator) {
  const { browserDir, codexDir, codexHomeDir, codexDesktopDir, codexSqliteDir } = accountPaths(account);
  fs.mkdirSync(browserDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  if (settings.mockLaunch) return null;

  if (launchType === 'browser') {
    return launchAccountBrowser(account, settings.browserStartUrl, {
      restoreLastSession: true,
      initialUrls: [IP_CHECK_URL, settings.browserStartUrl],
    });
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
    browserType: 'chrome',
    enabled: account.enabled !== false,
    createdAt: account.createdAt,
    quota: account.quota || null,
    codexActive: readActiveCodexAuth()?.accountId === account.id,
    browserInitialized: fs.existsSync(path.join(browserDir, 'Local State')),
    webLoginComplete: account.webLoginComplete === true,
    codexInitialized,
    setupStage: codexInitialized ? 'complete' : account.setupStage || 'web-login',
    quotaError: account.quotaError || '',
    quotaErrorCode: account.quotaErrorCode || '',
    quotaCheckedAt: account.quotaCheckedAt || null,
    authSource: account.authSource || 'local-login',
    loginMethod: account.loginMethod || 'official',
    importedAt: account.importedAt || null,
    health: inspectAccountHealth(account),
    wake: {
      ...wakeState(account.id),
      running: wakeRuns.has(account.id),
    },
    codexLogin: publicAuthAttempt(account.id),
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

async function checkAccountHealth(account, operator) {
  if (!isCodexAuthenticated(account)) return inspectAccountHealth(account);
  try {
    readAccountAuth(account);
    if (!settings.mockLaunch) {
      const { codexHomeDir } = accountPaths(account);
      account.quota = await readCodexQuota(findCodexCli(), codexHomeDir);
      account.quotaCheckedAt = account.quota.refreshedAt;
    }
    account.quotaError = '';
    account.quotaErrorCode = '';
    saveAccounts([...accounts]);
    audit('account.health', { accountId: account.id, operator, result: 'healthy' });
  } catch (error) {
    const authExpired = /401|unauthorized|token_revoked|invalidated oauth/i.test(error.message);
    account.quotaError = authExpired ? '登录已失效，请重新授权' : '授权在线检查失败，请稍后重试';
    account.quotaErrorCode = authExpired ? 'auth_expired' : 'fetch_failed';
    account.quotaCheckedAt = new Date().toISOString();
    saveAccounts([...accounts]);
    audit('account.health', { accountId: account.id, operator, result: error.message });
  }
  return inspectAccountHealth(account);
}

function uniqueImportedLabel(label) {
  const base = String(label || '导入账号').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60) || '导入账号';
  if (!accounts.some((account) => account.label === base)) return base;
  let index = 2;
  while (accounts.some((account) => account.label === `${base} (${index})`)) index += 1;
  return `${base} (${index})`.slice(0, 60);
}

function existingAuthIdentity(identity) {
  if (!identity) return null;
  for (const account of accounts) {
    try {
      if (authIdentity(readAccountAuth(account)) === identity) return account;
    } catch {}
  }
  return null;
}

async function importAuthorizationPackage(envelope, operator) {
  const payload = readAuthPackage(envelope);
  const auth = payload.files?.['auth.json'] || payload.account?.auth;
  const webSession = payload.files?.['web-session.json'] || null;
  const identity = authIdentity(auth);
  const duplicate = existingAuthIdentity(identity);
  if (duplicate) throw new Error(`该 Codex 授权已经存在于“${duplicate.label}”`);
  const account = {
    id: `account-${crypto.randomBytes(6).toString('hex')}`,
    label: uniqueImportedLabel(payload.account?.label),
    emailHint: String(payload.account?.emailHint || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 100),
    browserType: 'chrome',
    enabled: true,
    setupStage: 'complete',
    authSource: 'authorization-package',
    importedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
  const { browserDir, codexDir, codexHomeDir } = accountPaths(account);
  const importStatus = { codex: 'pending', web: webSession ? 'pending' : 'not-included', webError: '' };
  try {
    ensureCodexProfileConfig(codexHomeDir);
    writeJsonAtomic(path.join(codexHomeDir, 'auth.json'), auth);
    if (!settings.mockLaunch) {
      try {
        account.quota = await readCodexQuota(findCodexCli(), codexHomeDir);
        account.quotaCheckedAt = account.quota.refreshedAt;
      } catch (error) {
        if (/401|unauthorized|token_revoked|invalidated oauth/i.test(error.message)) throw error;
        account.quotaError = '授权已导入，但在线检查暂时失败';
        account.quotaErrorCode = 'fetch_failed';
        account.quotaCheckedAt = new Date().toISOString();
      }
    }
    importStatus.codex = 'imported';
    if (webSession) {
      try {
        await importAccountWebSession(account, webSession);
        importStatus.web = 'imported';
        account.authSource = 'authorization-package-web-and-codex';
      } catch (error) {
        importStatus.web = 'failed';
        importStatus.webError = String(error.message || '网页会话验证失败').slice(0, 180);
        account.webLoginComplete = false;
        if (isWithin(BROWSER_PROFILES_DIR, browserDir)) fs.rmSync(browserDir, { recursive: true, force: true });
      }
    }
    saveAccounts([...accounts, account]);
    audit('auth.package.imported', {
      accountId: account.id,
      operator,
      result: importStatus.web === 'imported' ? 'codex-and-web' : `codex-${importStatus.web}`,
    });
    return { account, importStatus };
  } catch (error) {
    if (isWithin(CODEX_PROFILES_DIR, codexDir)) fs.rmSync(codexDir, { recursive: true, force: true });
    throw new Error(`授权包验证失败，未写入账号池：${error.message}`);
  }
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
      usageTracker.sync();
      return sendJson(response, 200, {
        ok: true,
        data: {
          accounts: accounts.map(accountView),
          codexRunning: Boolean(findRunningCodexDesktopPid()),
          csrfToken,
          operators: settings.operators,
          mockLaunch: settings.mockLaunch,
          wakeSettings: publicWakeSettings(),
          wakeModelOptions: wakeModelCatalog(),
          usage: usageTracker.summary('today'),
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/usage') {
      usageTracker.sync();
      return sendJson(response, 200, { ok: true, data: usageTracker.summary(url.searchParams.get('range') || 'today') });
    }

    if (request.method === 'POST' && url.pathname === '/api/wake-settings') {
      const body = await readBody(request);
      const model = String(body.model || '').trim();
      const reasoningEffort = String(body.reasoningEffort || '').trim();
      try { validateWakeModelSelection(model, reasoningEffort); }
      catch (error) { return sendError(response, 400, error.message); }
      const nextAccountStates = { ...wakeSettings.accountStates };
      if (body.enabled === true && body.mode === 'after-reset') {
        for (const account of accounts) {
          const observation = quotaObservation(account.quota);
          if (observation && !nextAccountStates[account.id]?.quotaObservation) {
            nextAccountStates[account.id] = { ...nextAccountStates[account.id], quotaObservation: observation };
          }
        }
      }
      saveWakeSettings({
        ...wakeSettings,
        enabled: body.enabled === true,
        mode: body.mode,
        dailyTime: body.dailyTime,
        model,
        reasoningEffort,
        prompt: body.prompt,
        accountStates: nextAccountStates,
      });
      audit('wake.settings.updated', { result: wakeSettings.enabled ? wakeSettings.mode : 'disabled' });
      return sendJson(response, 200, { ok: true, data: publicWakeSettings() });
    }

    if (request.method === 'POST' && url.pathname === '/api/wake-all') {
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      const targets = accounts.filter((account) => isCodexAuthenticated(account) && account.quotaErrorCode !== 'auth_expired');
      const results = [];
      for (const account of targets) {
        try {
          await wakeAccount(account, 'manual', operator);
          results.push({ accountId: account.id, ok: true });
        } catch (error) {
          results.push({ accountId: account.id, ok: false, error: error.message });
        }
      }
      return sendJson(response, 200, {
        ok: true,
        data: { total: targets.length, succeeded: results.filter((item) => item.ok).length, results },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/codex/quit-external') {
      const body = await readBody(request);
      requireOperator(body.operator);
      try {
        stopExternalCodexDesktop();
        return sendJson(response, 200, { ok: true });
      } catch (error) {
        return sendError(response, 409, error.message);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/accounts/health-all') {
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      const results = [];
      for (const account of accounts) {
        results.push({ accountId: account.id, health: await checkAccountHealth(account, operator) });
      }
      return sendJson(response, 200, { ok: true, data: { results, accounts: accounts.map(accountView) } });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth-packages/import') {
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      try {
        const envelope = typeof body.package === 'string' ? JSON.parse(body.package) : body.package;
        const imported = await importAuthorizationPackage(envelope, operator);
        return sendJson(response, 201, { ok: true, data: {
          account: accountView(imported.account),
          importStatus: imported.importStatus,
        } });
      } catch (error) {
        return sendError(response, /已经存在/.test(error.message) ? 409 : 400, error.message);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/accounts') {
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      const label = String(body.label || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60);
      if (!label) return sendError(response, 400, '请输入账号名称');
      const loginMethod = body.loginMethod === 'protocol' ? 'protocol' : 'official';
      const account = {
        id: `account-${crypto.randomBytes(6).toString('hex')}`,
        label,
        emailHint: String(body.emailHint || '').replace(/[\r\n\t]/g, ' ').trim().slice(0, 100),
        browserType: 'chrome',
        loginMethod,
        webLoginComplete: false,
        enabled: true,
        setupStage: 'oauth',
        createdAt: new Date().toISOString(),
      };
      saveAccounts([...accounts, account]);
      audit('account.add', { accountId: account.id, operator });
      if (!settings.mockLaunch) {
        const result = acquireLease(leases, account.id, operator, 'setup');
        saveLeases(result.leases);
        try {
          const processPid = loginMethod === 'protocol'
            ? await startProtocolLogin(account, operator)
            : startCodexBrowserLogin(account, operator);
          result.lease.processPid = processPid;
          saveLeases({ ...leases, [account.id]: result.lease });
          audit('codex.login.started', { accountId: account.id, operator, result: loginMethod === 'protocol' ? 'account-create-protocol' : 'account-create-browser-oauth' });
        } catch (error) {
          const next = { ...leases };
          delete next[account.id];
          saveLeases(next);
          audit('codex.login.failed', { accountId: account.id, operator, result: error.message });
          return sendError(response, 500, `账号已创建，但登录授权未启动：${error.message}`);
        }
      }
      return sendJson(response, 201, { ok: true, data: accountView(account) });
    }

    const match = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)\/(launch|release|toggle|authorize|authorize-device|authorize-protocol|protocol-input|cancel-authorization|quota|health|export-auth|wake|quit-codex)$/);
    if (match && request.method === 'POST') {
      const [, accountId, operation] = match;
      if (!validateAccountId(accountId)) return sendError(response, 400, '账号 ID 无效');
      const account = accounts.find((item) => item.id === accountId);
      if (!account) return sendError(response, 404, '账号不存在');
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      cleanLeases();

      if (operation === 'protocol-input') {
        const pending = pendingCodexLogins.get(accountId);
        if (!pending || pending.flow !== 'protocol' || pending.status !== 'waiting' || !pending.promptKind) {
          return sendError(response, 409, '当前协议登录没有等待输入');
        }
        try {
          const value = validateProtocolInput(pending.promptKind, body.value);
          if (pending.child.stdin.destroyed) throw new Error('协议登录输入通道已关闭');
          pending.child.stdin.write(`${value}\n`);
          pending.status = 'starting';
          pending.promptKind = '';
          pending.promptLabel = '';
          pending.promptHint = '';
          pending.promptSecret = false;
          pending.output = '';
          saveAuthAttempt(accountId, { method: 'protocol', flow: 'protocol', status: 'starting', promptKind: '', promptLabel: '', promptHint: '', promptSecret: false, error: '' });
          return sendJson(response, 200, { ok: true, data: accountView(account) });
        } catch (error) {
          return sendError(response, 400, error.message);
        }
      }

      if (operation === 'health') {
        const health = await checkAccountHealth(account, operator);
        return sendJson(response, 200, { ok: true, data: { health, account: accountView(account) } });
      }

      if (operation === 'export-auth') {
        try {
          const auth = readAccountAuth(account);
          let webSession = null;
          try {
            webSession = await exportAccountWebSession(account);
          } catch (error) {
            audit('auth.package.web-export-failed', { accountId, operator, result: error.message });
          }
          const files = { 'auth.json': auth };
          if (webSession) files['web-session.json'] = webSession;
          const authorizationPackage = createAuthPackage({
            manifest: {
              type: 'codex-navo-account-transfer',
              schemaVersion: 2,
              createdAt: new Date().toISOString(),
              appVersion: APP_VERSION,
            },
            account: { label: account.label, emailHint: account.emailHint || '', authSource: account.authSource || 'local-login' },
            identity: { fingerprint: authIdentity(auth) },
            files,
          });
          const safeName = account.label.replace(/[^a-z0-9\u4e00-\u9fff_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'codex-account';
          audit('auth.package.exported', { accountId, operator, result: webSession ? 'codex-and-web' : 'codex-only' });
          return sendJson(response, 200, { ok: true, data: {
            fileName: `${safeName}.codexnavo`,
            package: authorizationPackage,
            webSessionIncluded: Boolean(webSession),
          } });
        } catch (error) {
          return sendError(response, 400, error.message);
        }
      }

      if (operation === 'cancel-authorization') {
        const attempt = authAttempts[accountId];
        if (attempt?.flow === 'protocol' && Number.isInteger(attempt.processPid)) {
          spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${attempt.processPid} -Force -ErrorAction SilentlyContinue`], { windowsHide: true });
        }
        cancelPendingCodexLogin(accountId);
        if (attempt?.flow === 'protocol') cleanupProtocolLoginFiles(protocolLoginPaths(account));
        clearAuthAttempt(accountId);
        const next = { ...leases };
        delete next[accountId];
        saveLeases(next);
        audit('codex.login.cancelled', { accountId, operator, result: 'user-request' });
        return sendJson(response, 200, { ok: true, data: accountView(account) });
      }

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

      if (operation === 'wake') {
        try {
          const data = await wakeAccount(account, 'manual', operator);
          return sendJson(response, 200, { ok: true, data });
        } catch (error) {
          return sendError(response, 502, error.message);
        }
      }

      if (operation === 'authorize' || operation === 'authorize-device' || operation === 'authorize-protocol') {
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
          const useDeviceCode = operation === 'authorize-device';
          const useProtocol = operation === 'authorize-protocol';
          account.setupStage = useDeviceCode ? 'device-auth' : 'oauth';
          account.loginMethod = useProtocol ? 'protocol' : account.loginMethod || 'official';
          saveAccounts([...accounts]);
          const processPid = useDeviceCode
            ? startCodexDeviceLogin(account, operator)
            : useProtocol
              ? await startProtocolLogin(account, operator)
              : startCodexBrowserLogin(account, operator);
          result.lease.processPid = processPid;
          saveLeases({ ...leases, [accountId]: result.lease });
          audit('codex.login.started', { accountId, operator, result: useDeviceCode ? 'device-fallback' : useProtocol ? 'protocol-retry' : 'browser-oauth-retry' });
          return sendJson(response, 200, { ok: true, data: accountView(account) });
        } catch (error) {
          account.setupStage = 'oauth';
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
        clearAuthAttempt(accountId);
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
        const processPid = await launchAccount(account, launchType, operator);
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
      clearAuthAttempt(accountId);
      const nextWakeStates = { ...wakeSettings.accountStates };
      delete nextWakeStates[accountId];
      saveWakeSettings({ ...wakeSettings, accountStates: nextWakeStates });
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
  if (process.env.CODEX_MANAGER_NO_OPEN === '1') console.log('\nCodex Navo 已启动（测试模式）。\n');
  else console.log(`\nCodex Navo 已启动：\n${url}\n`);
  console.log('此窗口用于运行本地服务，使用完毕后可以关闭。');
  if (process.env.CODEX_MANAGER_NO_OPEN !== '1') {
    const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  setTimeout(runScheduledWakes, 5_000).unref?.();
});

const wakeScheduleTimer = setInterval(runScheduledWakes, 60_000);
wakeScheduleTimer.unref?.();

const protocolLoginTimer = setInterval(pollProtocolLoginResults, 2_000);
protocolLoginTimer.unref?.();

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

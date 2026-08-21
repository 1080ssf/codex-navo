const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { ProxyAgent } = require('undici');
const {
  acquireLease,
  cleanExpiredLeases,
  isWithin,
  normalizeOperator,
  validateAccountId,
} = require('./lib/core');
const { hasSpendableCredits, readCodexModels, readCodexQuota, warmCodexAppServer } = require('./lib/codex-quota');
const { CodexUsageTracker } = require('./lib/codex-usage');
const { readModelCatalog } = require('./lib/model-catalog');
const { detectQuotaReset, localDateKey, normalizeWakeSettings, quotaObservation, shouldWakeAccount } = require('./lib/wake');
const { authIdentity, createAuthPackage, isNonRefreshableWebSessionAuth, readAuthPackage, validateAuthPayload } = require('./lib/auth-package');
const {
  injectProtocolCookies,
  navigateProtocolPage,
  protocolPromptFromOutput,
  readProtocolCookies,
  readProtocolSubscription,
  readProtocolOauthExport,
  readProtocolSession,
  resolveProtocolProxyEnvironment,
  validateProtocolInput,
} = require('./lib/protocol-login');
const {
  applyProxyEnvironment,
  normalizeProxySettings,
  publicProxySettings,
  testProxyConnection,
} = require('./lib/codex-proxy');
const { AccountNetworkManager } = require('./lib/account-network');
const { StableProxyRelay } = require('./lib/stable-proxy-relay');
const { ApiServiceManager, MAX_RESPONSE_BYTES, extractUsage, usageForLocalDate } = require('./lib/api-service');
const {
  chatToResponses,
  responsesToChat,
  responsesSseToJson,
  createResponsesSseTransform,
  createChatSseTransform,
} = require('./lib/openai-compat');
const { CodexSessionMonitor } = require('./lib/session-monitor');
const { NotificationService } = require('./lib/notification-service');
const {
  acquireCodexConfigLock,
  repairSharedCodexConfig,
  repairSharedCodexThreadCatalog,
  releaseCodexConfigLock,
} = require('./lib/codex-runtime-state');
const {
  listCodexLaunchOptions,
  normalizeLaunchSelection,
  optimizeSelectedRollouts,
  prepareLaunchView,
  pruneMissingLocalProjects,
  restoreLaunchView,
  withDesktopLocale,
} = require('./lib/codex-launch-view');
const { applyDesktopLocaleBridge } = require('./lib/codex-desktop-locale');
const { combinedAccountQuota } = require('./lib/api-account-quota');
const { createUsageTap } = require('./lib/usage-stream');
const { codexUpstreamHeaders } = require('./lib/codex-upstream-headers');
const { resolveChromeDebugPort } = require('./lib/browser-debug-session');
const { requestShape, upstreamMessage } = require('./lib/upstream-error');
const { parseRelayAccountPackage } = require('./lib/relay-account-import');
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
const PROXY_SETTINGS_FILE = path.join(CONFIG_DIR, 'proxy-settings.json');
const WAKE_SETTINGS_FILE = path.join(CONFIG_DIR, 'wake-settings.json');
const NOTIFICATION_SETTINGS_FILE = path.join(CONFIG_DIR, 'notification-settings.json');
const LEASES_FILE = path.join(DATA_DIR, 'leases.json');
const ACCESS_TOKEN_FILE = path.join(DATA_DIR, 'access-token.txt');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');
const PID_FILE = path.join(DATA_DIR, 'server.pid');
const ACTIVE_CODEX_AUTH_FILE = path.join(DATA_DIR, 'active-codex-auth.json');
const ACTIVE_API_CODEX_FILE = path.join(DATA_DIR, 'active-api-codex.json');
const CODEX_USAGE_FILE = path.join(DATA_DIR, 'codex-usage.json');
const DISMISSED_SESSIONS_FILE = path.join(DATA_DIR, 'dismissed-sessions.json');
const AUTH_ATTEMPTS_FILE = path.join(DATA_DIR, 'auth-attempts.json');
const SHARED_CODEX_HOME = process.env.CODEX_MANAGER_MOCK_LAUNCH === '1'
  ? path.join(RUNTIME_ROOT, 'shared-codex')
  : path.join(os.homedir(), '.codex');
const SHARED_CODEX_AUTH_FILE = path.join(SHARED_CODEX_HOME, 'auth.json');
const SHARED_AUTH_BACKUP_DIR = path.join(CODEX_PROFILES_DIR, '_shared');
const SHARED_AUTH_BACKUP_FILE = path.join(SHARED_AUTH_BACKUP_DIR, 'original-auth.json');
const API_SHARED_BACKUP_DIR = path.join(CODEX_PROFILES_DIR, '_api-shared');
const API_SHARED_CONFIG_BACKUP_FILE = path.join(API_SHARED_BACKUP_DIR, 'original-config.toml');
const API_SHARED_AUTH_BACKUP_FILE = path.join(API_SHARED_BACKUP_DIR, 'original-auth.json');
const API_SHARED_CONFIG_LOCK_FILE = path.join(API_SHARED_BACKUP_DIR, 'config.lock');
const LAUNCH_VIEW_ROOT = path.join(CODEX_PROFILES_DIR, '_launch-view');
const ROLLOUT_BACKUP_ROOT = path.join(SHARED_CODEX_HOME, 'navo-rollout-backups');
const IP_CHECK_URL = 'https://ipip.la/';
const CHATGPT_LOGIN_URL = 'https://chatgpt.com/auth/login?next=/';
const CHATGPT_CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

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

function removeLegacyCodexNavoHooks() {
  const hooksFile = path.join(SHARED_CODEX_HOME, 'hooks.json');
  try {
    const config = readJson(hooksFile, null);
    if (config?.hooks && typeof config.hooks === 'object') {
      let changed = false;
      for (const [eventName, entries] of Object.entries(config.hooks)) {
        if (!Array.isArray(entries)) continue;
        const kept = entries.filter((entry) => !JSON.stringify(entry).includes('codex-navo-hook.ps1'));
        if (kept.length !== entries.length) {
          config.hooks[eventName] = kept;
          changed = true;
        }
      }
      if (changed) writeJsonAtomic(hooksFile, config);
    }
  } catch {}
  try { fs.rmSync(path.join(DATA_DIR, 'hooks', 'codex-navo-hook.ps1'), { force: true }); } catch {}
}

removeLegacyCodexNavoHooks();

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
let proxySettings = normalizeProxySettings(readJson(PROXY_SETTINGS_FILE, {}));
let accounts = readJson(ACCOUNTS_FILE, []);
const networkManager = new AccountNetworkManager({ runtimeRoot: RUNTIME_ROOT, audit });
const configuredApiGatewayPort = Number.parseInt(process.env.CODEX_NAVO_API_PORT || '', 10);
const API_GATEWAY_PORT = Number.isInteger(configuredApiGatewayPort) && configuredApiGatewayPort > 0 && configuredApiGatewayPort <= 65_535
  ? configuredApiGatewayPort
  : 18300;
const API_CODEX_PROXY_PORT = 18301;
const apiCodexProxyRelay = new StableProxyRelay({ port: API_CODEX_PROXY_PORT });
const MAX_API_REQUEST_BYTES = 64 * 1024 * 1024;
const apiServiceManager = new ApiServiceManager({
  runtimeRoot: RUNTIME_ROOT,
  writeJsonAtomic,
  readJson,
  audit,
  gatewayPort: API_GATEWAY_PORT,
});
const sessionMonitor = new CodexSessionMonitor({ codexHome: SHARED_CODEX_HOME, dismissedFile: DISMISSED_SESSIONS_FILE });
const notificationService = new NotificationService({
  file: NOTIFICATION_SETTINGS_FILE,
  writeJsonAtomic,
  readJson,
  audit,
});
sessionMonitor.on('terminal', (event) => {
  notificationService.notify(event).catch((error) => audit('notification.failed', { result: error.message }));
});
sessionMonitor.on('error', (error) => audit('sessions.monitor.failed', { result: error.message }));
apiServiceManager.ensureAccountPool(wakeModelCatalog().map((item) => item.slug));
if (!apiServiceManager.config.enabled) apiServiceManager.saveConfig({ enabled: true });
let wakeSettings = normalizeWakeSettings(readJson(WAKE_SETTINGS_FILE, {}));
let leases = Object.fromEntries(Object.entries(readJson(LEASES_FILE, {})).map(([accountId, lease]) => [
  accountId,
  { ...lease, operator: '本机用户' },
]));
let authAttempts = readJson(AUTH_ATTEMPTS_FILE, {});
for (const [accountId, attempt] of Object.entries(authAttempts)) {
  if (!validateAccountId(accountId) || !attempt || typeof attempt !== 'object') {
    delete authAttempts[accountId];
  } else if (['starting', 'waiting', 'finalizing', 'web-login'].includes(attempt.status)) {
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
const browserWebLoginWatchers = new Map();
const accountPoolRefreshes = new Map();
const accountPoolLastUsed = new Map();
const accountPoolCooldowns = new Map();
const accountModelCapabilities = new Map();
const protocolLoginImports = new Set();
const wakeRuns = new Map();
let wakeScheduleRunning = false;
let usageTracker = null;
const csrfToken = crypto.randomBytes(24).toString('base64url');

function saveProxySettings(value) {
  proxySettings = normalizeProxySettings(value, proxySettings);
  writeJsonAtomic(PROXY_SETTINGS_FILE, proxySettings);
  return publicProxySettings(proxySettings);
}

function codexEnvironment(environment = process.env, account = null) {
  const directEnvironment = applyProxyEnvironment(environment, { enabled: false });
  const base = account ? directEnvironment : applyProxyEnvironment(directEnvironment, proxySettings);
  const next = account ? networkManager.environment(account.id, base) : base;
  // A managed account route needs ALL_PROXY for Codex's native/realtime
  // transport. Direct launches still filter unrelated machine-wide settings.
  if (!account) {
    delete next.ALL_PROXY;
    delete next.all_proxy;
  }
  next.NO_PROXY = next.NO_PROXY || next.no_proxy || 'localhost,127.0.0.1,::1,.localhost,0.0.0.0';
  next.no_proxy = next.NO_PROXY;
  return next;
}

function apiCodexEnvironment(environment = process.env, secret) {
  const next = applyProxyEnvironment(environment, { enabled: false });
  next.CODEX_HOME = SHARED_CODEX_HOME;
  next.OPENAI_API_KEY = secret;
  // API Codex only talks to the local Navo gateway. Inheriting the parent
  // Codex/Clash route can point Chromium or app-server at a dead per-account
  // port. Electron UI state remains local to this launch environment.
  delete next.CODEX_ELECTRON_USER_DATA_PATH;
  delete next.CODEX_SQLITE_HOME;
  next.NO_PROXY = 'localhost,127.0.0.1,::1,.localhost,0.0.0.0';
  next.no_proxy = next.NO_PROXY;
  return next;
}

async function prepareAccountNetwork(account, { preflight = false, purpose = '访问 OpenAI' } = {}) {
  const runtime = await networkManager.ensureAccount(account.id);
  if (!runtime || !preflight) return runtime;
  const result = await networkManager.preflightAccount(account.id, 12_000);
  if (!result.ok) {
    const status = result.httpStatus ? `HTTP ${result.httpStatus}` : result.status;
    throw new Error(`${purpose}前的代理检测未通过：${result.message}（${status}）`);
  }
  return runtime;
}

async function backgroundTaskRuntime() {
  let preferredAccountId = '';
  try {
    const snapshot = detectCodexDesktopSnapshot();
    if (snapshot.pid) {
      const activeApi = readActiveApiCodex();
      preferredAccountId = activeApi?.keyId
        ? apiKeyNetworkId(activeApi.keyId)
        : readActiveCodexAuth()?.accountId || '';
    }
  } catch {}
  return networkManager.ensureTask(preferredAccountId);
}

async function backgroundTaskEnvironment(environment = process.env) {
  const runtime = await backgroundTaskRuntime();
  return networkManager.environmentForRuntime(runtime, { ...environment });
}

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

let codexLaunchTransaction = null;
let codexLaunchProgress = {
  active: false, kind: '', label: '', stage: 'idle', message: '', percent: 0,
  startedAt: null, updatedAt: null, completedAt: null, error: '',
};

function setCodexLaunchProgress(patch = {}) {
  codexLaunchProgress = { ...codexLaunchProgress, ...patch, updatedAt: new Date().toISOString() };
  return { ...codexLaunchProgress };
}

function startCodexLaunchProgress(kind, label) {
  const now = new Date().toISOString();
  return setCodexLaunchProgress({
    active: true, kind, label: String(label || 'Codex').slice(0, 100), stage: 'preparing',
    message: '正在准备启动环境…', percent: 6, startedAt: now, completedAt: null, error: '',
  });
}

function completeCodexLaunchProgress() {
  return setCodexLaunchProgress({ active: false, stage: 'complete', message: 'Codex 已打开', percent: 100, completedAt: new Date().toISOString(), error: '' });
}

function failCodexLaunchProgress(error) {
  const message = String(error?.message || error || '启动失败').replace(/[\r\n]/g, ' ').slice(0, 300);
  return setCodexLaunchProgress({ active: false, stage: 'error', message, completedAt: new Date().toISOString(), error: message });
}

function beginCodexLaunchTransaction(kind) {
  if (codexLaunchTransaction) {
    throw new Error(`Codex 正在执行${codexLaunchTransaction}，请稍后再试`);
  }
  codexLaunchTransaction = kind;
}

function endCodexLaunchTransaction(kind) {
  if (codexLaunchTransaction === kind) codexLaunchTransaction = null;
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

function terminalSafeText(value) {
  return String(value || '').replace(/[^\x20-\x7E\r\n\t]/gu, (character) => {
    const codePoint = character.codePointAt(0).toString(16).padStart(4, '0');
    return `\\u{${codePoint}}`;
  });
}

function sendOpenAiError(response, statusCode, message, type = 'invalid_request_error', code = null) {
  response.writeHead(statusCode, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
  response.end(JSON.stringify({ error: { message, type, param: null, code } }));
}

function createGatewayAbort(request, response, timeoutMs = 10 * 60_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('API 请求超时'), { code: 'request_timeout' })), timeoutMs);
  timer.unref?.();
  const abortDisconnected = () => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(Object.assign(new Error('API 客户端已断开'), { code: 'client_disconnected' }));
    }
  };
  request.once('aborted', abortDisconnected);
  response.once('close', abortDisconnected);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      request.off('aborted', abortDisconnected);
      response.off('close', abortDisconnected);
    },
  };
}

async function readRawBody(request, maxBytes = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

function readBody(request, maxBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
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
      "$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($package) { $applicationId = (Get-AppxPackageManifest -Package $package.PackageFullName).Package.Applications.Application.Id | Select-Object -First 1; [PSCustomObject]@{ InstallLocation = $package.InstallLocation; AppUserModelId = \"$($package.PackageFamilyName)!$applicationId\"; Version = $package.Version.ToString() } | ConvertTo-Json -Compress }",
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
  return { executable, appUserModelId: String(packageInfo?.AppUserModelId || '').trim(), version: String(packageInfo?.Version || '').trim() };
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

const CODEX_PROCESS_CACHE_MS = 1_500;
let lastCodexDesktopAttemptAt = 0;
let lastCodexDesktopSnapshot = { pid: null, reliable: false, checkedAt: 0 };

function runCodexDesktopProcessQuery(command, timeout) {
  const query = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout },
  );
  if (query.error || query.status !== 0) {
    const error = new Error(query.error?.message || String(query.stderr || '').trim() || 'process query failed');
    error.code = query.error?.code || `EXIT_${query.status}`;
    throw error;
  }
  const output = String(query.stdout || '').trim();
  if (!output) return null;
  const value = JSON.parse(output);
  const pid = Number(value.ProcessId ?? value.Id);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const commandLine = String(value.CommandLine || '');
  return {
    pid,
    parentPid: Number(value.ParentProcessId) || null,
    createdAt: String(value.CreationDate || value.StartTime || ''),
    executablePath: String(value.ExecutablePath || value.Path || ''),
    commandLine,
    commandLineHash: commandLine ? crypto.createHash('sha256').update(commandLine).digest('hex') : '',
  };
}

function auditUpstreamFailure(status, model, body, message) {
  const shape = requestShape(body);
  audit('api.upstream.failed', {
    result: [
      `HTTP ${status}`,
      String(model || 'unknown'),
      `stream=${Number(shape.stream)}`,
      `store=${Number(shape.store)}`,
      `items=${shape.inputItems}`,
      `cacheKey=${Number(shape.hasCacheKey)}`,
      `breakpoint=${Number(shape.hasBreakpoint)}`,
      String(message || ''),
    ].join(' '),
  });
}

function codexProcessIdentity(snapshot) {
  if (!snapshot?.pid) return null;
  return {
    pid: snapshot.pid,
    parentPid: snapshot.parentPid || null,
    createdAt: snapshot.createdAt || '',
    executablePath: snapshot.executablePath || '',
    commandLineHash: snapshot.commandLineHash || '',
  };
}

function codexProcessIdentityMatches(expected, snapshot) {
  if (!expected || !snapshot?.pid || Number(expected.pid) !== Number(snapshot.pid)) return false;
  if (expected.parentPid && snapshot.parentPid && Number(expected.parentPid) !== Number(snapshot.parentPid)) return false;
  if (expected.createdAt && snapshot.createdAt && expected.createdAt !== snapshot.createdAt) return false;
  if (expected.commandLineHash && snapshot.commandLineHash && expected.commandLineHash !== snapshot.commandLineHash) return false;
  if (expected.executablePath && snapshot.executablePath
    && path.normalize(expected.executablePath).toLowerCase() !== path.normalize(snapshot.executablePath).toLowerCase()) return false;
  return true;
}

function detectCodexDesktopSnapshot({ preferCache = true } = {}) {
  const now = Date.now();
  if (preferCache && now - lastCodexDesktopAttemptAt < CODEX_PROCESS_CACHE_MS) {
    return { ...lastCodexDesktopSnapshot, cached: true };
  }
  lastCodexDesktopAttemptAt = now;

  const queries = [
    {
      command: "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe' OR Name = 'codex.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '(?:^|\\s)(?:app-server|login|exec|resume|fork|mcp|cloud)(?:\\s|$)' } | Sort-Object @{e={if ($_.Name -eq 'ChatGPT.exe') {0} else {1}}},CreationDate | Select-Object -First 1 ProcessId,ParentProcessId,@{n='CreationDate';e={$_.CreationDate.ToUniversalTime().ToString('o')}},ExecutablePath,CommandLine | ConvertTo-Json -Compress",
      timeout: 3_000,
    },
    {
      command: "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1 Id,@{n='StartTime';e={$_.StartTime.ToUniversalTime().ToString('o')}},Path | ConvertTo-Json -Compress",
      timeout: 2_000,
    },
  ];
  let lastError = null;
  for (const query of queries) {
    try {
      const processSnapshot = runCodexDesktopProcessQuery(query.command, query.timeout);
      const snapshot = { ...processSnapshot, pid: processSnapshot?.pid || null, reliable: true, checkedAt: Date.now() };
      lastCodexDesktopSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      lastError = error;
    }
  }

  const stalePid = lastCodexDesktopSnapshot.pid && isProcessAlive(lastCodexDesktopSnapshot.pid)
    ? lastCodexDesktopSnapshot.pid
    : null;
  lastCodexDesktopSnapshot = {
    ...lastCodexDesktopSnapshot,
    pid: stalePid,
    reliable: false,
    cached: true,
    error: lastError?.message || 'process query failed',
  };
  return lastCodexDesktopSnapshot;
}

function findRunningCodexDesktopPid() {
  const snapshot = detectCodexDesktopSnapshot({ preferCache: false });
  if (!snapshot.reliable) throw new Error('无法检查 Codex 桌面端运行状态，请稍后重试');
  return snapshot.pid;
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
  const environment = resolveProtocolProxyEnvironment(codexEnvironment({
    ...process.env,
    NODE_NO_WARNINGS: '1',
    NO_COLOR: '1',
    TERM: 'dumb',
  }, account));
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
      let completionBrowser = pending.browser;
      if (!completionBrowser || !await isChromeDebugPortReady(completionBrowser.port)) {
        completionBrowser = await launchAccountBrowserForProtocol(account);
        pending.browser = completionBrowser;
      }
      await injectProtocolCookies({ port: completionBrowser.port, cookies: session.cookies, allowHeadlessBlocked: true, closeBrowser: true });
      const { codexHomeDir } = accountPaths(account);
      ensureCodexProfileConfig(codexHomeDir);
      writeJsonAtomic(path.join(codexHomeDir, 'auth.json'), validateAuthPayload(oauth.auth));
      stopProtocolBrowser(completionBrowser);
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

function accountAuthFile(account) {
  const { codexDir, codexHomeDir } = accountPaths(account);
  const current = path.join(codexHomeDir, 'auth.json');
  const legacy = path.join(codexDir, 'auth.json');
  return fs.existsSync(current) ? current : fs.existsSync(legacy) ? legacy : current;
}

function isCodexAuthenticated(account) {
  const file = accountAuthFile(account);
  if (!fs.existsSync(file)) return false;
  try {
    const auth = validateAuthPayload(readJson(file, null), { allowTemporary: true });
    const temporary = isNonRefreshableWebSessionAuth(auth);
    if (temporary && account.accountKind === 'relay') {
      const expiresAt = Number(decodeJwtClaims((auth.tokens || auth).access_token).exp) * 1000;
      return !Number.isFinite(expiresAt) || expiresAt > Date.now();
    }
    return !temporary;
  } catch {
    return false;
  }
}

function readAccountAuth(account) {
  const file = accountAuthFile(account);
  if (!fs.existsSync(file)) throw new Error('该账号还没有 Codex 授权');
  const auth = readJson(file, null);
  return validateAuthPayload(auth, { allowTemporary: true });
}

function decodeJwtClaims(token) {
  try {
    const segment = String(token || '').split('.')[1];
    return segment ? JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) : {};
  } catch { return {}; }
}

function accountIdFromAuth(auth) {
  const tokens = auth?.tokens || auth || {};
  const claims = decodeJwtClaims(tokens.id_token || tokens.access_token);
  return String(tokens.account_id || auth?.account_id || claims.chatgpt_account_id
    || claims['https://api.openai.com/auth']?.chatgpt_account_id || '').trim();
}

function accessTokenNeedsRefresh(auth, leewaySeconds = 300) {
  const tokens = auth?.tokens || auth || {};
  const exp = Number(decodeJwtClaims(tokens.access_token).exp) || 0;
  return !exp || exp <= Math.floor(Date.now() / 1000) + leewaySeconds;
}

async function refreshAccountPoolAuth(account, auth, dispatcher) {
  const existing = accountPoolRefreshes.get(account.id);
  if (existing) return existing;
  const promise = (async () => {
    const tokens = auth?.tokens || auth || {};
    if (!tokens.refresh_token || isNonRefreshableWebSessionAuth(auth)) {
      throw Object.assign(new Error('账号需要重新完成官方 Codex 授权'), { statusCode: 401 });
    }
    const response = await fetch(OPENAI_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: tokens.client_id || CODEX_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(30_000),
      ...(dispatcher ? { dispatcher } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw Object.assign(new Error(response.status === 400 || response.status === 401
        ? '账号授权已过期，请重新登录'
        : `账号授权刷新失败（HTTP ${response.status}）`), { statusCode: response.status === 400 ? 401 : 502 });
    }
    const next = {
      ...auth,
      auth_mode: auth.auth_mode || 'chatgpt',
      tokens: {
        ...tokens,
        access_token: payload.access_token,
        refresh_token: payload.refresh_token || tokens.refresh_token,
        id_token: payload.id_token || tokens.id_token,
      },
      last_refresh: new Date().toISOString(),
    };
    const nextAccountId = accountIdFromAuth(next);
    if (nextAccountId) next.tokens.account_id = nextAccountId;
    writeJsonAtomic(accountAuthFile(account), next);
    audit('api.pool.auth-refreshed', { accountId: account.id, result: 'success' });
    return next;
  })().finally(() => accountPoolRefreshes.delete(account.id));
  accountPoolRefreshes.set(account.id, promise);
  return promise;
}

function accountRemainingPercent(account) {
  const windows = Array.isArray(account.quota?.windows) ? account.quota.windows : [];
  const values = windows.map((item) => Number(item.remainingPercent)).filter(Number.isFinite);
  return values.length ? Math.min(...values) : 50;
}

function accountHasUsableQuota(account) {
  return accountRemainingPercent(account) > 0 || hasSpendableCredits(account.quota?.credits);
}

function accountPoolCandidates(accountIds = [], model = '') {
  const now = Date.now();
  const eligible = accounts.filter((account) => account.enabled !== false && isCodexAuthenticated(account)
    && account.quotaErrorCode !== 'auth_expired' && accountHasUsableQuota(account)
    && (accountPoolCooldowns.get(account.id) || 0) <= now);
  const requestedModel = String(model || '').split('/').pop();
  const supportsModel = (account) => {
    const known = accountModelCapabilities.get(account.id);
    return !requestedModel || !known || known.has(requestedModel);
  };
  if (Array.isArray(accountIds) && accountIds.length) {
    const byId = new Map(eligible.map((account) => [account.id, account]));
    return accountIds.map((id) => byId.get(id)).filter((account) => account && supportsModel(account));
  }
  return eligible.filter(supportsModel).sort((left, right) => accountRemainingPercent(right) - accountRemainingPercent(left)
      || (accountPoolLastUsed.get(left.id) || 0) - (accountPoolLastUsed.get(right.id) || 0)
      || String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
}

function apiKeyNetworkId(keyId) {
  return `api-key-${keyId}`;
}

async function apiKeyNetworkRuntime(keyId) {
  return networkManager.ensureAccount(apiKeyNetworkId(keyId));
}

async function prepareApiKeyNetwork(keyId, { preflight = false, purpose = '启动 API Codex' } = {}) {
  const networkId = apiKeyNetworkId(keyId);
  const runtime = await networkManager.ensureAccount(networkId);
  if (!preflight) return runtime;
  const result = await networkManager.preflightAccount(networkId, 12_000);
  if (!result.ok) {
    const status = result.httpStatus ? `HTTP ${result.httpStatus}` : result.status;
    throw new Error(`${purpose}前的代理检测未通过：${result.message}（${status}）`);
  }
  return runtime;
}

async function apiKeyTaskEnvironment(keyId, environment = process.env) {
  const runtime = await apiKeyNetworkRuntime(keyId);
  return networkManager.environmentForRuntime(runtime, { ...environment });
}

function stableApiCodexProxyEnvironment(environment = process.env) {
  const proxyUrl = `http://127.0.0.1:${API_CODEX_PROXY_PORT}`;
  const bypass = 'localhost,127.0.0.1,::1,.localhost,0.0.0.0';
  return {
    ...environment,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    ALL_PROXY: proxyUrl,
    all_proxy: proxyUrl,
    NODE_USE_ENV_PROXY: '1',
    NO_PROXY: bypass,
    no_proxy: bypass,
  };
}

async function prepareStableApiCodexProxy(runtime) {
  apiCodexProxyRelay.setTargetPort(runtime?.mixedPort || 0);
  await apiCodexProxyRelay.listen();
  return API_CODEX_PROXY_PORT;
}

async function accountPoolDispatcher(keyRecord) {
  const runtime = await apiKeyNetworkRuntime(keyRecord.id);
  return runtime ? new ProxyAgent(`http://127.0.0.1:${runtime.mixedPort}`) : null;
}

async function retryableAccountPoolResponse(upstream) {
  if ([401, 403, 429].includes(upstream.status) || upstream.status >= 500) return true;
  if (upstream.status !== 400) return false;
  try {
    const text = (await upstream.clone().text()).slice(0, 4096);
    return /(?:insufficient_quota|usage_limit|rate_limit|quota[^a-z]*(?:exceeded|exhausted|reached)|额度[^，。]*(?:耗尽|用完|不足))/i.test(text);
  } catch {
    return false;
  }
}

function coolDownAccountPoolEntry(accountId, upstream) {
  if (![400, 429].includes(upstream.status) && upstream.status < 500) return;
  const retryAfterSeconds = Number(upstream.headers.get('retry-after'));
  const duration = Number.isFinite(retryAfterSeconds)
    ? Math.max(15_000, Math.min(5 * 60_000, retryAfterSeconds * 1000))
    : upstream.status >= 500 ? 15_000 : 60_000;
  accountPoolCooldowns.set(accountId, Date.now() + duration);
}

function accountPoolHealth(keyRecord) {
  const selected = new Set(Array.isArray(keyRecord?.accountIds) ? keyRecord.accountIds : []);
  const now = Date.now();
  return accounts
    .filter((account) => !selected.size || selected.has(account.id))
    .map((account) => {
      const cooldownUntil = accountPoolCooldowns.get(account.id) || 0;
      const authenticated = isCodexAuthenticated(account) && account.quotaErrorCode !== 'auth_expired';
      const remainingPercent = accountRemainingPercent(account);
      let status = 'available';
      if (account.enabled === false) status = 'disabled';
      else if (!authenticated) status = 'authentication_required';
      else if (!accountHasUsableQuota(account)) status = 'quota_exhausted';
      else if (cooldownUntil > now) status = 'cooldown';
      return {
        id: account.id,
        name: account.label,
        status,
        remaining_percent: remainingPercent,
        credit_backed: remainingPercent <= 0 && hasSpendableCredits(account.quota?.credits),
        cooldown_until: cooldownUntil > now ? new Date(cooldownUntil).toISOString() : null,
        models: [...(accountModelCapabilities.get(account.id) || [])],
      };
    });
}

function poolFailureError(failures) {
  const statuses = failures.map((failure) => Number(failure.status) || 0);
  const all = (predicate) => statuses.length > 0 && statuses.every(predicate);
  let statusCode = 502;
  let errorCode = 'account_pool_upstream_error';
  let message = '账号池请求失败，所有可用账号均未成功响应';
  if (all((status) => status === 401)) {
    statusCode = 503; errorCode = 'account_pool_auth_unavailable'; message = '账号池中的账号授权均已失效';
  } else if (all((status) => status === 403)) {
    statusCode = 403; errorCode = 'account_pool_model_forbidden'; message = '账号池中的账号均无权使用所请求的模型';
  } else if (all((status) => status === 400 || status === 429)) {
    statusCode = 429; errorCode = 'account_pool_rate_limited'; message = '账号池中的账号均已达到额度或速率限制';
  } else if (all((status) => status === 0)) {
    statusCode = 502; errorCode = 'account_pool_network_error'; message = '账号池网络连接失败';
  }
  return Object.assign(new Error(message), {
    statusCode,
    errorType: 'account_pool_error',
    errorCode,
    failures,
  });
}

async function forwardAccountPoolResponses({ keyRecord, model, body, upstreamHeaders = {}, signal }) {
  const candidates = accountPoolCandidates(keyRecord?.accountIds, model);
  if (!candidates.length) throw Object.assign(new Error(`所选账号均不可用、处于冷却状态或不支持模型 ${model}`), {
    statusCode: 503,
    errorType: 'account_pool_error',
    errorCode: 'account_pool_unavailable',
  });
  const failures = [];
  for (const account of candidates) {
    let dispatcher = null;
    try {
      dispatcher = await accountPoolDispatcher(keyRecord);
      let auth = readAccountAuth(account);
      const temporaryRelay = account.accountKind === 'relay' && isNonRefreshableWebSessionAuth(auth);
      if (accessTokenNeedsRefresh(auth) && !temporaryRelay) auth = await refreshAccountPoolAuth(account, auth, dispatcher);
      const send = (currentAuth) => {
        const tokens = currentAuth.tokens || currentAuth;
        const accountId = accountIdFromAuth(currentAuth);
        if (!accountId) throw Object.assign(new Error('账号授权缺少 ChatGPT Account ID'), { statusCode: 401 });
        // The ChatGPT Codex upstream only accepts stored=false and streaming
        // responses. The gateway aggregates the stream for non-stream callers.
        const upstreamBody = { ...body, model, store: false, stream: true };
        // ChatGPT's account-backed Codex endpoint does not accept the public
        // Responses max_output_tokens field. Accept it at the Navo boundary and
        // keep it in the normalized final response, but do not let it make the
        // account-backed upstream reject the complete request.
        delete upstreamBody.max_output_tokens;
        return fetch(CHATGPT_CODEX_RESPONSES_URL, {
          method: 'POST',
          headers: {
            ...upstreamHeaders,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${tokens.access_token}`,
            'ChatGPT-Account-ID': accountId,
            Originator: upstreamHeaders.Originator || 'codex_cli_rs',
            Version: APP_VERSION,
            'User-Agent': upstreamHeaders['User-Agent'] || `codex_cli_rs/${APP_VERSION}`,
          },
          body: JSON.stringify(upstreamBody), signal,
          ...(dispatcher ? { dispatcher } : {}),
        });
      };
      let upstream = await send(auth);
      if (upstream.status === 401 && !temporaryRelay) {
        try { upstream.body?.cancel(); } catch {}
        auth = await refreshAccountPoolAuth(account, auth, dispatcher);
        upstream = await send(auth);
      }
      if (await retryableAccountPoolResponse(upstream)) {
        const status = upstream.status;
        coolDownAccountPoolEntry(account.id, upstream);
        try { upstream.body?.cancel(); } catch {}
        failures.push({ accountId: account.id, name: account.label, status, reason: `HTTP ${status}` });
        if (status === 401) {
          account.quotaError = '登录已失效，请重新授权';
          account.quotaErrorCode = 'auth_expired';
          saveAccounts([...accounts]);
        }
        if (dispatcher) await dispatcher.close().catch(() => {});
        continue;
      }
      accountPoolLastUsed.set(account.id, Date.now());
      audit('api.pool.routed', { accountId: account.id, result: model });
      return { upstream, accountId: account.id, cleanup: () => dispatcher?.close().catch(() => {}) };
    } catch (error) {
      if (dispatcher) await dispatcher.close().catch(() => {});
      if (signal?.aborted) throw error;
      accountPoolCooldowns.set(account.id, Date.now() + 15_000);
      failures.push({
        accountId: account.id,
        name: account.label,
        status: Number(error.statusCode) || 0,
        reason: String(error.code || error.message || 'error').slice(0, 160),
      });
    }
  }
  audit('api.pool.exhausted', {
    result: failures.map((failure) => `${failure.name}:${failure.status || failure.reason}`).join(',').slice(0, 500),
  });
  throw poolFailureError(failures);
}

apiServiceManager.poolForwarder = forwardAccountPoolResponses;

function archiveInvalidCodexAuth(account) {
  const file = accountAuthFile(account);
  if (!fs.existsSync(file)) return false;
  try {
    const auth = validateAuthPayload(readJson(file, null), { allowTemporary: true });
    if (!isNonRefreshableWebSessionAuth(auth)) return false;
  } catch (error) {
    audit('codex.auth.invalid-detected', { accountId: account.id, result: error.message });
  }
  const backupFile = path.join(path.dirname(file), `auth.invalid-${Date.now()}.bak`);
  fs.renameSync(file, backupFile);
  audit('codex.auth.invalid-archived', { accountId: account.id, result: 'requires-official-oauth' });
  return true;
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
  if (attempt && ['starting', 'waiting', 'finalizing', 'web-login'].includes(attempt.status)) {
    return { status: 'authorizing', label: '正在授权', detail: attempt.flow === 'protocol' ? '协议登录正在后台运行，请在应用内完成验证' : '请在账号独立浏览器中完成官方流程', checkedAt };
  }
  if (attempt?.status === 'interrupted') {
    return { status: 'interrupted', label: '授权已中断', detail: '可以从当前账号继续发起官方授权', checkedAt };
  }
  const authFile = accountAuthFile(account);
  if (!fs.existsSync(authFile)) {
    return { status: 'needs_auth', label: '需要授权', detail: '尚未保存 Codex 登录凭证', checkedAt };
  }
  let auth;
  try {
    auth = readAccountAuth(account);
  } catch (error) {
    const nonRefreshable = isNonRefreshableWebSessionAuth(readJson(authFile, null));
    return {
      status: 'invalid',
      label: nonRefreshable ? 'Codex 授权未完成' : '凭证异常',
      detail: nonRefreshable ? '网页端登录正常，但仍需完成官方 Codex OAuth' : '授权文件无法识别，请重新授权',
      checkedAt,
    };
  }
  if (account.accountKind === 'relay') {
    if (isNonRefreshableWebSessionAuth(auth)) {
      const expiresAt = account.relayExpiresAt ? new Date(account.relayExpiresAt).toLocaleString('zh-CN', { hour12: false }) : '';
      return {
        status: isCodexAuthenticated(account) ? 'temporary' : 'expired',
        label: isCodexAuthenticated(account) ? '临时反代' : '临时凭证已过期',
        detail: expiresAt ? `仅用于 API 反代，将于 ${expiresAt} 到期` : '仅用于 API 反代，访问 Token 失效后需要重新导入',
        checkedAt,
      };
    }
    if (!account.quotaErrorCode) {
      return { status: 'healthy', label: '临时凭证正常', detail: 'OAuth 凭证完整，可自动续期并参与 API 账号池', checkedAt };
    }
  }
  if (account.quotaErrorCode === 'auth_expired') {
    return { status: 'expired', label: '授权已失效', detail: '官方服务拒绝了当前凭证，请重新授权', checkedAt };
  }
  if (account.quotaErrorCode === 'fetch_failed') {
    return { status: 'attention', label: '需要检查', detail: '凭证存在，但最近一次在线检查失败', checkedAt };
  }
  if (isNonRefreshableWebSessionAuth(auth)) {
    return { status: 'needs_auth', label: '需要官方授权', detail: '旧版临时凭证不可刷新，请完成官方 Codex OAuth', checkedAt };
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

async function runWakeCommand(account, environmentOverride = null) {
  if (!isCodexAuthenticated(account) || account.quotaErrorCode === 'auth_expired') {
    throw new Error('该账号尚未完成 Codex 授权，无法唤醒');
  }
  if (wakeRuns.has(account.id)) throw new Error('该账号正在唤醒，请稍候');
  if (settings.mockLaunch) return Promise.resolve({ output: 'mock wake success' });

  const baseEnvironment = {
    ...process.env, CODEX_HOME: accountPaths(account).codexHomeDir, NO_COLOR: '1', TERM: 'dumb',
  };
  const taskEnvironment = environmentOverride || await backgroundTaskEnvironment(baseEnvironment);

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
      env: taskEnvironment,
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

async function wakeAccount(account, trigger = 'manual', operator = '本机用户', environmentOverride = null) {
  try {
    await runWakeCommand(account, environmentOverride);
    recordWakeAttempt(account, trigger, 'success');
    audit('account.wake', { accountId: account.id, operator, result: trigger });
    try {
      if (settings.mockLaunch) return accountView(account);
      const { codexHomeDir } = accountPaths(account);
      account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, environmentOverride || await backgroundTaskEnvironment(process.env));
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
    account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, await backgroundTaskEnvironment(process.env));
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

async function detectSelectedAccountModels(accountIds) {
  const ids = [...new Set((Array.isArray(accountIds) ? accountIds : []).map(String).filter(validateAccountId))];
  if (!ids.length) throw new Error('请先选择至少一个账号');
  const selected = ids.map((id) => accounts.find((account) => account.id === id));
  const missing = selected.map((account, index) => account ? '' : ids[index]).filter(Boolean);
  if (missing.length) throw new Error(`账号不存在：${missing.join(', ')}`);
  const support = new Map();
  const failures = [];
  for (const account of selected) {
    if (!isCodexAuthenticated(account)) {
      failures.push(`${account.label}：Codex 授权无效`);
      continue;
    }
    try {
      const runtime = await networkManager.ensureAccount(account.id);
      const environment = networkManager.environmentForRuntime(runtime, process.env);
      const models = await readCodexModels(findCodexCli(), accountPaths(account).codexHomeDir, 20_000, environment);
      const idsForAccount = new Set(models.map((model) => model.id));
      accountModelCapabilities.set(account.id, idsForAccount);
      for (const model of models) {
        const current = support.get(model.id) || { id: model.id, label: model.label || model.id, accountIds: [] };
        current.accountIds.push(account.id);
        support.set(model.id, current);
      }
    } catch (error) {
      failures.push(`${account.label}：${error.message}`);
    }
  }
  if (failures.length) throw new Error(`模型检测未完成：${failures.join('；')}`);
  return [...support.values()]
    .map((model) => ({ ...model, supportedAccounts: model.accountIds.length, totalAccounts: selected.length }))
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

function readActiveApiCodex() {
  const active = readJson(ACTIVE_API_CODEX_FILE, null);
  return active && typeof active.keyId === 'string' && active.keyId.trim() ? active : null;
}

function activeCodexAccountId(codexSnapshot = null) {
  const active = readActiveCodexAuth();
  if (!active) return '';
  const lease = leases[active.accountId];
  const snapshot = codexSnapshot || detectCodexDesktopSnapshot();
  if (snapshot?.reliable && !snapshot.pid) return '';
  if (snapshot?.reliable && snapshot.pid) {
    if (active.processIdentity) {
      return codexProcessIdentityMatches(active.processIdentity, snapshot) ? active.accountId : '';
    }
    // active-codex-auth.json is the authoritative marker that the shared Codex
    // home is currently switched to a managed account. The lease is only a UI
    // occupancy record and can be lost or temporarily stale after a crash,
    // Store-app PID replacement, or failed launch cleanup. Treat a missing
    // lease as managed instead of showing "external Codex".
    if (!lease) return active.accountId;
    if (lease.launchType !== 'codex') return '';
    const leasePid = Number(lease.processPid);
    if (!leasePid || leasePid === snapshot.pid || !isProcessAlive(leasePid)) return active.accountId;
    return '';
  }
  return active.accountId;
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
    launchId: crypto.randomUUID(),
    activatedAt: new Date().toISOString(),
  });
}

function recordSharedCodexProcess(accountId, snapshot) {
  const active = readActiveCodexAuth();
  const processIdentity = codexProcessIdentity(snapshot);
  if (!active || active.accountId !== accountId || !processIdentity) return null;
  writeJsonAtomic(ACTIVE_CODEX_AUTH_FILE, { ...active, processIdentity });
  return processIdentity;
}

function restoreSharedCodexAuth(accountId) {
  usageTracker?.sync(true);
  const active = readActiveCodexAuth();
  if (!active || active.accountId !== accountId) return;
  const account = accounts.find((item) => item.id === accountId);
  if (active.status !== 'restore_failed' && account && fs.existsSync(SHARED_CODEX_AUTH_FILE)) {
    const { codexHomeDir } = accountPaths(account);
    copyFileAtomic(SHARED_CODEX_AUTH_FILE, path.join(codexHomeDir, 'auth.json'));
  }
  let launchViewRestoreError = null;
  try { restoreLaunchView(active.launchView); }
  catch (error) {
    launchViewRestoreError = error;
    audit('codex.launch-view.restore-failed', { result: error.message });
  }
  if (launchViewRestoreError) {
    // Keep the launch-scoped auth and backups intact. Restoring credentials
    // while Codex still owns its SQLite WAL leaves a half-restored profile.
    writeJsonAtomic(ACTIVE_CODEX_AUTH_FILE, {
      ...active,
      status: 'restore_failed',
      restoreError: launchViewRestoreError.message,
    });
    return false;
  }
  if (active.hadOriginalAuth && fs.existsSync(SHARED_AUTH_BACKUP_FILE)) {
    copyFileAtomic(SHARED_AUTH_BACKUP_FILE, SHARED_CODEX_AUTH_FILE);
  } else {
    fs.rmSync(SHARED_CODEX_AUTH_FILE, { force: true });
  }
  fs.rmSync(ACTIVE_CODEX_AUTH_FILE, { force: true });
  try { repairSharedCodexThreadCatalog(SHARED_CODEX_HOME); } catch {}
  audit('codex.auth.restored', { accountId, result: 'shared-projects' });
  return true;
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
  await prepareAccountNetwork(account);
  const { browserDir } = accountPaths(account);
  fs.mkdirSync(browserDir, { recursive: true });
  const activePortFile = path.join(browserDir, 'DevToolsActivePort');
  const existingPort = await readLiveChromeDebugPort(activePortFile);
  if (!existingPort) fs.rmSync(activePortFile, { force: true });
  // Chrome sets navigator.webdriver=true when --remote-debugging-port=0 is
  // used. OpenAI's login edge then challenges the JSON authorization request.
  // A concrete loopback port keeps CDP/liveness support without marking the
  // user's normal account browser as an automated session.
  const requestedPort = existingPort || await reserveLoopbackPort();
  const executable = findBrowser();
  const args = [
    `--user-data-dir=${browserDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--disable-background-mode',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${requestedPort}`,
    ...networkManager.browserArgs(account.id),
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
  const verifiedPort = await waitForChromeDebugPort(requestedPort);
  if (!verifiedPort) {
    throw new Error('独立 Chrome 环境启动后未绑定到对应账号目录');
  }
  fs.writeFileSync(activePortFile, `${verifiedPort}\n`, 'utf8');
  return options.returnSession ? { processPid, port: verifiedPort } : processPid;
}

function publicApiServiceState() {
  apiServiceManager.ensureAccountPool(wakeModelCatalog().map((item) => item.slug));
  const state = apiServiceManager.publicState();
  state.keys = state.keys.map((key) => {
    const eligible = accounts.filter((account) => account.enabled !== false && isCodexAuthenticated(account)
      && account.quotaErrorCode !== 'auth_expired');
    const byId = new Map(eligible.map((account) => [account.id, account]));
    const pool = key.accountIds?.length ? key.accountIds.map((id) => byId.get(id)).filter(Boolean) : eligible;
    const combined = combinedAccountQuota(pool, accountRemainingPercent);
    const network = networkManager.publicAssignment(apiKeyNetworkId(key.id));
    return {
      ...key,
      network,
      quota: {
        remainingPercent: combined.remainingPercent,
        totalRemainingPercent: combined.totalRemainingPercent,
        source: 'account-pool-total',
        accountCount: combined.accountCount,
      },
      backingAccounts: pool.map((account) => ({ id: account.id, label: account.label, network: accountView(account).network, wake: wakeState(account.id) })),
    };
  });
  const active = reconcileActiveApiCodexState();
  if (!active) {
    state.activeKeyId = '';
    return state;
  }
  state.activeKeyId = active.keyId;
  return state;
}

function floatingWindowState() {
  const codexSnapshot = detectCodexDesktopSnapshot();
  const apiService = publicApiServiceState();
  const activeKey = apiService.keys.find((key) => key.id === apiService.activeKeyId) || null;
  const activeAccountId = activeKey ? '' : activeCodexAccountId(codexSnapshot);
  const activeAccount = accounts.find((account) => account.id === activeAccountId) || null;
  usageTracker.sync();
  const usageSummary = usageTracker.summary('today');
  const usage = activeKey ? usageForLocalDate(activeKey) : usageSummary.accounts[activeAccountId] || {
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
  };
  const quotaValues = (activeAccount?.quota?.windows || [])
    .map((item) => Number(item.remainingPercent))
    .filter(Number.isFinite);
  const quotaRemaining = activeKey
    ? Number(activeKey.quota?.remainingPercent)
    : quotaValues.length ? Math.min(...quotaValues) : null;
  const activeStatuses = new Set(['running', 'waiting_input', 'waiting_approval']);
  // Rollout files can end without a terminal event after a reboot or forced
  // shutdown. Never surface that stale state as a running task when no Codex
  // desktop process exists.
  const task = codexSnapshot.pid
    ? sessionMonitor.snapshot().tasks.find((item) => activeStatuses.has(item.status)) || null
    : null;
  return {
    account: {
      id: activeKey?.id || activeAccount?.id || '',
      label: activeKey?.name || activeAccount?.label || (codexSnapshot.pid ? 'External Codex' : 'Codex not running'),
      type: activeKey ? 'api' : activeAccount ? 'account' : codexSnapshot.pid ? 'external' : 'none',
      quotaRemaining: Number.isFinite(quotaRemaining) ? Math.max(0, Math.min(100, quotaRemaining)) : null,
    },
    usage: {
      input: Number(usage.inputTokens || 0),
      cachedInput: Number(usage.cachedInputTokens || 0),
      output: Number(usage.outputTokens || 0),
    },
    task: task ? {
      id: task.id,
      title: task.threadName || 'Untitled session',
      project: task.project || '',
      status: task.status,
      statusLabel: task.statusLabel || task.status,
      activity: task.currentActivity || task.statusLabel || task.status,
      usage: {
        input: Number(task.usage?.input || 0),
        cachedInput: Number(task.usage?.cachedInput || 0),
        output: Number(task.usage?.output || 0),
      },
    } : null,
    updatedAt: new Date().toISOString(),
  };
}

async function refreshFloatingWindowQuota() {
  const codexSnapshot = detectCodexDesktopSnapshot();
  const apiState = publicApiServiceState();
  const activeKey = apiServiceManager.keys.find((key) => key.id === apiState.activeKeyId) || null;
  if (activeKey) {
    const pool = accountPoolCandidates(activeKey.accountIds);
    if (!pool.length) throw new Error('该 API Codex 没有可刷新的底层账号');
    const environment = await apiKeyTaskEnvironment(activeKey.id, process.env);
    const errors = [];
    for (const account of pool) {
      try {
        const { codexHomeDir } = accountPaths(account);
        account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, environment);
        account.quotaError = '';
        account.quotaErrorCode = '';
        account.quotaCheckedAt = account.quota.refreshedAt;
      } catch (error) {
        account.quotaError = error.message;
        account.quotaCheckedAt = new Date().toISOString();
        errors.push(error);
      }
    }
    saveAccounts([...accounts]);
    if (errors.length === pool.length) throw errors[0];
    return floatingWindowState();
  }
  const accountId = activeCodexAccountId(codexSnapshot);
  const account = accounts.find((item) => item.id === accountId);
  if (!account) throw new Error('当前没有可刷新的账号额度');
  try {
    const { codexHomeDir } = accountPaths(account);
    account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, await backgroundTaskEnvironment(process.env));
    account.quotaError = '';
    account.quotaErrorCode = '';
    account.quotaCheckedAt = account.quota.refreshedAt;
    saveAccounts([...accounts]);
    return floatingWindowState();
  } catch (error) {
    account.quotaError = error.message;
    account.quotaCheckedAt = new Date().toISOString();
    saveAccounts([...accounts]);
    throw error;
  }
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('No free Chrome debugging port'));
        else resolve(port);
      });
    });
  });
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
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function readLiveChromeDebugPort(activePortFile) {
  const port = readChromeDebugPort(activePortFile);
  return await isChromeDebugPortReady(port) ? port : 0;
}

async function resolveAccountBrowserDebugPort(account, browser) {
  if (!browser) return 0;
  const { browserDir } = accountPaths(account);
  const activePortFile = path.join(browserDir, 'DevToolsActivePort');
  const previous = Number(browser.port) || 0;
  const port = await resolveChromeDebugPort({
    browser,
    activePortFile,
    isPortReady: isChromeDebugPortReady,
  });
  if (port && port !== previous) {
    audit('codex.login.browser-rebound', {
      accountId: account.id,
      result: `${previous}->${port}`,
    });
  }
  return port;
}

async function accountBrowserReadyForSessionProbe(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(700) });
    if (!response.ok) return false;
    const targets = await response.json();
    return targets.some((target) => {
      if (target?.type !== 'page') return false;
      try {
        const page = new URL(target.url);
        return page.protocol === 'https:'
          && page.hostname.toLowerCase() === 'chatgpt.com'
          && !/^\/(?:auth\/login|auth\/logout|login)(?:\/|$)/i.test(page.pathname);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

async function waitForChromeDebugPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isChromeDebugPortReady(port)) return port;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return 0;
}

async function launchAccountBrowserForProtocol(account, options = {}) {
  await prepareAccountNetwork(account);
  const { browserDir } = accountPaths(account);
  fs.mkdirSync(browserDir, { recursive: true });
  const activePortFile = path.join(browserDir, 'DevToolsActivePort');
  fs.rmSync(activePortFile, { force: true });
  const requestedPort = await reserveLoopbackPort();
  const executable = findBrowser();
  const browserArgs = [
    `--user-data-dir=${browserDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--disable-background-mode',
    '--window-size=1280,900',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${requestedPort}`,
    ...networkManager.browserArgs(account.id),
    settings.browserStartUrl,
  ];
  if (options.visibleOffscreen) browserArgs.splice(3, 0, '--window-position=-32000,-32000');
  else browserArgs.splice(3, 0, '--headless=new');
  const processPid = await spawnDetached(executable, browserArgs, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  const port = await waitForChromeDebugPort(requestedPort);
  if (port) {
    fs.writeFileSync(activePortFile, `${port}\n`, 'utf8');
    return { processPid, port };
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

async function waitForCodexDesktop(timeoutMs = 8_000, stableMs = 1_200) {
  const deadline = Date.now() + timeoutMs;
  let candidatePid = null;
  let candidateSince = 0;
  while (Date.now() < deadline) {
    const pid = findRunningCodexDesktopPid();
    if (pid && pid === candidatePid && isProcessAlive(pid)) {
      if (Date.now() - candidateSince >= stableMs) return pid;
    } else {
      candidatePid = pid;
      candidateSince = pid ? Date.now() : 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

const PLAN_EXPIRY_REFRESH_MS = 12 * 60 * 60_000;

async function refreshAccountPlanExpiry(account, { force = false } = {}) {
  if (!account || account.accountKind === 'relay' || !isCodexAuthenticated(account)) return null;
  const lastChecked = Date.parse(account.planExpiryCheckedAt || '');
  const refreshInterval = account.planExpiryError ? 10 * 60_000 : PLAN_EXPIRY_REFRESH_MS;
  if (!force && Number.isFinite(lastChecked) && Date.now() - lastChecked < refreshInterval) {
    return account.planExpiresAt || null;
  }
  const { browserDir } = accountPaths(account);
  const activePortFile = path.join(browserDir, 'DevToolsActivePort');
  let port = await readLiveChromeDebugPort(activePortFile);
  let browser = null;
  try {
    const auth = readAccountAuth(account);
    const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : auth;
    const accessToken = String(tokens.access_token || '');
    const claims = decodeJwtClaims(accessToken);
    const authClaims = claims['https://api.openai.com/auth'] || {};
    const accountId = String(tokens.account_id || auth.account_id || authClaims.chatgpt_account_id || claims.chatgpt_account_id || '');
    if (!accessToken || !accountId) throw new Error('Codex OAuth 授权中缺少账号标识');
    if (!port) {
      browser = await launchAccountBrowserForProtocol(account, { visibleOffscreen: true });
      port = browser.port;
    }
    const subscription = await readProtocolSubscription({
      port, accessToken, accountId, closeBrowser: Boolean(browser),
    });
    account.planExpiryCheckedAt = new Date().toISOString();
    account.planExpiryError = '';
    account.planRenewsAt = subscription.renewsAt;
    account.planBillingPeriod = subscription.billingPeriod;
    if (subscription.expiresAt) account.planExpiresAt = subscription.expiresAt;
    else delete account.planExpiresAt;
    saveAccounts([...accounts]);
    audit('account.plan-expiry.refreshed', { accountId: account.id, result: subscription.expiresAt || 'not-returned' });
    return account.planExpiresAt || null;
  } catch (error) {
    account.planExpiryCheckedAt = new Date().toISOString();
    account.planExpiryError = error.message;
    saveAccounts([...accounts]);
    audit('account.plan-expiry.failed', { accountId: account.id, result: error.message });
    return null;
  } finally {
    if (browser && isProcessAlive(browser.processPid)) stopProtocolBrowser(browser);
  }
}

async function refreshStaleAccountPlanExpiries({ force = false } = {}) {
  await Promise.allSettled(accounts.map((account) => refreshAccountPlanExpiry(account, { force })));
}

async function launchCodexDesktop(account, launchOptions = null) {
  setCodexLaunchProgress({ stage: 'proxy', message: '正在检测代理可用性…', percent: 16 });
  const accountNetwork = await prepareAccountNetwork(account, { preflight: true, purpose: '启动 Codex' });
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
  beginCodexLaunchTransaction('账号 Codex 启动');
  let transactionOpen = true;
  const closeTransaction = () => {
    if (transactionOpen) {
      endCodexLaunchTransaction('账号 Codex 启动');
      transactionOpen = false;
    }
  };
  try {
    setCodexLaunchProgress({ stage: 'sessions', message: '正在加载项目与会话…', percent: 34 });
    restoreStoppedLaunchStateBeforeCatalog();
    repairSharedCodexPreferences();
    const catalog = listCodexLaunchOptions(SHARED_CODEX_HOME);
    const selection = normalizeLaunchSelection(launchOptions, catalog);
    if (selection.optimizeOversized) {
      const optimized = await optimizeSelectedRollouts(SHARED_CODEX_HOME, selection.threadIds, ROLLOUT_BACKUP_ROOT);
      for (const item of optimized) audit('codex.rollout.optimized', { result: `${item.threadId}:${item.beforeBytes}->${item.afterBytes}` });
    }
    setCodexLaunchProgress({ stage: 'credentials', message: '正在切换账号授权…', percent: 58 });
    if (readActiveCodexAuth()) throw new Error('上一次 Codex 启动状态尚未恢复，请先完成会话状态恢复');
    activateSharedCodexAuth(account);
    const active = readActiveCodexAuth();
    const launchView = prepareLaunchView(
      SHARED_CODEX_HOME,
      path.join(LAUNCH_VIEW_ROOT, `account-${active.startedAt || active.activatedAt}`.replace(/[^a-z0-9-]/gi, '')),
      selection,
      { manageConfig: true, modelProvider: 'openai' },
    );
    writeJsonAtomic(ACTIVE_CODEX_AUTH_FILE, { ...active, launchView });
    const environment = codexEnvironment({ ...process.env, CODEX_HOME: SHARED_CODEX_HOME }, account);
    // Codex Desktop has two network layers: Chromium ignores HTTP_PROXY on
    // Windows, while the native/realtime process consumes proxy environment
    // variables. Route both through the account-local core and bypass loopback so
    // Electron IPC and the local app-server never enter the proxy.
    const localeDebugPort = selection.language === 'en-US' ? 0 : await reserveLoopbackPort();
    const localeArgs = localeDebugPort
      ? ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${localeDebugPort}`]
      : [];
    const desktopArgs = accountNetwork
      ? [
        `--proxy-server=http://127.0.0.1:${accountNetwork.mixedPort}`,
        '--proxy-bypass-list=<local>;localhost;*.localhost;127.0.0.1;[::1]',
        `--lang=${selection.language}`,
        ...localeArgs,
      ]
      : [`--lang=${selection.language}`, ...localeArgs];
    delete environment.CODEX_ELECTRON_USER_DATA_PATH;
    delete environment.CODEX_SQLITE_HOME;
    try {
      setCodexLaunchProgress({ stage: 'starting', message: '正在打开 Codex…', percent: 78 });
      const spawnedPid = await spawnDetached(installation.executable, desktopArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env: environment,
      });
      // Store-packaged Electron apps may replace their bootstrap process during
      // startup. Track the stable root process instead of the short-lived PID so
      // lease cleanup does not restore the previous auth while Codex is opening.
      setCodexLaunchProgress({ stage: 'waiting', message: '正在等待 Codex 窗口…', percent: 90 });
      const processPid = await waitForCodexDesktop(10_000);
      if (!processPid) throw new Error(`Codex 启动进程 ${spawnedPid} 已退出，但没有检测到桌面端窗口`);
      if (localeDebugPort) {
        await applyDesktopLocaleBridge(localeDebugPort, selection.language);
        audit('codex.desktop.locale-applied', { accountId: account.id, result: selection.language });
      }
      recordSharedCodexProcess(account.id, detectCodexDesktopSnapshot({ preferCache: false }));
      audit('codex.desktop.started', {
        accountId: account.id,
        result: accountNetwork ? `direct-spawn:proxy:${processPid}` : `direct-spawn:${processPid}`,
      });
      closeTransaction();
      return processPid;
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
      recordSharedCodexProcess(account.id, detectCodexDesktopSnapshot({ preferCache: false }));
      audit('codex.desktop.started', { accountId: account.id, result: `app-activation:${processPid}` });
      closeTransaction();
      return processPid;
    } catch (error) {
      restoreSharedCodexAuth(account.id);
      throw new Error(`Windows 拒绝启动 Codex。请在安全软件中允许 Codex Navo 和 Codex，或先手动启动一次 Codex 后重试。详细信息：${error.message}`);
    }
  } catch (error) {
    if (readActiveCodexAuth()?.accountId === account.id) restoreSharedCodexAuth(account.id);
    closeTransaction();
    throw error;
  }
}

function stopManagedCodexDesktop(accountId) {
  const active = readActiveCodexAuth();
  if (!active || active.accountId !== accountId) throw new Error('无法确认当前 Codex 属于这个账号');
  const snapshot = detectCodexDesktopSnapshot({ preferCache: false });
  if (!snapshot.reliable) throw new Error('无法检查 Codex 桌面端运行状态，请稍后重试');
  const processPid = active.processIdentity && !codexProcessIdentityMatches(active.processIdentity, snapshot)
    ? null
    : snapshot.pid;
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
  clearTimeout(pending.webLoginTimer);
  clearInterval(pending.browserWatchTimer);
  try { pending.devtoolsSocket?.close(); } catch {}
  pending.status = 'error';
  if (pending.child && isProcessAlive(pending.child.pid)) {
    try { pending.child.kill(); } catch {}
  }
  if (pending.flow === 'protocol') stopProtocolBrowser(pending.browser);
  pendingCodexLogins.delete(accountId);
}

function tomlString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function apiKeyCodexConfig(source, model, secret, language = 'zh-CN') {
  const output = [];
  let section = '';
  let skipProvider = false;
  for (const line of String(source || '').split(/\r?\n/)) {
    const match = line.trim().match(/^\[([^\]]+)\]$/);
    if (match) {
      section = match[1].trim();
      skipProvider = ['model_providers.openai', 'model_providers.codex_navo'].includes(section);
      if (skipProvider) continue;
    }
    if (skipProvider) continue;
    if (!section && /^\s*(?:model|model_provider|cli_auth_credentials_store)\s*=/.test(line)) continue;
    output.push(line);
  }
  return withDesktopLocale([
    `model = ${tomlString(model)}`,
    // Current Codex releases reserve the built-in `openai` provider id. Use a
    // launch-scoped custom provider and temporarily map selected thread metadata
    // to it; the original provider is restored when the desktop exits.
    'model_provider = "codex_navo"',
    'cli_auth_credentials_store = "file"',
    ...output,
    '',
    '[model_providers.codex_navo]',
    'name = "Codex Navo API"',
    `base_url = ${tomlString(`http://127.0.0.1:${API_GATEWAY_PORT}/v1`)}`,
    // Desktop may restart its app-server after an interrupted stream. Recovery
    // children do not reliably retain the environment injected into Electron,
    // so the temporary provider config also carries this launch-scoped secret.
    // The original config is restored when the managed API Codex exits.
    `experimental_bearer_token = ${tomlString(secret)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
  ].join('\n'), language);
}

function configAfterApiKeyCodex(source) {
  const output = [];
  let section = '';
  let skipProvider = false;
  for (const line of String(source || '').split(/\r?\n/)) {
    const match = line.trim().match(/^\[([^\]]+)]$/);
    if (match) {
      section = match[1].trim();
      skipProvider = section === 'model_providers.codex_navo';
      if (skipProvider) continue;
    }
    if (skipProvider) continue;
    if (!section && /^\s*(?:model|model_provider|cli_auth_credentials_store)\s*=/.test(line)) continue;
    output.push(line);
  }
  const result = output.join('\n').replace(/^\s+|\s+$/g, '');
  return result ? `${result}\n` : '';
}

function prepareApiKeyCodexHome(keyId, model, secret, selection) {
  fs.mkdirSync(SHARED_CODEX_HOME, { recursive: true });
  fs.mkdirSync(API_SHARED_BACKUP_DIR, { recursive: true });
  const lock = acquireCodexConfigLock(API_SHARED_CONFIG_LOCK_FILE, { kind: 'api-codex', keyId });
  let active = null;
  try {
    const configFile = path.join(SHARED_CODEX_HOME, 'config.toml');
    const hadConfig = fs.existsSync(configFile);
    const hadAuth = fs.existsSync(SHARED_CODEX_AUTH_FILE);
    if (hadConfig) copyFileAtomic(configFile, API_SHARED_CONFIG_BACKUP_FILE);
    else fs.rmSync(API_SHARED_CONFIG_BACKUP_FILE, { force: true });
    if (hadAuth) copyFileAtomic(SHARED_CODEX_AUTH_FILE, API_SHARED_AUTH_BACKUP_FILE);
    else fs.rmSync(API_SHARED_AUTH_BACKUP_FILE, { force: true });
    active = {
      keyId,
      processPid: 0,
      processIdentity: null,
      codexHomeDir: SHARED_CODEX_HOME,
      hadConfig,
      hadAuth,
      authManaged: true,
      configLockId: lock.id,
      status: 'preparing',
      startedAt: new Date().toISOString(),
    };
    // Save the rollback marker before changing shared files. Status polling can
    // then distinguish app-server warmup from a desktop process that has exited.
    writeJsonAtomic(ACTIVE_API_CODEX_FILE, active);
    // Scheduled tasks and their run history are device state, not account
    // credentials. Keep the shared Codex catalog in every launch mode so a
    // completed occurrence cannot become due again after an account/API switch.
    const sourceConfig = hadConfig ? fs.readFileSync(configFile, 'utf8') : '';
    fs.writeFileSync(configFile, apiKeyCodexConfig(sourceConfig, model, secret, selection?.language), { mode: 0o600 });
    // Codex Desktop special-cases the built-in `openai` provider and requires
    // an app-visible account even when its configured transport does not require
    // OpenAI auth. Install the launch-scoped API key login atomically, then
    // restore the user's original auth bytes when this Codex instance exits.
    writeJsonAtomic(SHARED_CODEX_AUTH_FILE, { OPENAI_API_KEY: secret });
    const launchView = selection
      ? prepareLaunchView(
        SHARED_CODEX_HOME,
        path.join(LAUNCH_VIEW_ROOT, `api-${active.startedAt.replace(/[^0-9]/g, '')}`),
        selection,
        { modelProvider: 'codex_navo' },
      )
      : null;
    const prepared = { ...active, launchView, status: 'launching' };
    writeJsonAtomic(ACTIVE_API_CODEX_FILE, prepared);
    audit('api.codex.shared-home-prepared', { result: keyId });
    return prepared;
  } catch (error) {
    if (active || fs.existsSync(ACTIVE_API_CODEX_FILE)) restoreApiKeyCodexHome(active || undefined);
    else releaseCodexConfigLock(API_SHARED_CONFIG_LOCK_FILE, lock.id);
    throw error;
  }
}

function repairSharedCodexPreferences() {
  const projects = pruneMissingLocalProjects(SHARED_CODEX_HOME);
  if (projects.changed) audit('codex.projects.pruned', { result: `${projects.removed.length}:${projects.prunedRoots}` });
  const config = repairSharedCodexConfig(SHARED_CODEX_HOME);
  if (config.changed) audit('codex.config.recovered', { result: config.recovered.join(',') });
  const catalog = repairSharedCodexThreadCatalog(SHARED_CODEX_HOME);
  if (catalog.changed) audit('codex.thread-catalog.recovered', { result: `${catalog.catalogCount || 0}` });
  else if (catalog.reason === 'repair-failed') audit('codex.thread-catalog.repair-failed', { result: catalog.error || catalog.reason });
  return { projects, config, catalog, changed: Boolean(projects.changed || config.changed || catalog.changed) };
}

function restoreStoppedLaunchStateBeforeCatalog() {
  if (findRunningCodexDesktopPid()) return false;
  const activeApi = readJson(ACTIVE_API_CODEX_FILE, null);
  if (activeApi && !restoreApiKeyCodexHome(activeApi)) throw new Error('上一次 API Codex 会话状态仍被占用，请确认 Codex 已完全退出后重试');
  const activeAccount = readActiveCodexAuth();
  if (activeAccount && !restoreSharedCodexAuth(activeAccount.accountId)) throw new Error('上一次 Codex 会话状态仍被占用，请确认 Codex 已完全退出后重试');
  return true;
}

function restoreApiKeyCodexHome(active = readJson(ACTIVE_API_CODEX_FILE, null)) {
  if (!active) return;
  let launchViewRestoreError = null;
  try { restoreLaunchView(active.launchView); }
  catch (error) {
    launchViewRestoreError = error;
    audit('codex.launch-view.restore-failed', { result: error.message });
  }
  if (launchViewRestoreError) {
    writeJsonAtomic(ACTIVE_API_CODEX_FILE, {
      ...active,
      status: 'restore_failed',
      restoreError: launchViewRestoreError.message,
    });
    return false;
  }
  // Older releases stored per-Key automation snapshots in this marker. Do not
  // restore that stale backup: the currently active database contains the most
  // recent execution ledger and becomes the shared device-level state.
  const managesSharedHome = typeof active.hadConfig === 'boolean'
    || typeof active.hadAuth === 'boolean'
    || fs.existsSync(API_SHARED_CONFIG_BACKUP_FILE)
    || fs.existsSync(API_SHARED_AUTH_BACKUP_FILE);
  if (managesSharedHome) {
    const configFile = path.join(SHARED_CODEX_HOME, 'config.toml');
    if (active.hadConfig && fs.existsSync(API_SHARED_CONFIG_BACKUP_FILE)) copyFileAtomic(API_SHARED_CONFIG_BACKUP_FILE, configFile);
    else if (typeof active.hadConfig === 'boolean') {
      // A first API launch can make Codex create its normal Windows/plugin
      // defaults while the temporary provider is active. Preserve those new
      // defaults, but remove Navo's provider, model override, and bearer token.
      const preserved = fs.existsSync(configFile) ? configAfterApiKeyCodex(fs.readFileSync(configFile, 'utf8')) : '';
      if (preserved) fs.writeFileSync(configFile, preserved, { mode: 0o600 });
      else fs.rmSync(configFile, { force: true });
    }
    // authManaged is false for current launches. Keep backward-compatible
    // restoration for a package prepared by v1.2.60 or earlier.
    if (active.authManaged !== false) {
      if (active.hadAuth && fs.existsSync(API_SHARED_AUTH_BACKUP_FILE)) copyFileAtomic(API_SHARED_AUTH_BACKUP_FILE, SHARED_CODEX_AUTH_FILE);
      else if (typeof active.hadAuth === 'boolean') fs.rmSync(SHARED_CODEX_AUTH_FILE, { force: true });
    }
    fs.rmSync(API_SHARED_CONFIG_BACKUP_FILE, { force: true });
    fs.rmSync(API_SHARED_AUTH_BACKUP_FILE, { force: true });
  }
  fs.rmSync(ACTIVE_API_CODEX_FILE, { force: true });
  if (active.configLockId) releaseCodexConfigLock(API_SHARED_CONFIG_LOCK_FILE, active.configLockId);
  try { repairSharedCodexThreadCatalog(SHARED_CODEX_HOME); } catch {}
  audit('api.codex.profile-restored', { result: active.keyId || 'stale' });
  return true;
}

const API_CODEX_LAUNCH_GRACE_MS = 120_000;
const API_CODEX_PROCESS_REPLACEMENT_GRACE_MS = 20_000;

function reconcileActiveApiCodexState() {
  const active = readJson(ACTIVE_API_CODEX_FILE, null);
  if (!active) return null;
  // Prefer the PID captured for this exact launch. A Store-packaged Codex can
  // briefly disappear from WMI while its bootstrap/root process is replaced;
  // a transient empty snapshot must not restore the shared config underneath
  // an API Codex that is still alive.
  const snapshot = detectCodexDesktopSnapshot({ preferCache: false });
  const recordedPid = Number(active.processPid);
  const recordedProcessIsCurrent = active.processIdentity
    ? codexProcessIdentityMatches(active.processIdentity, snapshot)
    : recordedPid > 0 && recordedPid === snapshot.pid;
  if (recordedProcessIsCurrent) {
    if (active.status !== 'running' || active.missingSince) {
      const running = { ...active, status: 'running' };
      delete running.missingSince;
      writeJsonAtomic(ACTIVE_API_CODEX_FILE, running);
      return running;
    }
    return active;
  }
  // The launch path records identity after its own spawn completes. Polling
  // never claims an arbitrary Codex that appeared during warmup.
  if (!snapshot.reliable) return active;
  const startedAt = Date.parse(active.startedAt || '');
  const launchIsRecent = Number.isFinite(startedAt)
    && Date.now() - startedAt < API_CODEX_LAUNCH_GRACE_MS;
  const expectedExecutable = String(active.processIdentity?.executablePath || '').trim();
  const replacementExecutable = String(snapshot.executablePath || '').trim();
  const replacementMatchesExecutable = expectedExecutable && replacementExecutable
    && path.normalize(expectedExecutable).toLowerCase() === path.normalize(replacementExecutable).toLowerCase();
  const replacementMatchesInstall = expectedExecutable && replacementExecutable
    && path.dirname(path.normalize(expectedExecutable)).toLowerCase() === path.dirname(path.normalize(replacementExecutable)).toLowerCase()
    && ['chatgpt.exe', 'codex.exe'].includes(path.basename(expectedExecutable).toLowerCase())
    && ['chatgpt.exe', 'codex.exe'].includes(path.basename(replacementExecutable).toLowerCase());
  // Microsoft Store releases have used both ChatGPT.exe and codex.exe and can
  // replace the root process while the window remains open. Rebind a recognized
  // process from the same installation instead of restoring API config/auth
  // underneath a live Codex window.
  if (active.status === 'running' && snapshot.pid && (replacementMatchesExecutable || replacementMatchesInstall)) {
    const rebound = {
      ...active,
      processPid: snapshot.pid,
      processIdentity: codexProcessIdentity(snapshot),
    };
    delete rebound.missingSince;
    writeJsonAtomic(ACTIVE_API_CODEX_FILE, rebound);
    audit('api.codex.process-rebound', { result: `${active.processPid || 0}->${snapshot.pid}` });
    return rebound;
  }
  if (['preparing', 'launching'].includes(active.status) && launchIsRecent) return active;
  if (active.status === 'running') {
    const missingSince = Date.parse(active.missingSince || '');
    if (!Number.isFinite(missingSince)) {
      const missing = { ...active, missingSince: new Date().toISOString() };
      writeJsonAtomic(ACTIVE_API_CODEX_FILE, missing);
      return missing;
    }
    if (Date.now() - missingSince < API_CODEX_PROCESS_REPLACEMENT_GRACE_MS) return active;
  }
  restoreApiKeyCodexHome(active);
  return null;
}

async function launchApiKeyCodex(keyId, launchOptions = null) {
  if (findRunningCodexDesktopPid()) throw new Error('Codex 桌面端是单实例应用，请先退出当前 Codex 再启动 Navo API');
  beginCodexLaunchTransaction('API Codex 启动');
  let transactionOpen = true;
  const closeTransaction = () => {
    if (transactionOpen) {
      endCodexLaunchTransaction('API Codex 启动');
      transactionOpen = false;
    }
  };
  let activeRecord = null;
  let spawnedPid = 0;
  try {
    setCodexLaunchProgress({ stage: 'network', message: '正在检测 API 代理可用性…', percent: 16 });
    const apiKeyNetwork = await prepareApiKeyNetwork(keyId, { preflight: true, purpose: '启动 API Codex' });
    setCodexLaunchProgress({ stage: 'sessions', message: '正在加载项目与会话…', percent: 30 });
    restoreStoppedLaunchStateBeforeCatalog();
    repairSharedCodexPreferences();
    const catalog = listCodexLaunchOptions(SHARED_CODEX_HOME);
    const selection = normalizeLaunchSelection(launchOptions, catalog);
    if (selection.optimizeOversized) {
      const optimized = await optimizeSelectedRollouts(SHARED_CODEX_HOME, selection.threadIds, ROLLOUT_BACKUP_ROOT);
      for (const item of optimized) audit('codex.rollout.optimized', { result: `${item.threadId}:${item.beforeBytes}->${item.afterBytes}` });
    }
    if (readJson(ACTIVE_API_CODEX_FILE, null)) throw new Error('上一次 API Codex 启动状态尚未恢复，请先完成会话状态恢复');
    setCodexLaunchProgress({ stage: 'credentials', message: '正在准备 API 授权环境…', percent: 52 });
    const { record, secret } = apiServiceManager.issueLaunchSecret(keyId);
    const pool = apiServiceManager.accountPool();
    const model = record.modelAllowlist[0] || pool.defaultModel;
    activeRecord = prepareApiKeyCodexHome(keyId, model, secret, selection);
    const codexHomeDir = activeRecord.codexHomeDir;
    const installation = findCodexDesktop();
    const routeEnvironment = await apiKeyTaskEnvironment(keyId, apiCodexEnvironment(process.env, secret));
    const stableProxyPort = await prepareStableApiCodexProxy(apiKeyNetwork);
    const environment = stableApiCodexProxyEnvironment(routeEnvironment);
    // A fresh CODEX_HOME can need dozens of SQLite migrations. Codex Desktop
    // applies a fixed 30-second initialize deadline, so finish those migrations
    // before opening the GUI instead of racing its handshake timer.
    setCodexLaunchProgress({ stage: 'warming', message: '正在初始化 Codex 服务…', percent: 67 });
    const warmup = await warmCodexAppServer(findCodexCli(), codexHomeDir, 90_000, environment);
    audit('api.codex.prewarmed', { result: `${keyId}:${warmup.elapsedMs}ms` });
    const localeDebugPort = selection.language === 'en-US' ? 0 : await reserveLoopbackPort();
    // Keep the local Navo API gateway direct, but send every remote Chromium
    // destination opened by this API Codex task through its selected route.
    // The environment above applies the same rule to app-server and child tools.
    const desktopArgs = [
      `--proxy-server=http://127.0.0.1:${stableProxyPort}`,
      '--proxy-bypass-list=<local>;localhost;*.localhost;127.0.0.1;[::1]',
      `--lang=${selection.language}`,
      ...(localeDebugPort ? ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${localeDebugPort}`] : []),
    ];
    setCodexLaunchProgress({ stage: 'starting', message: '正在打开 Codex…', percent: 82 });
    spawnedPid = await spawnDetached(installation.executable, desktopArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: environment,
    });
    setCodexLaunchProgress({ stage: 'waiting', message: '正在等待 Codex 窗口…', percent: 92 });
    // Store-packaged Codex can spend well over ten seconds replacing its
    // bootstrap process after app-server migrations. Restoring config during
    // that interval leaves the late desktop process without codex_navo.
    const processPid = await waitForCodexDesktop(60_000);
    if (!processPid) throw new Error(`Codex 启动进程 ${spawnedPid} 已退出`);
    if (localeDebugPort) {
      await applyDesktopLocaleBridge(localeDebugPort, selection.language);
      audit('api.codex.locale-applied', { result: `${keyId}:${selection.language}` });
    }
    activeRecord = {
      ...activeRecord,
      processPid,
      processIdentity: codexProcessIdentity(detectCodexDesktopSnapshot({ preferCache: false })),
      status: 'running',
    };
    writeJsonAtomic(ACTIVE_API_CODEX_FILE, activeRecord);
    audit('api.codex.started', { result: keyId });
    closeTransaction();
    return processPid;
  } catch (error) {
    if (spawnedPid) {
      const snapshot = detectCodexDesktopSnapshot({ preferCache: false });
      if (snapshot.pid && activeRecord) {
        const recovered = {
          ...activeRecord,
          processPid: snapshot.pid,
          processIdentity: codexProcessIdentity(snapshot),
          status: 'running',
        };
        writeJsonAtomic(ACTIVE_API_CODEX_FILE, recovered);
        audit('api.codex.started', { result: `${keyId}:recovered-after-launch-warning` });
        closeTransaction();
        return snapshot.pid;
      }
      if (isProcessAlive(spawnedPid)) {
        spawnSync('taskkill.exe', ['/PID', String(spawnedPid), '/T', '/F'], {
          encoding: 'utf8', windowsHide: true, timeout: 12_000,
        });
      }
    }
    if (activeRecord || fs.existsSync(ACTIVE_API_CODEX_FILE)) {
      restoreApiKeyCodexHome(activeRecord || undefined);
    }
    closeTransaction();
    throw error;
  }
}

function stopApiKeyCodex(keyId) {
  const active = readJson(ACTIVE_API_CODEX_FILE, null);
  if (!active || active.keyId !== keyId) return;
  const snapshot = detectCodexDesktopSnapshot({ preferCache: false });
  const ownsSnapshot = active.processIdentity
    ? codexProcessIdentityMatches(active.processIdentity, snapshot)
    : Number(active.processPid) > 0 && Number(active.processPid) === snapshot.pid;
  const pid = ownsSnapshot ? snapshot.pid : null;
  if (pid && isProcessAlive(pid)) {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8', windowsHide: true, timeout: 12_000,
    });
    spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Wait-Process -Id ${pid} -Timeout 8 -ErrorAction SilentlyContinue`], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    const remaining = detectCodexDesktopSnapshot({ preferCache: false });
    if (remaining.pid) throw new Error('API Codex 尚未完全退出，请稍后重试');
  }
  restoreApiKeyCodexHome(active);
}

function sanitizeLoginResponse(urlValue, method, status, contentType) {
  try {
    const target = new URL(urlValue);
    if (!['auth.openai.com', 'chatgpt.com'].includes(target.hostname)) return '';
    return `${String(method || 'GET').toUpperCase()} ${target.hostname}${target.pathname} 返回 HTTP ${Number(status) || 0}（${String(contentType || '未知类型').slice(0, 80)}）`;
  } catch {
    return '';
  }
}

async function attachOfficialLoginDiagnostics(account, pending, browser) {
  if (!browser?.port || typeof WebSocket !== 'function') return;
  const requests = new Map();
  let socket = null;
  try {
    const targets = await fetch(`http://127.0.0.1:${browser.port}/json/list`, { signal: AbortSignal.timeout(1_500) }).then((response) => response.json());
    const target = targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
    if (!target) return;
    socket = new WebSocket(target.webSocketDebuggerUrl);
    pending.devtoolsSocket = socket;
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Network.enable' })));
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data || '')); } catch { return; }
      if (message.method === 'Network.requestWillBeSent') {
        requests.set(message.params.requestId, {
          method: message.params.request?.method || 'GET',
          url: message.params.request?.url || '',
          type: message.params.type || '',
        });
        if (requests.size > 500) requests.delete(requests.keys().next().value);
        return;
      }
      if (message.method !== 'Network.responseReceived') return;
      const request = requests.get(message.params.requestId) || {};
      const response = message.params.response || {};
      const resourceType = String(message.params.type || request.type || '');
      if (!/^(?:Fetch|XHR)$/i.test(resourceType)) return;
      const contentType = String(response.headers?.['content-type'] || response.headers?.['Content-Type'] || response.mimeType || '');
      if (!/html/i.test(contentType)) return;
      const diagnostic = sanitizeLoginResponse(response.url || request.url, request.method, response.status, contentType);
      if (!diagnostic) return;
      audit('codex.login.browser-response', { accountId: account.id, operator: pending.operator, result: diagnostic });
      // Diagnostic evidence only. Telemetry endpoints such as
      // /awe/api/v2/rum may return an HTML challenge while OAuth continues.
      // The Codex app-server remains the source of truth for login outcome.
      pending.browserDiagnostics ||= [];
      pending.browserDiagnostics.push(diagnostic);
      pending.browserDiagnostics = pending.browserDiagnostics.slice(-20);
    });
  } catch (error) {
    audit('codex.login.diagnostics-unavailable', { accountId: account.id, operator: pending.operator, result: error.message });
  }
}

function watchOfficialLoginBrowser(account, pending, browser) {
  pending.browser = browser;
  pending.browserWatchTimer = setInterval(async () => {
    if (pending.status === 'complete' || pending.status === 'error') return;
    if (await resolveAccountBrowserDebugPort(account, browser)) return;
    // Chrome can replace its main process while completing a web sign-in. Its
    // DevTools endpoint briefly disappears and DevToolsActivePort may then be
    // rewritten. Keep resolving the profile port before treating that normal
    // process transition as the user closing the login window.
    if (Date.now() - browser.debugUnavailableSince < 30_000) return;
    if (isProcessAlive(Number(browser.processPid))) return;
    pending.fail('登录窗口已关闭，授权任务已自动取消并释放账号');
  }, 1_000);
  pending.browserWatchTimer.unref?.();
  // CDP network inspection is opt-in because an attached DevTools session can
  // itself change the behavior of anti-bot pages. Normal login only uses the
  // debug endpoint for liveness and leaves the page untouched.
  if (process.env.CODEX_NAVO_LOGIN_DIAGNOSTICS === '1') {
    attachOfficialLoginDiagnostics(account, pending, browser);
  }
}

function watchAccountBrowserWebLogin(account, browser) {
  clearTimeout(browserWebLoginWatchers.get(account.id));
  const deadline = Date.now() + 15 * 60 * 1000;
  const check = async () => {
    browserWebLoginWatchers.delete(account.id);
    if (account.webLoginComplete || Date.now() >= deadline) return;
    const port = await resolveAccountBrowserDebugPort(account, browser);
    if (!port) {
      const timer = setTimeout(check, 1_000);
      timer.unref?.();
      browserWebLoginWatchers.set(account.id, timer);
      return;
    }
    try {
      const session = await injectProtocolCookies({
        port,
        cookies: [],
        allowUnauthenticated: true,
        verificationDelayMs: 200,
        verificationAttempts: 1,
        navigationUrl: '',
      });
      if (session.verified) {
        account.webLoginComplete = true;
        account.setupStage = 'complete';
        saveAccounts([...accounts]);
        audit('codex.login.web-session-linked', { accountId: account.id, operator: '本机用户', result: 'account-browser' });
        return;
      }
    } catch (error) {
      audit('codex.login.web-session-check', { accountId: account.id, result: error.message });
    }
    const timer = setTimeout(check, 2_000);
    timer.unref?.();
    browserWebLoginWatchers.set(account.id, timer);
  };
  const timer = setTimeout(check, 1_000);
  timer.unref?.();
  browserWebLoginWatchers.set(account.id, timer);
}

async function waitForWebLoginThenOpenCodexOAuth(account, operator, pending, browser) {
  while (!['complete', 'error'].includes(pending.status)) {
    const port = await resolveAccountBrowserDebugPort(account, browser);
    if (!port) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    // Poll only Chrome's loopback target list while the user is on the login
    // page. This avoids repeatedly calling ChatGPT's session endpoint during
    // credentials, challenge, or MFA screens. Probe the real session once the
    // browser has navigated away from the login route, then throttle retries.
    if (!await accountBrowserReadyForSessionProbe(port)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    if (Date.now() - Number(browser.lastWebSessionProbeAt || 0) < 1_500) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }
    browser.lastWebSessionProbeAt = Date.now();
    try {
      const session = await injectProtocolCookies({
        port,
        cookies: [],
        allowUnauthenticated: true,
        verificationDelayMs: 200,
        verificationAttempts: 1,
        navigationUrl: '',
      });
      if (session.verified) {
        account.webLoginComplete = true;
        account.setupStage = 'oauth';
        saveAccounts([...accounts]);
        pending.webLoginComplete = true;
        pending.status = 'waiting';
        pending.promptHint = 'ChatGPT 网页登录已完成，正在继续 Codex 授权';
        saveAuthAttempt(account.id, {
          flow: 'browser', status: 'waiting', error: '', promptHint: pending.promptHint,
        });
        const navigationPort = await resolveAccountBrowserDebugPort(account, browser);
        if (!navigationPort) throw new Error('Chrome 登录页面正在重新连接，请稍后重试');
        await navigateProtocolPage({ port: navigationPort, url: pending.authUrl });
        audit('codex.login.web-session-linked', { accountId: account.id, operator, result: 'before-codex-oauth' });
        return;
      }
    } catch (error) {
      audit('codex.login.web-session-check', { accountId: account.id, operator, result: error.message });
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function resetIncompleteLoginBrowser(account) {
  if (account.webLoginComplete) return;
  const { browserDir } = accountPaths(account);
  const activePortFile = path.join(browserDir, 'DevToolsActivePort');
  const activePort = await readLiveChromeDebugPort(activePortFile);
  if (activePort) {
    // Reuse the already authenticated account-local Chrome. A fresh official
    // OAuth URL is generated for every retry and the watcher navigates this
    // existing browser as soon as the ChatGPT session is verified.
    audit('codex.login.browser-state-preserved', {
      accountId: account.id,
      result: `active-browser-retry:${activePort}`,
    });
    return;
  }
  fs.mkdirSync(browserDir, { recursive: true });
  // Preserve cookies, local storage and Cloudflare clearance between retries.
  // Recreating the whole profile makes every retry a brand-new browser and can
  // trap the user in repeated human-verification challenges.
  fs.rmSync(activePortFile, { force: true });
  audit('codex.login.browser-state-preserved', { accountId: account.id, result: 'incomplete-login-retry' });
}

async function completeCodexLogin(account, operator, pending) {
  if (pending.status === 'complete' || pending.status === 'error') return;
  if (!isCodexAuthenticated(account)) {
    pending.credentialDeadline ||= Date.now() + 5_000;
    if (Date.now() < pending.credentialDeadline) {
      setTimeout(() => { completeCodexLogin(account, operator, pending); }, 150);
      return;
    }
    pending.fail('Codex 登录已返回成功，但没有保存账号凭证，请重新发起授权');
    return;
  }
  if (!pending.webLoginPrompted) {
    pending.status = 'finalizing';
    saveAuthAttempt(account.id, { flow: 'browser', status: 'finalizing', error: '' });
  }
  let webLoginComplete = account.webLoginComplete === true || pending.webLoginComplete === true;
  const completionPort = !webLoginComplete && pending.browser
    ? await resolveAccountBrowserDebugPort(account, pending.browser)
    : 0;
  if (!webLoginComplete && completionPort) {
    try {
      const webSession = await injectProtocolCookies({
        port: completionPort,
        cookies: [],
        allowUnauthenticated: true,
        verificationDelayMs: 1_000,
        navigationUrl: pending.webLoginPrompted ? '' : CHATGPT_LOGIN_URL,
      });
      webLoginComplete = webSession.verified === true;
      if (!webLoginComplete) {
        pending.webLoginPrompted = true;
        pending.status = 'web-login';
        saveAuthAttempt(account.id, {
          flow: 'browser',
          status: 'web-login',
          error: '',
          promptHint: 'Codex 授权已完成，请在当前 Chrome 中完成 ChatGPT 网页登录',
        });
        clearTimeout(pending.webLoginTimer);
        pending.webLoginTimer = setTimeout(() => { completeCodexLogin(account, operator, pending); }, 1_500);
        pending.webLoginTimer.unref?.();
        return;
      }
    } catch (error) {
      audit('codex.login.web-session-pending', { accountId: account.id, operator, result: error.message });
      pending.webLoginPrompted = true;
      pending.status = 'web-login';
      saveAuthAttempt(account.id, {
        flow: 'browser',
        status: 'web-login',
        error: '',
        promptHint: 'Codex 授权已完成，请在当前 Chrome 中完成 ChatGPT 网页登录',
      });
      clearTimeout(pending.webLoginTimer);
      pending.webLoginTimer = setTimeout(() => { completeCodexLogin(account, operator, pending); }, 1_500);
      pending.webLoginTimer.unref?.();
      return;
    }
  }
  pending.status = 'complete';
  clearTimeout(pending.timeout);
  clearTimeout(pending.webLoginTimer);
  clearInterval(pending.browserWatchTimer);
  try { pending.devtoolsSocket?.close(); } catch {}
  pendingCodexLogins.delete(account.id);
  clearAuthAttempt(account.id);
  account.setupStage = 'complete';
  account.webLoginComplete = webLoginComplete;
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

async function startCodexBrowserLogin(account, operator, options = {}) {
  cancelPendingCodexLogin(account.id);
  const otherPending = [...pendingCodexLogins.entries()].find(([accountId, pending]) => (
    accountId !== account.id && !['complete', 'error'].includes(pending.status)
  ));
  if (otherPending) throw new Error('已有另一个账号正在登录授权，请先完成或取消后再继续');
  if (options.resetBrowserState) await resetIncompleteLoginBrowser(account);
  // Start the account-local route first. The OAuth URL callback below performs
  // the single route preflight; probing the whole auth chain repeatedly before
  // Chrome opens creates unnecessary anti-bot traffic from the same exit IP.
  await prepareAccountNetwork(account);
  const { codexHomeDir } = accountPaths(account);
  ensureCodexProfileConfig(codexHomeDir);
  const executable = findCodexCli();
  const child = spawn(executable, ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: codexEnvironment({ ...process.env, CODEX_HOME: codexHomeDir, NO_COLOR: '1', TERM: 'dumb' }, account),
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
    clearTimeout(pending.webLoginTimer);
    clearInterval(pending.browserWatchTimer);
    try { pending.devtoolsSocket?.close(); } catch {}
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
    pendingCodexLogins.delete(account.id);
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
      pending.status = 'checking-route';
      saveAuthAttempt(account.id, { flow: 'browser', status: 'checking-route', error: '' });
      prepareAccountNetwork(account, { preflight: true, purpose: '官方 OAuth' })
        .then(() => {
          if (pending.status === 'error' || pending.status === 'complete') return;
          pending.status = 'web-login';
          pending.promptHint = '请先登录 ChatGPT 网页端，登录成功后将自动继续 Codex 授权';
          saveAuthAttempt(account.id, { flow: 'browser', status: 'web-login', error: '', promptHint: pending.promptHint });
          if (pending.browserOpened) return;
          pending.browserOpened = true;
          return launchAccountBrowser(account, CHATGPT_LOGIN_URL, { returnSession: true, initialUrls: [CHATGPT_LOGIN_URL] })
            .then((browser) => {
              watchOfficialLoginBrowser(account, pending, browser);
              waitForWebLoginThenOpenCodexOAuth(account, operator, pending, browser)
                .catch((error) => fail(`网页登录完成后无法继续 Codex 授权：${error.message}`));
              audit('codex.login.browser-opened', { accountId: account.id, operator, result: `browser-web-first:${browser.port}` });
            });
        })
        .catch((error) => fail(`所选线路无法完成官方登录：${error.message}`));
      return;
    }
    if (message.method === 'account/login/completed') {
      if (pending.loginId && message.params?.loginId !== pending.loginId) return;
      if (!message.params?.success) {
        fail(message.params?.error || 'Codex 登录授权没有完成');
        return;
      }
      setTimeout(() => { completeCodexLogin(account, operator, pending); }, 150);
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

async function startCodexDeviceLogin(account, operator) {
  cancelPendingCodexLogin(account.id);
  await prepareAccountNetwork(account);
  const { codexHomeDir } = accountPaths(account);
  ensureCodexProfileConfig(codexHomeDir);
  const executable = findCodexCli();
  const child = spawn(executable, ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: codexEnvironment({ ...process.env, CODEX_HOME: codexHomeDir, NO_COLOR: '1', TERM: 'dumb' }, account),
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

async function launchAccount(account, launchType, operator, launchOptions = null) {
  if (account.accountKind === 'relay') throw new Error('临时账号仅用于 API 服务，不会打开网页端或 Codex');
  const { browserDir, codexDir, codexHomeDir, codexDesktopDir, codexSqliteDir } = accountPaths(account);
  fs.mkdirSync(browserDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  if (settings.mockLaunch) return null;

  if (launchType === 'browser') {
    const browserUrl = account.webLoginComplete ? settings.browserStartUrl : CHATGPT_LOGIN_URL;
    const browser = await launchAccountBrowser(account, browserUrl, {
      returnSession: account.webLoginComplete !== true,
      restoreLastSession: true,
      initialUrls: [IP_CHECK_URL, browserUrl],
    });
    if (account.webLoginComplete !== true && browser?.port) {
      watchAccountBrowserWebLogin(account, browser);
      return browser.processPid;
    }
    return browser;
  }

  if (findRunningCodexDesktopPid()) {
    throw new Error('Codex 桌面端是单实例应用。请先关闭当前 Codex 窗口，再从账号池启动目标账号');
  }
  if (!isCodexAuthenticated(account) || account.quotaErrorCode === 'auth_expired') {
    throw new Error('该账号授权已失效，请先点击“重新授权”');
  }
  return launchCodexDesktop(account, launchOptions);
}

function accountView(account, context = {}) {
  const { browserDir, codexDir, codexHomeDir, codexDesktopDir } = accountPaths(account);
  const codexInitialized = isCodexAuthenticated(account) && account.quotaErrorCode !== 'auth_expired';
  const hasActiveApiCodex = typeof context.hasActiveApiCodex === 'boolean'
    ? context.hasActiveApiCodex
    : Boolean(readActiveApiCodex());
  const activeAccountId = hasActiveApiCodex ? '' : (context.activeAccountId || activeCodexAccountId(context.codexSnapshot));
  return {
    id: account.id,
    label: account.label,
    emailHint: account.emailHint || '',
    browserType: 'chrome',
    enabled: account.enabled !== false,
    createdAt: account.createdAt,
    planExpiresAt: account.planExpiresAt || null,
    planExpiryCheckedAt: account.planExpiryCheckedAt || null,
    planExpiryError: account.planExpiryError || '',
    quota: account.quota || null,
    codexActive: activeAccountId === account.id,
    browserInitialized: fs.existsSync(path.join(browserDir, 'Local State')),
    webLoginComplete: account.webLoginComplete === true,
    codexInitialized,
    setupStage: codexInitialized ? 'complete' : account.webLoginComplete ? 'oauth' : account.setupStage || 'web-login',
    quotaError: account.quotaError || '',
    quotaErrorCode: account.quotaErrorCode || '',
    quotaCheckedAt: account.quotaCheckedAt || null,
    authSource: account.authSource || 'local-login',
    accountKind: account.accountKind || 'regular',
    relaySource: account.relaySource || '',
    relayTemporary: account.relayTemporary === true,
    relayExpiresAt: account.relayExpiresAt || null,
    desktopLaunchAllowed: account.accountKind !== 'relay',
    loginMethod: account.loginMethod || 'official',
    network: networkManager.publicAssignment(account.id),
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
      account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, await backgroundTaskEnvironment(process.env));
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
        account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, await backgroundTaskEnvironment(process.env));
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

const MANAGED_CODEX_EXIT_GRACE_MS = 20_000;

function cleanLeases(codexSnapshot = detectCodexDesktopSnapshot()) {
  const result = cleanExpiredLeases(leases);
  let changed = result.changed;
  const next = { ...result.leases };
  for (const [accountId, lease] of Object.entries(next)) {
    if (!accounts.some((account) => account.id === accountId)) {
      delete next[accountId];
      changed = true;
      audit('lease.auto-release', { accountId, operator: lease?.operator, result: 'account-removed' });
      continue;
    }
    if (lease.launchType === 'codex' && lease.processIdentity && codexSnapshot.reliable
      && !codexProcessIdentityMatches(lease.processIdentity, codexSnapshot)) {
      if (codexSnapshot.pid) {
        next[accountId] = {
          ...lease,
          processPid: codexSnapshot.pid,
          processIdentity: codexProcessIdentity(codexSnapshot),
          missingSince: undefined,
        };
        const active = readActiveCodexAuth();
        if (active?.accountId === accountId) {
          const rebound = { ...active, processIdentity: codexProcessIdentity(codexSnapshot) };
          delete rebound.missingSince;
          writeJsonAtomic(ACTIVE_CODEX_AUTH_FILE, rebound);
        }
        changed = true;
        audit('lease.process-reconciled', { accountId, operator: lease.operator, result: String(codexSnapshot.pid) });
        continue;
      }
      if (isProcessAlive(Number(lease.processIdentity.pid))) continue;
    }
    if (lease.processPid && !isProcessAlive(lease.processPid)) {
      if (lease.launchType === 'codex' && codexSnapshot.reliable && codexSnapshot.pid) {
        next[accountId] = { ...lease, processPid: codexSnapshot.pid };
        changed = true;
        audit('lease.process-reconciled', { accountId, operator: lease.operator, result: String(codexSnapshot.pid) });
        continue;
      }
      if (lease.launchType === 'codex') {
        const missingSince = Date.parse(lease.missingSince || '');
        if (!Number.isFinite(missingSince)) {
          next[accountId] = { ...lease, missingSince: new Date().toISOString() };
          changed = true;
          continue;
        }
        if (Date.now() - missingSince < MANAGED_CODEX_EXIT_GRACE_MS) continue;
        if (!restoreSharedCodexAuth(accountId)) continue;
      }
      delete next[accountId];
      changed = true;
      audit('lease.auto-release', { accountId, operator: lease.operator, result: 'process-exited' });
    }
  }
  const activeAuth = readActiveCodexAuth();
  const launchPending = Object.values(next).some((lease) => lease.launchType === 'codex' && !lease.processPid);
  const activeProcessMissing = activeAuth?.processIdentity
    ? !codexProcessIdentityMatches(activeAuth.processIdentity, codexSnapshot)
    : !codexSnapshot.pid;
  if (activeAuth && codexSnapshot.reliable && activeProcessMissing && !launchPending) {
    if (codexSnapshot.pid) {
      const rebound = { ...activeAuth, processIdentity: codexProcessIdentity(codexSnapshot) };
      delete rebound.missingSince;
      writeJsonAtomic(ACTIVE_CODEX_AUTH_FILE, rebound);
    } else if (!isProcessAlive(Number(activeAuth.processIdentity?.pid))) {
      const missingSince = Date.parse(activeAuth.missingSince || '');
      if (!Number.isFinite(missingSince)) {
        writeJsonAtomic(ACTIVE_CODEX_AUTH_FILE, { ...activeAuth, missingSince: new Date().toISOString() });
      } else if (Date.now() - missingSince >= MANAGED_CODEX_EXIT_GRACE_MS) {
        restoreSharedCodexAuth(activeAuth.accountId);
      }
    }
  }
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
  const extension = path.extname(fullPath).toLowerCase();
  const type = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.wav': 'audio/wav', '.png': 'image/png' }[extension] || 'application/octet-stream';
  response.writeHead(200, securityHeaders({ 'Content-Type': type }));
  fs.createReadStream(fullPath).pipe(response);
}

async function importRelayAccounts(value, operator) {
  const parsed = parseRelayAccountPackage(value);
  const imported = [];
  const reservedLabels = new Set(accounts.map((account) => account.label));
  const uniqueLabel = (label) => {
    const base = String(label || '临时账号').replace(/[\r\n\t]/g, ' ').trim().slice(0, 60) || '临时账号';
    if (!reservedLabels.has(base)) { reservedLabels.add(base); return base; }
    let index = 2;
    while (reservedLabels.has(`${base} (${index})`)) index += 1;
    const next = `${base} (${index})`.slice(0, 60);
    reservedLabels.add(next);
    return next;
  };
  for (const entry of parsed) {
    const identity = authIdentity(entry.auth);
    const duplicate = existingAuthIdentity(identity);
    if (duplicate) throw new Error(`第三方数据中的账号已经存在于“${duplicate.label}”`);
    const account = {
      id: `account-${crypto.randomBytes(6).toString('hex')}`,
      label: uniqueLabel(entry.label),
      emailHint: entry.email,
      browserType: 'chrome',
      enabled: true,
      setupStage: 'complete',
      webLoginComplete: false,
      accountKind: 'relay',
      authSource: `third-party-${entry.format}`,
      relaySource: entry.format,
      relayTemporary: entry.temporary,
      relayExpiresAt: entry.expiresAt,
      importedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    const { codexDir, codexHomeDir } = accountPaths(account);
    try {
      ensureCodexProfileConfig(codexHomeDir);
      writeJsonAtomic(path.join(codexHomeDir, 'auth.json'), entry.auth);
      imported.push(account);
    } catch (error) {
      if (isWithin(CODEX_PROFILES_DIR, codexDir)) fs.rmSync(codexDir, { recursive: true, force: true });
      throw error;
    }
  }
  saveAccounts([...accounts, ...imported]);
  for (const account of imported) {
    audit('relay-account.imported', {
      accountId: account.id,
      operator,
      result: `${account.relaySource}:${account.relayTemporary ? 'temporary' : 'refreshable'}`,
    });
  }
  if (!settings.mockLaunch) {
    void (async () => {
      for (const account of imported) {
        try {
          const { codexHomeDir } = accountPaths(account);
          account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, await backgroundTaskEnvironment(process.env));
          account.quotaError = '';
          account.quotaErrorCode = '';
          account.quotaCheckedAt = account.quota.refreshedAt;
        } catch (error) {
          account.quotaError = account.relayTemporary ? '临时凭证暂未读取到额度' : '临时凭证已导入，额度读取暂时失败';
          account.quotaErrorCode = 'fetch_failed';
          account.quotaCheckedAt = new Date().toISOString();
          audit('relay-account.quota-failed', { accountId: account.id, result: error.message });
        }
        saveAccounts([...accounts]);
      }
    })();
  }
  return imported;
}

async function apiGatewayHandler(request, response) {
  const requestId = `req_${crypto.randomBytes(12).toString('hex')}`;
  response.setHeader('x-request-id', requestId);
  let abortContext = null;
  try {
    if (!apiServiceManager.config.enabled) return sendOpenAiError(response, 503, 'Codex Navo API 服务尚未启用', 'service_unavailable');
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    const keyRecord = apiServiceManager.authenticate(request.headers.authorization);
    if (!keyRecord) return sendOpenAiError(response, 401, 'API Key 无效', 'authentication_error');
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(response, 200, { object: 'list', data: apiServiceManager.modelsForKey(keyRecord) });
    }
    if (request.method === 'GET' && url.pathname === '/v1/pool/health') {
      const pool = accountPoolHealth(keyRecord);
      return sendJson(response, 200, {
        object: 'account_pool.health',
        status: pool.some((item) => item.status === 'available') ? 'available' : 'unavailable',
        request_id: requestId,
        limits: {
          request_bytes: MAX_API_REQUEST_BYTES,
          response_bytes: MAX_RESPONSE_BYTES,
          timeout_seconds: 600,
          max_output_tokens: 'accepted; account-backed upstream does not expose a strict token cutoff',
        },
        accounts: pool,
      });
    }
    if (request.method === 'POST' && url.pathname === '/v1/responses') {
      const raw = await readRawBody(request, MAX_API_REQUEST_BYTES);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); }
      catch { return sendOpenAiError(response, 400, '请求不是有效的 JSON'); }
      if (body.max_output_tokens != null && (!Number.isInteger(body.max_output_tokens) || body.max_output_tokens <= 0)) {
        return sendOpenAiError(response, 400, 'max_output_tokens 必须是正整数', 'invalid_request_error', 'invalid_max_output_tokens');
      }
      abortContext = createGatewayAbort(request, response);
      const result = await apiServiceManager.forwardResponses({
        keyRecord,
        body,
        upstreamHeaders: codexUpstreamHeaders(request.headers),
        signal: abortContext.signal,
      });
      if (!result.upstream.ok) {
        const contentType = result.upstream.headers.get('content-type') || '';
        const text = (await result.upstream.text()).slice(0, 4096);
        const message = upstreamMessage(result.upstream.status, contentType, text);
        auditUpstreamFailure(result.upstream.status, result.model, body, message);
        apiServiceManager.recordUsage(keyRecord, {}, result.model);
        await result.cleanup?.();
        abortContext.cleanup();
        return sendOpenAiError(response, result.upstream.status, message, 'upstream_error');
      }
      const contentType = result.upstream.headers.get('content-type') || '';
      if (!body.stream) {
        const text = await result.upstream.text();
        await result.cleanup?.();
        abortContext.cleanup();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return sendOpenAiError(response, 502, '上游响应过大', 'upstream_error');
        const payload = responsesSseToJson(text, { maxOutputTokens: body.max_output_tokens });
        if (!payload) return sendOpenAiError(response, 502, '上游没有返回完整 Responses 结果', 'upstream_error');
        apiServiceManager.recordUsage(keyRecord, extractUsage(payload), result.model);
        response.writeHead(200, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
        response.end(JSON.stringify(payload));
        return;
      }
      if (body.stream || contentType.includes('text/event-stream')) {
        response.writeHead(200, securityHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        }));
        let usageRecorded = false;
        if (!result.upstream.body) { abortContext.cleanup(); await result.cleanup?.(); return response.end(); }
        const stream = Readable.fromWeb(result.upstream.body);
        const usageTap = createUsageTap((usage) => { usageRecorded = true; apiServiceManager.recordUsage(keyRecord, usage, result.model); });
        const transform = createResponsesSseTransform({ maxOutputTokens: body.max_output_tokens });
        const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(': navo-heartbeat\n\n'); }, 15_000);
        heartbeat.unref?.();
        const cleanup = () => { clearInterval(heartbeat); abortContext.cleanup(); result.cleanup?.(); };
        stream.once('error', () => { if (!usageRecorded) apiServiceManager.recordUsage(keyRecord, {}, result.model); cleanup(); response.end(); });
        usageTap.once('end', () => { if (!usageRecorded) apiServiceManager.recordUsage(keyRecord, {}, result.model); cleanup(); });
        response.once('close', cleanup);
        stream.pipe(usageTap).pipe(transform).pipe(response);
        return;
      }
      const buffer = Buffer.from(await result.upstream.arrayBuffer());
      await result.cleanup?.();
      abortContext.cleanup();
      if (buffer.length > MAX_RESPONSE_BYTES) return sendOpenAiError(response, 502, '上游响应过大', 'upstream_error');
      let payload;
      try { payload = JSON.parse(buffer.toString('utf8')); }
      catch { return sendOpenAiError(response, 502, '上游没有返回有效 JSON', 'upstream_error'); }
      apiServiceManager.recordUsage(keyRecord, extractUsage(payload), result.model);
      response.writeHead(200, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8' }));
      response.end(JSON.stringify(payload));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const raw = await readRawBody(request, MAX_API_REQUEST_BYTES);
      let chatBody;
      try { chatBody = JSON.parse(raw.toString('utf8')); }
      catch { return sendOpenAiError(response, 400, '请求不是有效的 JSON'); }
      if (!Array.isArray(chatBody.messages)) return sendOpenAiError(response, 400, 'messages 必须是数组');
      const requestedMaxOutputTokens = chatBody.max_completion_tokens ?? chatBody.max_tokens;
      if (requestedMaxOutputTokens != null && (!Number.isInteger(requestedMaxOutputTokens) || requestedMaxOutputTokens <= 0)) {
        return sendOpenAiError(response, 400, 'max_completion_tokens/max_tokens 必须是正整数', 'invalid_request_error', 'invalid_max_output_tokens');
      }
      const responsesBody = chatToResponses(chatBody);
      abortContext = createGatewayAbort(request, response);
      const result = await apiServiceManager.forwardResponses({
        keyRecord,
        body: responsesBody,
        upstreamHeaders: codexUpstreamHeaders(request.headers),
        signal: abortContext.signal,
      });
      if (!result.upstream.ok) {
        const contentType = result.upstream.headers.get('content-type') || '';
        const text = (await result.upstream.text()).slice(0, 4096);
        const message = upstreamMessage(result.upstream.status, contentType, text);
        auditUpstreamFailure(result.upstream.status, result.model, responsesBody, message);
        apiServiceManager.recordUsage(keyRecord, {}, result.model);
        await result.cleanup?.();
        abortContext.cleanup();
        return sendOpenAiError(response, result.upstream.status, message, 'upstream_error');
      }
      const contentType = result.upstream.headers.get('content-type') || '';
      if (!chatBody.stream) {
        const text = await result.upstream.text();
        await result.cleanup?.();
        abortContext.cleanup();
        if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return sendOpenAiError(response, 502, '上游响应过大', 'upstream_error');
        const payload = responsesSseToJson(text, { maxOutputTokens: responsesBody.max_output_tokens });
        if (!payload) return sendOpenAiError(response, 502, '上游没有返回完整 Responses 结果', 'upstream_error');
        apiServiceManager.recordUsage(keyRecord, extractUsage(payload), result.model);
        return sendJson(response, 200, responsesToChat(payload));
      }
      if (chatBody.stream || contentType.includes('text/event-stream')) {
        response.writeHead(200, securityHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        }));
        let usageRecorded = false;
        if (!result.upstream.body) { abortContext.cleanup(); await result.cleanup?.(); return response.end(); }
        const stream = Readable.fromWeb(result.upstream.body);
        const usageTap = createUsageTap((usage) => { usageRecorded = true; apiServiceManager.recordUsage(keyRecord, usage, result.model); });
        const transform = createChatSseTransform({ model: result.model });
        const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(': navo-heartbeat\n\n'); }, 15_000);
        heartbeat.unref?.();
        const cleanup = () => { clearInterval(heartbeat); abortContext.cleanup(); result.cleanup?.(); };
        stream.once('error', () => { if (!usageRecorded) apiServiceManager.recordUsage(keyRecord, {}, result.model); cleanup(); response.end(); });
        usageTap.once('end', () => { if (!usageRecorded) apiServiceManager.recordUsage(keyRecord, {}, result.model); cleanup(); });
        response.once('close', cleanup);
        stream.pipe(usageTap).pipe(transform).pipe(response);
        return;
      }
      const buffer = Buffer.from(await result.upstream.arrayBuffer());
      await result.cleanup?.();
      abortContext.cleanup();
      if (buffer.length > MAX_RESPONSE_BYTES) return sendOpenAiError(response, 502, '上游响应过大', 'upstream_error');
      let payload;
      try { payload = JSON.parse(buffer.toString('utf8')); }
      catch { return sendOpenAiError(response, 502, '上游没有返回有效 JSON', 'upstream_error'); }
      apiServiceManager.recordUsage(keyRecord, extractUsage(payload), result.model);
      return sendJson(response, 200, responsesToChat(payload));
    }
    return sendOpenAiError(response, 404, '接口不存在', 'not_found_error');
  } catch (error) {
    abortContext?.cleanup();
    if (response.headersSent || response.writableEnded) return;
    const aborted = error.name === 'AbortError' || error.code === 'UND_ERR_ABORTED';
    const message = aborted ? 'API 请求已取消或超时' : error.message || 'API 网关请求失败';
    return sendOpenAiError(
      response,
      aborted ? 408 : error.statusCode || 502,
      message,
      error.errorType || 'gateway_error',
      aborted ? 'request_aborted' : error.errorCode || null,
    );
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'GET' && ['/', '/floating.html'].includes(url.pathname) && url.searchParams.has('token')) {
      if (!safeEqual(url.searchParams.get('token'), accessToken)) return sendError(response, 403, '启动令牌无效');
      response.writeHead(302, securityHeaders({
        Location: url.pathname,
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
      const codexSnapshot = detectCodexDesktopSnapshot();
      cleanLeases(codexSnapshot);
      const apiServiceState = publicApiServiceState();
      const hasActiveApiCodex = Boolean(apiServiceState.activeKeyId);
      const activeAccountId = hasActiveApiCodex ? '' : activeCodexAccountId(codexSnapshot);
      const accountContext = { codexSnapshot, hasActiveApiCodex, activeAccountId };
      usageTracker.sync();
      return sendJson(response, 200, {
        ok: true,
        data: {
          accounts: accounts.map((account) => accountView(account, accountContext)),
          codexRunning: Boolean(codexSnapshot.pid),
          csrfToken,
          operators: settings.operators,
          mockLaunch: settings.mockLaunch,
          appVersion: APP_VERSION,
           wakeSettings: publicWakeSettings(),
           wakeModelOptions: wakeModelCatalog(),
           proxySettings: publicProxySettings(proxySettings),
           networkSettings: networkManager.publicState(),
            apiService: apiServiceState,
            usage: usageTracker.summary('today'),
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/usage') {
      usageTracker.sync();
      return sendJson(response, 200, { ok: true, data: usageTracker.summary(url.searchParams.get('range') || 'today') });
    }

    if (request.method === 'GET' && url.pathname === '/api/network-state') {
      return sendJson(response, 200, { ok: true, data: networkManager.publicState() });
    }

    if (request.method === 'GET' && url.pathname === '/api/floating-status') {
      return sendJson(response, 200, { ok: true, data: floatingWindowState() });
    }
    if (request.method === 'POST' && url.pathname === '/api/floating-status/refresh') {
      try { return sendJson(response, 200, { ok: true, data: await refreshFloatingWindowQuota() }); }
      catch (error) { return sendError(response, 502, error.message); }
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      return sendJson(response, 200, { ok: true, data: sessionMonitor.snapshot() });
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions/failed/clear') {
      const body = await readBody(request);
      try {
        const data = await sessionMonitor.clearFailed(body.mode || 'list');
        audit('session.failed.clear', { result: body.mode || 'list' });
        return sendJson(response, 200, { ok: true, data });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }

    const sessionActionMatch = url.pathname.match(/^\/api\/sessions\/([0-9a-f-]{8,64})\/(archive|delete)$/i);
    if (request.method === 'POST' && sessionActionMatch) {
      const [, sessionId, operation] = sessionActionMatch;
      try {
        const data = operation === 'archive'
          ? await sessionMonitor.archiveThread(sessionId)
          : await sessionMonitor.deleteThread(sessionId);
        audit(`session.${operation}`, { result: sessionId });
        return sendJson(response, 200, { ok: true, data });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/codex-launch-options') {
      try {
        if (!restoreStoppedLaunchStateBeforeCatalog()) {
          return sendError(response, 409, '请先退出当前 Codex，再选择下一次加载的项目和会话');
        }
        repairSharedCodexPreferences();
        return sendJson(response, 200, { ok: true, data: listCodexLaunchOptions(SHARED_CODEX_HOME) });
      } catch (error) {
        return sendError(response, 500, error.message);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/codex-launch-progress') {
      return sendJson(response, 200, { ok: true, data: { ...codexLaunchProgress } });
    }

    if (request.method === 'GET' && url.pathname === '/api/notification-settings') {
      return sendJson(response, 200, { ok: true, data: notificationService.publicSettings() });
    }

    if (request.method === 'POST' && url.pathname === '/api/notification-settings') {
      const body = await readBody(request);
      return sendJson(response, 200, { ok: true, data: notificationService.save(body) });
    }

    if (request.method === 'GET' && url.pathname === '/api/notification-events') {
      return sendJson(response, 200, { ok: true, data: notificationService.listEvents(url.searchParams.get('after')) });
    }

    if (request.method === 'POST' && url.pathname === '/api/notifications/test-local') {
      const body = await readBody(request);
      return sendJson(response, 200, { ok: true, data: notificationService.testLocal(body) });
    }

    if (request.method === 'POST' && url.pathname === '/api/notifications/test-channel') {
      const body = await readBody(request);
      try {
        return sendJson(response, 200, { ok: true, data: await notificationService.test(body.channel, body.settings || {}) });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/api-service') {
      return sendJson(response, 200, { ok: true, data: publicApiServiceState() });
    }

    if (request.method === 'POST' && url.pathname === '/api/api-service/models/detect') {
      const body = await readBody(request);
      try {
        const models = await detectSelectedAccountModels(body.accountIds);
        return sendJson(response, 200, { ok: true, data: models });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/api-service/config') {
      const body = await readBody(request);
      const previousPort = apiServiceManager.config.port;
      apiServiceManager.saveConfig(body);
      const data = publicApiServiceState();
      if (data.config.port !== previousPort) data.restartRequired = true;
      return sendJson(response, 200, { ok: true, data });
    }

    if (request.method === 'POST' && url.pathname === '/api/api-service/keys') {
      const body = await readBody(request);
      try { return sendJson(response, 201, { ok: true, data: { ...apiServiceManager.createKey(body), state: publicApiServiceState() } }); }
      catch (error) { return sendError(response, 400, error.message); }
    }

    const apiKeyNetworkMatch = url.pathname.match(/^\/api\/api-service\/keys\/([a-z0-9-]+)\/network$/);
    if (request.method === 'POST' && apiKeyNetworkMatch) {
      const keyId = apiKeyNetworkMatch[1];
      const key = apiServiceManager.keys.find((item) => item.id === keyId);
      if (!key) return sendError(response, 404, 'API Key 不存在');
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      const networkId = apiKeyNetworkId(keyId);
      const previousAssignment = networkManager.publicAssignment(networkId);
      try {
        const assignment = networkManager.assign(networkId, body);
        const runtime = await networkManager.ensureAccount(networkId);
        const activeApi = readJson(ACTIVE_API_CODEX_FILE, null);
        if (activeApi?.keyId === keyId) {
          if (assignment.mode === 'proxy') {
            const preflight = await networkManager.preflightAccount(networkId, 12_000);
            if (!preflight.ok) throw new Error(`新线路检测未通过：${preflight.message}`);
            audit('api.key.network.hot-switch-validated', { operator, result: `${keyId}:${preflight.status}:${preflight.latencyMs || 0}ms` });
          }
          await prepareStableApiCodexProxy(runtime);
          audit('api.codex.proxy-relay-switched', { operator, result: `${keyId}:${runtime?.mixedPort || 'DIRECT'}` });
        }
        audit('api.key.network.updated', { operator, result: `${keyId}:${assignment.label}` });
        return sendJson(response, 200, { ok: true, data: { assignment, networkSettings: networkManager.publicState() } });
      } catch (error) {
        try {
          networkManager.assign(networkId, previousAssignment);
          const rollbackRuntime = await networkManager.ensureAccount(networkId);
          const activeApi = readJson(ACTIVE_API_CODEX_FILE, null);
          if (activeApi?.keyId === keyId) await prepareStableApiCodexProxy(rollbackRuntime);
        } catch (rollbackError) {
          audit('api.key.network.rollback-failed', { operator, result: `${keyId}:${rollbackError.message}` });
        }
        return sendError(response, 502, `切换 API 账号池线路失败，已恢复原线路：${error.message}`);
      }
    }

    const apiKeyLaunchMatch = url.pathname.match(/^\/api\/api-service\/keys\/([a-z0-9-]+)\/(launch|stop|wake|refresh)$/);
    if (request.method === 'POST' && apiKeyLaunchMatch) {
      const [, keyId, operation] = apiKeyLaunchMatch;
      try {
        if (operation === 'launch') {
          const body = await readBody(request);
          const key = apiServiceManager.keys.find((item) => item.id === keyId);
          startCodexLaunchProgress('api', key?.name || 'Navo API');
          await launchApiKeyCodex(keyId, body.launchOptions || null);
          completeCodexLaunchProgress();
        }
        else if (operation === 'stop') stopApiKeyCodex(keyId);
        else {
          const key = apiServiceManager.keys.find((item) => item.id === keyId);
          if (!key) throw new Error('API Key 不存在');
          const pool = accountPoolCandidates(key.accountIds);
          if (!pool.length) throw new Error('该 API Key 没有可用的底层账号');
          const apiEnvironment = await apiKeyTaskEnvironment(keyId, process.env);
          if (operation === 'wake') {
            for (const account of pool) {
              await wakeAccount(account, 'manual', 'Navo API', await apiKeyTaskEnvironment(keyId, {
                ...process.env, CODEX_HOME: accountPaths(account).codexHomeDir, NO_COLOR: '1', TERM: 'dumb',
              }));
            }
          } else {
            for (const account of pool) {
              try {
                const { codexHomeDir } = accountPaths(account);
                account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, apiEnvironment);
                account.quotaError = '';
                account.quotaErrorCode = '';
                account.quotaCheckedAt = account.quota.refreshedAt;
              } catch (error) { account.quotaError = error.message; }
            }
            saveAccounts([...accounts]);
          }
        }
        return sendJson(response, 200, { ok: true, data: publicApiServiceState() });
      } catch (error) {
        if (operation === 'launch') failCodexLaunchProgress(error);
        return sendError(response, 500, error.message);
      }
    }

    const apiKeyMatch = url.pathname.match(/^\/api\/api-service\/keys\/([a-z0-9-]+)$/);
    if (apiKeyMatch) {
      const keyId = apiKeyMatch[1];
      if (request.method === 'POST') {
        const body = await readBody(request);
        try { return sendJson(response, 200, { ok: true, data: { key: apiServiceManager.updateKey(keyId, body), state: publicApiServiceState() } }); }
        catch (error) { return sendError(response, 404, error.message); }
      }
      if (request.method === 'DELETE') {
        try { apiServiceManager.removeKey(keyId); return sendJson(response, 200, { ok: true, data: publicApiServiceState() }); }
        catch (error) { return sendError(response, 404, error.message); }
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/network/background-route') {
      try {
        const runtime = await backgroundTaskRuntime();
        return sendJson(response, 200, {
          ok: true,
          data: runtime ? {
            proxyUrl: `http://127.0.0.1:${runtime.mixedPort}`,
            bypass: 'localhost,127.0.0.1,::1,*.localhost',
            sourceId: runtime.sourceId || '',
            nodeName: runtime.nodeName || '',
          } : { proxyUrl: '', bypass: '', sourceId: '', nodeName: '' },
        });
      } catch (error) {
        return sendError(response, 502, `后台任务代理准备失败：${error.message}`);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/network/sources') {
      const body = await readBody(request);
      requireOperator(body.operator);
      try {
        const added = networkManager.addSource(body.input, body.name);
        let source = added;
        let warning = '';
        try { source = await networkManager.refreshSource(added.id); }
        catch (error) { warning = error.message; }
        audit('network.source.added', { result: `${source.kind}:${source.name}` });
        return sendJson(response, 201, { ok: true, data: { source, warning, networkSettings: networkManager.publicState() } });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }

    const networkSourceMatch = url.pathname.match(/^\/api\/network\/sources\/(network-[a-f0-9]{12})(?:\/(refresh|test|test-all))?$/);
    if (networkSourceMatch) {
      const [, sourceId, operation] = networkSourceMatch;
      const body = request.method === 'GET' ? {} : await readBody(request);
      if (request.method !== 'GET') requireOperator(body.operator);
      try {
        if (request.method === 'DELETE' && !operation) {
          networkManager.removeSource(sourceId);
          audit('network.source.removed', { result: sourceId });
          return sendJson(response, 200, { ok: true, data: networkManager.publicState() });
        }
        if (request.method === 'POST' && operation === 'refresh') {
          const source = await networkManager.refreshSource(sourceId);
          audit('network.source.refreshed', { result: `${source.name}:${source.nodes.length}` });
          return sendJson(response, 200, { ok: true, data: { source, networkSettings: networkManager.publicState() } });
        }
        if (request.method === 'POST' && operation === 'test') {
          const result = await networkManager.testNode(sourceId, body.nodeName);
          audit('network.node.tested', { result: `${sourceId}:${result.status}:${result.latencyMs}ms` });
          return sendJson(response, 200, { ok: true, data: { ...result, networkSettings: networkManager.publicState() } });
        }
        if (request.method === 'POST' && operation === 'test-all') {
          const result = await networkManager.testSource(sourceId);
          audit('network.source.tested', { result: `${sourceId}:${result.available}/${result.total}` });
          return sendJson(response, 200, { ok: true, data: { ...result, networkSettings: networkManager.publicState() } });
        }
      } catch (error) {
        return sendError(response, 502, error.message);
      }
    }

    const accountNetworkMatch = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)\/network$/);
    if (accountNetworkMatch && request.method === 'POST') {
      const accountId = accountNetworkMatch[1];
      if (!validateAccountId(accountId)) return sendError(response, 400, '账号 ID 无效');
      const account = accounts.find((item) => item.id === accountId);
      if (!account) return sendError(response, 404, '账号不存在');
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      const previousAssignment = networkManager.publicAssignment(accountId);
      try {
        const assignment = networkManager.assign(accountId, body);
        await networkManager.ensureAccount(accountId);
        audit('network.account.updated', { accountId, operator, result: assignment.label });
        return sendJson(response, 200, { ok: true, data: { assignment, account: accountView(account), networkSettings: networkManager.publicState() } });
      } catch (error) {
        try {
          networkManager.assign(accountId, previousAssignment);
          await networkManager.ensureAccount(accountId);
        } catch (rollbackError) {
          audit('network.account.rollback-failed', { accountId, operator, result: rollbackError.message });
        }
        return sendError(response, 502, `切换线路失败，已恢复原线路：${error.message}`);
      }
    }

    if (request.method === 'GET' && url.pathname === '/api/proxy-settings') {
      return sendJson(response, 200, { ok: true, data: publicProxySettings(proxySettings) });
    }

    if (request.method === 'POST' && url.pathname === '/api/proxy-settings') {
      const body = await readBody(request);
      try {
        const saved = saveProxySettings({ ...body, keepPassword: body.keepPassword === true });
        audit('proxy.settings.updated', { result: saved.enabled ? `${saved.protocol}://${saved.host}:${saved.port}` : 'disabled' });
        return sendJson(response, 200, { ok: true, data: saved });
      } catch (error) {
        return sendError(response, 400, error.message);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/proxy-settings/test') {
      const body = await readBody(request);
      try {
        const candidate = normalizeProxySettings({ ...body, enabled: true, keepPassword: body.keepPassword === true }, proxySettings);
        const result = await testProxyConnection(candidate);
        return sendJson(response, 200, { ok: true, data: result });
      } catch (error) {
        return sendError(response, 502, `代理检测失败：${error.message}`);
      }
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

    if (request.method === 'POST' && url.pathname === '/api/relay-accounts/import') {
      const body = await readBody(request, 2_200_000);
      const operator = requireOperator(body.operator);
      try {
        const imported = await importRelayAccounts(body.package, operator);
        return sendJson(response, 201, { ok: true, data: {
          imported: imported.map((account) => accountView(account)),
          counts: {
            total: imported.length,
            temporary: imported.filter((account) => account.relayTemporary).length,
            refreshable: imported.filter((account) => !account.relayTemporary).length,
          },
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
      const loginMethod = 'official';
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
      try {
        networkManager.assign(account.id, body.network);
      } catch (error) {
        return sendError(response, 400, error.message);
      }
      saveAccounts([...accounts, account]);
      audit('account.add', { accountId: account.id, operator });
      if (!settings.mockLaunch) {
        const result = acquireLease(leases, account.id, operator, 'setup');
        saveLeases(result.leases);
        try {
          const processPid = await startCodexBrowserLogin(account, operator);
          result.lease.processPid = processPid;
          saveLeases({ ...leases, [account.id]: result.lease });
          audit('codex.login.started', { accountId: account.id, operator, result: 'account-create-browser-oauth' });
        } catch (error) {
          networkManager.stopAccount(account.id);
          const next = { ...leases };
          delete next[account.id];
          saveLeases(next);
          audit('codex.login.failed', { accountId: account.id, operator, result: error.message });
          return sendError(response, 500, `账号已创建，但登录授权未启动：${error.message}`);
        }
      }
      return sendJson(response, 201, { ok: true, data: accountView(account) });
    }

    const match = url.pathname.match(/^\/api\/accounts\/([a-z0-9-]+)\/(launch|release|toggle|authorize|authorize-device|cancel-authorization|quota|health|export-auth|wake|quit-codex)$/);
    if (match && request.method === 'POST') {
      const [, accountId, operation] = match;
      if (!validateAccountId(accountId)) return sendError(response, 400, '账号 ID 无效');
      const account = accounts.find((item) => item.id === accountId);
      if (!account) return sendError(response, 404, '账号不存在');
      const body = await readBody(request);
      const operator = requireOperator(body.operator);
      cleanLeases();

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
          account.quota = await readCodexQuota(findCodexCli(), codexHomeDir, 15_000, await backgroundTaskEnvironment(process.env));
          account.quotaError = '';
          account.quotaErrorCode = '';
          account.quotaCheckedAt = account.quota.refreshedAt;
          saveAccounts([...accounts]);
          refreshAccountPlanExpiry(account, { force: true }).catch(() => {});
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

      if (operation === 'authorize' || operation === 'authorize-device') {
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
        archiveInvalidCodexAuth(account);
        const result = acquireLease(leases, accountId, operator, 'setup');
        if (!result.ok) return sendError(response, 409, `账号正在由 ${result.existing.operator} 使用`);
        saveLeases(result.leases);
        try {
          const useDeviceCode = operation === 'authorize-device';
          account.setupStage = useDeviceCode ? 'device-auth' : 'oauth';
          account.loginMethod = 'official';
          saveAccounts([...accounts]);
          const processPid = useDeviceCode
            ? await startCodexDeviceLogin(account, operator)
            : await startCodexBrowserLogin(account, operator, { resetBrowserState: true });
          result.lease.processPid = processPid;
          saveLeases({ ...leases, [accountId]: result.lease });
          audit('codex.login.started', { accountId, operator, result: useDeviceCode ? 'device-fallback' : 'browser-oauth-retry' });
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
        if (launchType === 'codex') startCodexLaunchProgress('account', account.label);
        const processPid = await launchAccount(account, launchType, operator, body.launchOptions || null);
        if (processPid) {
          result.lease.processPid = processPid;
          if (launchType === 'codex') {
            result.lease.processIdentity = readActiveCodexAuth()?.processIdentity || null;
          }
          saveLeases({ ...leases, [accountId]: result.lease });
        }
      } catch (error) {
        if (launchType === 'codex') failCodexLaunchProgress(error);
        const rollback = { ...leases };
        if (result.previous) rollback[accountId] = result.previous;
        else delete rollback[accountId];
        saveLeases(rollback);
        audit('launch.failed', { accountId, operator, result: error.message });
        return sendError(response, 500, error.message);
      }
      if (launchType === 'codex') completeCodexLaunchProgress();
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
      networkManager.assign(accountId, { mode: 'direct' });
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
    console.error(`Request handling failed: ${terminalSafeText(error.stack || error.message || error)}`);
    return sendError(response, 500, error.message || '服务器发生错误');
  }
});

const apiGatewayServer = http.createServer(apiGatewayHandler);
apiGatewayServer.on('error', (error) => {
  audit('api.gateway.failed', { result: `${error.code || 'error'}:${error.message}` });
});

function loopbackPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false);
      else reject(error);
    });
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      probe.close((error) => error ? reject(error) : resolve(true));
    });
  });
}

async function startApiGateway() {
  const port = API_GATEWAY_PORT;
  if (!(await loopbackPortAvailable(port))) {
    throw new Error(`API 网关固定端口 ${port} 已被占用，请关闭占用程序后重启 Codex Navo`);
  }
  apiGatewayServer.listen(port, apiServiceManager.config.host, () => {
    audit('api.gateway.listening', { result: `${apiServiceManager.config.host}:${port}` });
  });
}

startApiGateway().catch((error) => {
  audit('api.gateway.failed', { result: `${error.code || 'error'}:${error.message}` });
});

server.listen(settings.port, '127.0.0.1', () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  sessionMonitor.start().catch((error) => audit('sessions.monitor.failed', { result: error.message }));
  const url = `http://127.0.0.1:${settings.port}/?token=${encodeURIComponent(accessToken)}`;
  if (process.env.CODEX_MANAGER_NO_OPEN === '1') console.log('\nCodex Navo started in test mode.\n');
  else console.log(`\nCodex Navo started:\n${url}\n`);
  console.log('This terminal hosts the local service and may be closed after use.');
  if (process.env.CODEX_MANAGER_NO_OPEN !== '1') {
    const child = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  setTimeout(runScheduledWakes, 5_000).unref?.();
  setTimeout(() => refreshStaleAccountPlanExpiries({ force: true }), 3_000).unref?.();
});

const wakeScheduleTimer = setInterval(runScheduledWakes, 60_000);
wakeScheduleTimer.unref?.();

const protocolLoginTimer = setInterval(pollProtocolLoginResults, 2_000);
protocolLoginTimer.unref?.();

const planExpiryTimer = setInterval(refreshStaleAccountPlanExpiries, 10 * 60_000);
planExpiryTimer.unref?.();

// Restore the normal Codex configuration as soon as an API-launched desktop
// exits. This is independent of UI polling, so closing the window is enough to
// complete the transaction even when Codex Navo is minimized to the tray.
const apiCodexLifecycleTimer = setInterval(() => {
  try { reconcileActiveApiCodexState(); }
  catch (error) { audit('api.codex.lifecycle-failed', { result: error.message }); }
}, 2_000);
apiCodexLifecycleTimer.unref?.();


let activeCodexNetworkRecovery = null;
async function recoverActiveCodexNetwork() {
  if (activeCodexNetworkRecovery) return activeCodexNetworkRecovery;
  const active = readActiveCodexAuth();
  if (!active) return null;
  const account = accounts.find((item) => item.id === active.accountId);
  if (!account || networkManager.publicAssignment(account.id).mode !== 'proxy') return null;
  const snapshot = detectCodexDesktopSnapshot();
  if (!snapshot.pid) return null;
  const wasReady = networkManager.isAccountRuntimeReady(account.id);
  activeCodexNetworkRecovery = networkManager.ensureAccount(account.id)
    .then((runtime) => {
      if (!wasReady && runtime) {
        audit('network.account.recovered', { accountId: account.id, result: `127.0.0.1:${runtime.mixedPort}` });
      }
      return runtime;
    })
    .catch((error) => {
      audit('network.account.recovery-failed', { accountId: account.id, result: error.message });
      return null;
    })
    .finally(() => { activeCodexNetworkRecovery = null; });
  return activeCodexNetworkRecovery;
}

setTimeout(recoverActiveCodexNetwork, 500).unref?.();
const activeCodexNetworkTimer = setInterval(recoverActiveCodexNetwork, 5_000);
activeCodexNetworkTimer.unref?.();

server.on('error', (error) => {
  console.error(`Server startup failed: ${terminalSafeText(error.message)}`);
  process.exitCode = 1;
});

function cleanupPidFile() {
  sessionMonitor.stop();
  networkManager.shutdown();
  try { apiGatewayServer.close(); } catch {}
  try {
    if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(PID_FILE, { force: true });
  } catch {}
}

server.on('close', cleanupPidFile);
process.on('exit', cleanupPidFile);

module.exports = {
  server,
  apiGatewayServer,
  __test: process.env.NODE_ENV === 'test'
    ? {
      prepareApiKeyCodexHome,
      restoreApiKeyCodexHome,
      reconcileActiveApiCodexState,
      paths: {
        active: ACTIVE_API_CODEX_FILE,
        sharedHome: SHARED_CODEX_HOME,
        sharedAuth: SHARED_CODEX_AUTH_FILE,
      },
    }
    : undefined,
};

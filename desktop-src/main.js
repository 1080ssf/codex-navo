const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, screen, shell, Tray } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  CODEX_CHANGELOG_URL,
  CODEX_PACKAGE_IDENTITY,
  CODEX_UPDATE_MANIFEST_URL,
  buildCodexPackageUrl,
  comparePackageVersions,
  parseCodexChangelog,
  validateCodexPackageMetadata,
  validateCodexUpdateManifest,
} = require('../lib/codex-update-state');

const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const UPDATE_START_DELAY_MS = 10 * 1000;
const USER_DATA_ROOT = path.resolve(
  process.env.CODEX_SWITCHBOARD_USER_DATA
    || path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Codex Switchboard'),
);

app.setPath('userData', USER_DATA_ROOT);
app.setAppUserModelId('com.codexswitchboard.app');

let mainWindow = null;
let floatingWindow = null;
let floatingWindowUrl = '';
let serverProcess = null;
let startedServer = false;
let managedServerPid = null;
let tray = null;
let isQuitting = false;
let updateTimer = null;
let updaterConfigured = false;
let serverRestartTimer = null;
let serverPort = 47821;
const FLOATING_SETTINGS_FILE = path.join(USER_DATA_ROOT, 'config', 'floating-window.json');
const FLOATING_DEFAULTS = Object.freeze({ enabled: true, pinned: true, theme: 'glass', opacity: 92, x: null, y: null });
let floatingSettings = { ...FLOATING_DEFAULTS };
let floatingMoveTimer = null;
let updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: '',
  percent: 0,
  releaseNotes: '',
  networkRoute: '',
  error: '',
};
let codexUpdateState = {
  status: 'idle',
  installed: false,
  version: '',
  latestVersion: '',
  updateAvailable: false,
  packageReady: false,
  percent: 0,
  phase: '',
  changelog: [],
  changelogUrl: CODEX_CHANGELOG_URL,
  error: '',
};

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function normalizeFloatingSettings(value = {}) {
  return {
    enabled: value.enabled !== false,
    pinned: value.pinned !== false,
    theme: ['glass', 'midnight', 'paper'].includes(value.theme) ? value.theme : FLOATING_DEFAULTS.theme,
    opacity: Math.max(35, Math.min(100, Math.round(Number(value.opacity) || FLOATING_DEFAULTS.opacity))),
    x: value.x === null || value.x === undefined || !Number.isFinite(Number(value.x)) ? null : Math.round(Number(value.x)),
    y: value.y === null || value.y === undefined || !Number.isFinite(Number(value.y)) ? null : Math.round(Number(value.y)),
  };
}

function readFloatingSettings() {
  try { return normalizeFloatingSettings(JSON.parse(fs.readFileSync(FLOATING_SETTINGS_FILE, 'utf8'))); }
  catch { return { ...FLOATING_DEFAULTS }; }
}

function saveFloatingSettings() {
  fs.mkdirSync(path.dirname(FLOATING_SETTINGS_FILE), { recursive: true });
  const temporary = `${FLOATING_SETTINGS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(floatingSettings, null, 2)}\n`);
  fs.renameSync(temporary, FLOATING_SETTINGS_FILE);
}

function defaultFloatingBounds() {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  return { x: x + width - 420, y: y + height - 446, width: 400, height: 426 };
}

function floatingBounds() {
  const fallback = defaultFloatingBounds();
  if (floatingSettings.x === null || floatingSettings.y === null) return fallback;
  const display = screen.getDisplayNearestPoint({ x: floatingSettings.x, y: floatingSettings.y });
  const area = display.workArea;
  return {
    x: Math.max(area.x, Math.min(area.x + area.width - fallback.width, floatingSettings.x)),
    y: Math.max(area.y, Math.min(area.y + area.height - fallback.height, floatingSettings.y)),
    width: fallback.width,
    height: fallback.height,
  };
}

function publishFloatingSettings() {
  if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.webContents.send('floating:settings', floatingSettings);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('floating:settings', floatingSettings);
}

function applyFloatingSettings() {
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.setOpacity(floatingSettings.opacity / 100);
    floatingWindow.setAlwaysOnTop(floatingSettings.pinned, 'floating');
    if (floatingSettings.enabled) floatingWindow.showInactive();
    else floatingWindow.hide();
  }
  updateTrayMenu();
  publishFloatingSettings();
}

async function createFloatingWindow() {
  if (floatingWindow && !floatingWindow.isDestroyed()) return floatingWindow;
  if (!floatingWindowUrl) return null;
  floatingWindow = new BrowserWindow({
    ...floatingBounds(),
    minWidth: 400,
    maxWidth: 400,
    minHeight: 426,
    maxHeight: 566,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: floatingSettings.pinned,
    skipTaskbar: true,
    hasShadow: false,
    title: 'Codex Navo Floating',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  floatingWindow.setAlwaysOnTop(floatingSettings.pinned, 'floating');
  floatingWindow.setOpacity(floatingSettings.opacity / 100);
  floatingWindow.on('move', () => {
    if (floatingMoveTimer) clearTimeout(floatingMoveTimer);
    floatingMoveTimer = setTimeout(() => {
      if (!floatingWindow || floatingWindow.isDestroyed()) return;
      const [x, y] = floatingWindow.getPosition();
      floatingSettings = { ...floatingSettings, x, y };
      saveFloatingSettings();
    }, 250);
  });
  floatingWindow.on('closed', () => { floatingWindow = null; });
  await floatingWindow.loadURL(floatingWindowUrl);
  if (floatingSettings.enabled) floatingWindow.showInactive();
  return floatingWindow;
}

async function showFloatingWindow() {
  floatingSettings = { ...floatingSettings, enabled: true };
  saveFloatingSettings();
  await createFloatingWindow();
  applyFloatingSettings();
  if (floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.show();
    floatingWindow.moveTop();
    floatingWindow.focus();
  }
  return floatingSettings;
}

function hideFloatingWindow() {
  floatingSettings = { ...floatingSettings, enabled: false };
  saveFloatingSettings();
  applyFloatingSettings();
  return floatingSettings;
}

function toggleFloatingWindow() {
  return floatingSettings.enabled ? hideFloatingWindow() : showFloatingWindow();
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    {
      label: floatingSettings.enabled ? '隐藏悬浮窗' : '显示悬浮窗',
      accelerator: 'CommandOrControl+Alt+N',
      click: () => toggleFloatingWindow(),
    },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip('Codex Navo');
  updateTrayMenu();
  tray.on('click', showMainWindow);
}

function registerFloatingShortcut() {
  globalShortcut.register('CommandOrControl+Alt+N', () => {
    showFloatingWindow().catch(() => {});
  });
}

function applicationRoot() {
  if (process.env.CODEX_MANAGER_ROOT) return path.resolve(process.env.CODEX_MANAGER_ROOT);
  return app.isPackaged ? app.getAppPath() : path.resolve(__dirname, '..');
}

function copyTreeMissing(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTreeMissing(sourcePath, destinationPath);
    else if (entry.isFile() && !fs.existsSync(destinationPath)) fs.copyFileSync(sourcePath, destinationPath);
  }
}

function migrateLegacyData(root) {
  const marker = path.join(USER_DATA_ROOT, 'data', 'storage-v2.json');
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(path.dirname(marker), { recursive: true });

  const legacyRoots = [...new Set([
    root,
    path.dirname(process.execPath),
    process.env.CODEX_MANAGER_ROOT ? path.resolve(process.env.CODEX_MANAGER_ROOT) : '',
  ].filter(Boolean))];

  let migratedFrom = '';
  for (const legacyRoot of legacyRoots) {
    if (path.resolve(legacyRoot) === USER_DATA_ROOT) continue;
    const accountsFile = path.join(legacyRoot, 'config', 'accounts.json');
    const profilesDirectory = path.join(legacyRoot, 'profiles');
    if (!fs.existsSync(accountsFile) && !fs.existsSync(profilesDirectory)) continue;

    for (const file of ['accounts.json', 'settings.json']) {
      const source = path.join(legacyRoot, 'config', file);
      const destination = path.join(USER_DATA_ROOT, 'config', file);
      if (fs.existsSync(source) && !fs.existsSync(destination)) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      }
    }
    copyTreeMissing(profilesDirectory, path.join(USER_DATA_ROOT, 'profiles'));
    migratedFrom = legacyRoot;
    break;
  }

  fs.writeFileSync(marker, `${JSON.stringify({ version: 2, migratedFrom, completedAt: new Date().toISOString() }, null, 2)}\n`);
}

function readSettings() {
  const file = path.join(USER_DATA_ROOT, 'config', 'settings.json');
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isReady(port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 600 }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function directChildEnvironment(environment = process.env) {
  const next = { ...environment };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete next[key];
  delete next.NODE_USE_ENV_PROXY;
  next.PYTHONUTF8 = '1';
  next.PYTHONIOENCODING = 'utf-8';
  return next;
}

function requestLocalJson(pathname, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const tokenFile = path.join(USER_DATA_ROOT, 'data', 'access-token.txt');
    const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
    const request = http.get({
      hostname: '127.0.0.1',
      port: serverPort,
      path: pathname,
      timeout: timeoutMs,
      headers: token ? { Cookie: `codex_manager_session=${encodeURIComponent(token)}` } : {},
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode < 200 || response.statusCode >= 300 || body.ok === false) {
            reject(new Error(body.error || `HTTP ${response.statusCode}`));
            return;
          }
          resolve(body.data);
        } catch (error) {
          reject(new Error(`本地网络配置读取失败：${error.message}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('本地网络配置读取超时')));
    request.on('error', reject);
  });
}

async function configureUpdaterNetwork() {
  const route = await requestLocalJson('/api/network/background-route');
  const updaterSession = autoUpdater.netSession;
  if (route?.proxyUrl) {
    await updaterSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: route.proxyUrl,
      proxyBypassRules: route.bypass || 'localhost,127.0.0.1,::1,*.localhost',
    });
  } else {
    await updaterSession.setProxy({ mode: 'direct' });
  }
  await updaterSession.closeAllConnections?.();
  return route || { proxyUrl: '', nodeName: '' };
}

async function ensureServer(root, port) {
  const tokenFile = path.join(USER_DATA_ROOT, 'data', 'access-token.txt');
  const pidFile = path.join(USER_DATA_ROOT, 'data', 'server.pid');
  if (await isReady(port)) {
    if (fs.existsSync(tokenFile)) {
      const existingPid = Number.parseInt(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim() : '', 10);
      managedServerPid = Number.isInteger(existingPid) && existingPid > 0 ? existingPid : null;
      return;
    }
    throw new Error(`端口 ${port} 已被其他程序或旧版 Codex Navo 占用。请先退出旧版程序，再重新启动。`);
  }
  const serverExecutable = app.isPackaged ? process.execPath : 'node.exe';
  const serverArguments = app.isPackaged ? [path.join(root, 'server.js')] : ['server.js'];
  const logDirectory = path.join(USER_DATA_ROOT, 'data');
  fs.mkdirSync(logDirectory, { recursive: true });
  const serverLog = fs.openSync(path.join(logDirectory, 'server.log'), 'a');
  serverProcess = spawn(serverExecutable, serverArguments, {
    cwd: app.isPackaged ? path.dirname(process.execPath) : root,
    windowsHide: true,
    stdio: ['ignore', serverLog, serverLog],
    env: {
      ...directChildEnvironment(process.env),
      CODEX_MANAGER_NO_OPEN: '1',
      CODEX_SWITCHBOARD_USER_DATA: USER_DATA_ROOT,
      CODEX_NAVO_BUNDLED_NETWORK_CORE: app.isPackaged
        ? path.join(process.resourcesPath, 'network-core', 'mihomo-v1.19.29.exe')
        : path.join(root, '.cache', 'network-core', 'mihomo-v1.19.29.exe'),
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  });
  fs.closeSync(serverLog);
  const launchedServer = serverProcess;
  launchedServer.once('exit', () => {
    if (serverProcess === launchedServer) serverProcess = null;
    managedServerPid = null;
    if (isQuitting || serverRestartTimer) return;
    serverRestartTimer = setTimeout(async () => {
      serverRestartTimer = null;
      if (isQuitting) return;
      try {
        await ensureServer(root, port);
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      } catch (error) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server:restart-failed', String(error.message || error));
        }
      }
    }, 800);
  });
  startedServer = true;
  managedServerPid = serverProcess.pid;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(200);
    if (await isReady(port)) return;
  }
  throw new Error(`本地服务没有启动，请检查 ${path.join(USER_DATA_ROOT, 'data', 'server.log')}`);
}

function normalizeReleaseNotes(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => item?.note || '').filter(Boolean).join('\n\n');
}

function publishUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  try {
    const diagnosticState = { ...updateState, error: updateState.error ? 'update-check-failed' : '' };
    fs.mkdirSync(path.join(USER_DATA_ROOT, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(USER_DATA_ROOT, 'data', 'update-state.json'),
      `${JSON.stringify(diagnosticState, null, 2)}\n`,
    );
  } catch {}
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:state', updateState);
  }
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    publishUpdateState({
      status: 'development',
      error: manual ? '开发模式不会连接更新服务，请使用本地安装包测试。' : '',
    });
    return updateState;
  }
  if (['checking', 'downloading', 'downloaded'].includes(updateState.status)) return updateState;
  publishUpdateState({ status: 'checking', error: '', percent: 0 });
  try {
    const route = await configureUpdaterNetwork();
    publishUpdateState({ networkRoute: route.nodeName || '直连' });
    await autoUpdater.checkForUpdates();
  } catch (error) {
    publishUpdateError(error);
  }
  return updateState;
}

function publishUpdateError(error) {
  const message = String(error?.message || error || '');
  if (/latest\.yml/i.test(message) && /404|not found/i.test(message)) {
    publishUpdateState({ status: 'current', availableVersion: '', percent: 0, error: '' });
    return;
  }
  publishUpdateState({ status: 'error', error: message });
}

function configureAutoUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;
  // GUI builds may be launched without a writable stdout pipe. The updater's
  // default console logger can otherwise crash the Electron main process with EPIPE.
  autoUpdater.logger = null;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => publishUpdateState({
    status: 'available',
    availableVersion: info.version || '',
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
    percent: 0,
    error: '',
  }));
  autoUpdater.on('update-not-available', () => publishUpdateState({
    status: 'current',
    availableVersion: '',
    percent: 0,
    error: '',
  }));
  autoUpdater.on('download-progress', (progress) => publishUpdateState({
    status: 'downloading',
    percent: Math.max(0, Math.min(100, Math.round(progress.percent || 0))),
    error: '',
  }));
  autoUpdater.on('update-downloaded', (info) => publishUpdateState({
    status: 'downloaded',
    availableVersion: info.version || updateState.availableVersion,
    percent: 100,
    error: '',
  }));
  autoUpdater.on('error', publishUpdateError);
  autoUpdater.on('before-quit-for-update', () => { isQuitting = true; });

  setTimeout(() => checkForUpdates(false), UPDATE_START_DELAY_MS);
  updateTimer = setInterval(() => checkForUpdates(false), UPDATE_INTERVAL_MS);
}

function readInstalledCodexPackageState() {
  const query = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($package) { [PSCustomObject]@{ Installed = $true; Version = $package.Version.ToString(); PackageFamilyName = $package.PackageFamilyName; InstallLocation = $package.InstallLocation } | ConvertTo-Json -Compress } else { [PSCustomObject]@{ Installed = $false; Version = ''; PackageFamilyName = ''; InstallLocation = '' } | ConvertTo-Json -Compress }",
  ], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
  if (query.error) throw query.error;
  try {
    const value = JSON.parse(String(query.stdout || '').trim());
    return {
      installed: value.Installed === true,
      version: String(value.Version || ''),
      packageFamilyName: String(value.PackageFamilyName || ''),
      installLocation: String(value.InstallLocation || ''),
    };
  } catch {
    throw new Error('Failed to read the installed Codex desktop version.');
  }
}

function publishCodexUpdateState(patch) {
  codexUpdateState = { ...codexUpdateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('codex-updates:state', codexUpdateState);
  return codexUpdateState;
}

function codexStoreHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'desktop-src', 'codex-store-update.ps1')
    : path.join(__dirname, 'codex-store-update.ps1');
}

function codexStoreWrapperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'desktop-src', 'codex-store-update.vbs')
    : path.join(__dirname, 'codex-store-update.vbs');
}

async function runCodexStoreHelper(mode, { targetVersion = '', timeoutMs = 20 * 60 * 1000 } = {}) {
  const installed = readInstalledCodexPackageState();
  if (!installed.installed || !installed.packageFamilyName) return { ok: false, hasUpdate: false, unavailable: true };
  const helper = codexStoreHelperPath();
  const wrapper = codexStoreWrapperPath();
  if (!fs.existsSync(helper) || !fs.existsSync(wrapper)) throw new Error('The Codex Store update helper is missing.');
  const outputDirectory = path.join(USER_DATA_ROOT, 'updates', 'codex-store');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${mode}-${crypto.randomUUID()}.json`);
  const command = [
    "$arguments = '\"' + $env:CODEX_NAVO_STORE_WRAPPER + '\" \"' + $env:CODEX_NAVO_STORE_HELPER + '\" \"' + $env:CODEX_NAVO_STORE_MODE + '\" \"' + $env:CODEX_NAVO_STORE_OUTPUT + '\"'",
    "Invoke-CommandInDesktopPackage -PackageFamilyName $env:CODEX_NAVO_STORE_FAMILY -AppId App -Command 'C:\\Windows\\System32\\wscript.exe' -Args $arguments -PreventBreakaway -ErrorAction Stop",
  ].join('; ');
  let invokeError = null;
  try {
    const result = await runHiddenProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], timeoutMs, {
      env: {
        ...directChildEnvironment(process.env),
        CODEX_NAVO_STORE_FAMILY: installed.packageFamilyName,
        CODEX_NAVO_STORE_HELPER: helper,
        CODEX_NAVO_STORE_WRAPPER: wrapper,
        CODEX_NAVO_STORE_MODE: mode,
        CODEX_NAVO_STORE_OUTPUT: outputPath,
      },
    });
    if (result.code !== 0) invokeError = new Error('Windows could not start the Codex Store update service.');
  } catch (error) { invokeError = error; }

  const deadline = Date.now() + Math.max(5_000, timeoutMs);
  let nextVersionCheckAt = 0;
  while (Date.now() < deadline) {
    if (fs.existsSync(outputPath)) {
      try {
        const result = JSON.parse(fs.readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, ''));
        fs.rmSync(outputPath, { force: true });
        return result;
      } catch (error) {
        fs.rmSync(outputPath, { force: true });
        throw new Error(`Windows returned an invalid Codex Store update result: ${error.message}`);
      }
    }
    if (mode === 'install' && targetVersion && Date.now() >= nextVersionCheckAt) {
      nextVersionCheckAt = Date.now() + 2_000;
      const current = readInstalledCodexPackageState();
      if (current.installed && comparePackageVersions(current.version, targetVersion) >= 0) {
        return { ok: true, hasUpdate: true, overallState: 'Completed', inferredFromInstalledVersion: true };
      }
    }
    if (invokeError) throw invokeError;
    await delay(250);
  }
  throw new Error('The Codex Store update timed out.');
}

async function fetchOfficialCodexUpdateState() {
  if (['checking', 'closing', 'downloading', 'verifying', 'installing', 'store-installing'].includes(codexUpdateState.status)) return codexUpdateState;
  publishCodexUpdateState({ status: 'checking', phase: 'checking', percent: 0, error: '' });
  try {
    const route = await configureUpdaterNetwork();
    const updaterSession = autoUpdater.netSession;
    const [manifestResponse, changelogResponse] = await Promise.all([
      updaterSession.fetch(CODEX_UPDATE_MANIFEST_URL, { cache: 'no-store' }),
      updaterSession.fetch(CODEX_CHANGELOG_URL).catch(() => null),
    ]);
    if (!manifestResponse.ok) throw new Error(`The official Codex update manifest returned HTTP ${manifestResponse.status}.`);
    if (new URL(manifestResponse.url || CODEX_UPDATE_MANIFEST_URL).protocol !== 'https:') throw new Error('The official Codex update manifest redirected to an insecure URL.');
    const manifest = validateCodexUpdateManifest(await manifestResponse.json());
    const installed = readInstalledCodexPackageState();
    const packageUrl = buildCodexPackageUrl(manifest.buildVersion);
    const [packageResponse, storeUpdate] = await Promise.all([
      updaterSession.fetch(packageUrl, { method: 'HEAD', cache: 'no-store' }),
      installed.installed ? runCodexStoreHelper('check', { timeoutMs: 60_000 }).catch(() => ({ ok: false, hasUpdate: false })) : Promise.resolve({ ok: false, hasUpdate: false }),
    ]);
    const changelog = changelogResponse?.ok ? parseCodexChangelog(await changelogResponse.text()) : codexUpdateState.changelog;
    const updateAvailable = !installed.installed || comparePackageVersions(manifest.buildVersion, installed.version) > 0;
    const updateSource = storeUpdate.ok && storeUpdate.hasUpdate ? 'store' : packageResponse.ok ? 'msix' : 'propagating';
    return publishCodexUpdateState({
      ...installed,
      status: updateAvailable ? 'available' : 'current',
      latestVersion: manifest.buildVersion,
      updateAvailable,
      packageReady: updateSource !== 'propagating',
      updateSource,
      packageUrl,
      networkRoute: route.nodeName || '',
      percent: updateAvailable ? 0 : 100,
      phase: updateAvailable ? 'available' : 'current',
      changelog,
      changelogUrl: CODEX_CHANGELOG_URL,
      error: '',
    });
  } catch (error) {
    return publishCodexUpdateState({ status: 'error', phase: 'error', error: String(error.message || error) });
  }
}

function codexDesktopProcessIds() {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if (-not $package) { '[]'; exit 0 }; $root = [IO.Path]::GetFullPath($package.InstallLocation).TrimEnd('\\') + '\\'; $items = @(Get-Process -Name ChatGPT,codex,codex-code-mode-host -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and [IO.Path]::GetFullPath($_.Path).StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } catch { $false } } | Select-Object -ExpandProperty Id); ConvertTo-Json -Compress -InputObject $items",
  ], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
  if (result.error || result.status !== 0) return [];
  try {
    const value = JSON.parse(String(result.stdout || '[]').trim() || '[]');
    return (Array.isArray(value) ? value : [value]).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  } catch { return []; }
}

function codexDesktopIsRunning() {
  return codexDesktopProcessIds().length > 0;
}

async function closeCodexDesktop() {
  const processIds = codexDesktopProcessIds();
  if (!processIds.length) return;
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$ids = @($env:CODEX_NAVO_CODEX_PIDS -split ',' | ForEach-Object { [int]$_ }); Get-Process -Id $ids -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction Stop",
  ], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env: { ...directChildEnvironment(process.env), CODEX_NAVO_CODEX_PIDS: processIds.join(',') },
  });
  if (result.error || result.status !== 0) throw new Error('Failed to close the running Codex processes.');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!codexDesktopIsRunning()) return;
    await delay(200);
  }
  throw new Error('Codex did not exit before the update timeout.');
}

function runHiddenProcess(command, args, timeoutMs = 10 * 60 * 1000, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    const chunks = [];
    let bytes = 0;
    const append = (chunk) => {
      if (bytes >= 256 * 1024) return;
      const value = Buffer.from(chunk);
      chunks.push(value);
      bytes += value.length;
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('The Codex update timed out.'));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

async function downloadCodexPackage(state) {
  const updateDirectory = path.join(USER_DATA_ROOT, 'updates', 'codex');
  fs.mkdirSync(updateDirectory, { recursive: true });
  const finalPath = path.join(updateDirectory, `Codex-${state.latestVersion}-${process.arch}.msix`);
  const partialPath = `${finalPath}.download`;
  fs.rmSync(partialPath, { force: true });
  const response = await autoUpdater.netSession.fetch(state.packageUrl, { cache: 'no-store' });
  if (response.status === 404) throw new Error('CODEX_PACKAGE_PROPAGATING');
  if (!response.ok || !response.body) throw new Error(`The official Codex package returned HTTP ${response.status}.`);
  if (new URL(response.url || state.packageUrl).protocol !== 'https:') throw new Error('The official Codex package redirected to an insecure URL.');
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const handle = await fs.promises.open(partialPath, 'w');
  let received = 0;
  let downloadError = null;
  try {
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      await handle.write(bytes);
      hash.update(bytes);
      received += bytes.length;
      publishCodexUpdateState({
        status: 'downloading', phase: 'downloading',
        percent: total > 0 ? Math.max(1, Math.min(89, Math.round(received / total * 89))) : 1,
      });
    }
  } catch (error) {
    downloadError = error;
  } finally {
    await handle.close();
  }
  if (downloadError) {
    fs.rmSync(partialPath, { force: true });
    throw downloadError;
  }
  if (total > 0 && received !== total) {
    fs.rmSync(partialPath, { force: true });
    throw new Error(`The Codex package download was incomplete (${received}/${total} bytes).`);
  }
  fs.rmSync(finalPath, { force: true });
  fs.renameSync(partialPath, finalPath);
  return { path: finalPath, bytes: received, sha256: hash.digest('hex') };
}

async function readCodexPackageMetadata(packagePath) {
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$archive = [IO.Compression.ZipFile]::OpenRead($env:CODEX_NAVO_UPDATE_PACKAGE)',
    'try {',
    "  $entry = $archive.GetEntry('AppxManifest.xml')",
    "  if (-not $entry) { throw 'AppxManifest.xml is missing' }",
    '  $reader = [IO.StreamReader]::new($entry.Open())',
    '  try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }',
    '  $identity = $manifest.Package.Identity',
    "  [PSCustomObject]@{ Name = [string]$identity.Name; Publisher = [string]$identity.Publisher; Version = [string]$identity.Version; Architecture = [string]$identity.ProcessorArchitecture } | ConvertTo-Json -Compress",
    '} finally { $archive.Dispose() }',
  ].join('; ');
  const result = await runHiddenProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], 30_000, {
    env: { ...directChildEnvironment(process.env), CODEX_NAVO_UPDATE_PACKAGE: packagePath },
  });
  if (result.code !== 0) throw new Error('Windows could not inspect the downloaded Codex package.');
  try {
    const jsonLine = result.output.split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
    return JSON.parse(jsonLine || '');
  }
  catch { throw new Error('Windows returned invalid Codex package metadata.'); }
}

async function installCodexPackage(packagePath) {
  const command = "Add-AppxPackage -Path $env:CODEX_NAVO_UPDATE_PACKAGE -ForceApplicationShutdown -ForceUpdateFromAnyVersion -ErrorAction Stop";
  const result = await runHiddenProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], 10 * 60 * 1000, {
    env: { ...directChildEnvironment(process.env), CODEX_NAVO_UPDATE_PACKAGE: packagePath },
  });
  if (result.code !== 0) throw new Error('Windows rejected the official Codex package. The package signature or deployment details did not validate.');
}

async function confirmCloseCodex(locale, state) {
  const chinese = String(locale || '').toLowerCase().startsWith('zh');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: chinese ? ['取消', '关闭 Codex 并更新'] : ['Cancel', 'Close Codex and update'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: chinese ? '更新 Codex' : 'Update Codex',
    message: chinese ? '需要先关闭正在运行的 Codex' : 'Codex must be closed before updating',
    detail: chinese
      ? `当前版本：v${state.version || '—'}\n目标版本：v${state.latestVersion}\n\n关闭 Codex 会中断正在运行的任务。是否继续？`
      : `Installed: v${state.version || '—'}\nTarget: v${state.latestVersion}\n\nClosing Codex will stop running tasks. Continue?`,
  });
  return result.response === 1;
}

async function installCodexWindowsUpdate({ locale = 'en-US' } = {}) {
  let state = await fetchOfficialCodexUpdateState();
  if (state.status === 'error') return state;
  if (!state.updateAvailable) return publishCodexUpdateState({ status: 'current', phase: 'current', percent: 100 });
  if (!state.packageReady) return publishCodexUpdateState({ status: 'propagating', phase: 'propagating', percent: 0 });
  if (codexDesktopIsRunning()) {
    const confirmed = await confirmCloseCodex(locale, state);
    if (!confirmed) return publishCodexUpdateState({ status: 'available', phase: 'available', cancelled: true });
    publishCodexUpdateState({ status: 'closing', phase: 'closing', percent: 0, cancelled: false });
    await closeCodexDesktop();
  }
  let downloadedPath = '';
  try {
    if (state.updateSource === 'store') {
      publishCodexUpdateState({ status: 'store-installing', phase: 'store-installing', percent: 0, error: '' });
      const result = await runCodexStoreHelper('install', { targetVersion: state.latestVersion });
      if (!result.ok || !['Completed', 'NoUpdates'].includes(String(result.overallState || ''))) {
        throw new Error(`Windows Store update service returned ${result.overallState || result.error || 'an unknown error'}.`);
      }
      const installed = readInstalledCodexPackageState();
      if (!installed.installed || comparePackageVersions(installed.version, state.latestVersion) < 0) {
        throw new Error(`Windows completed the official update request, but Codex is still v${installed.version || 'unknown'}.`);
      }
      return publishCodexUpdateState({
        ...installed,
        status: 'completed', phase: 'completed', percent: 100,
        updateAvailable: false, packageReady: true, updated: true,
        error: '',
      });
    }
    publishCodexUpdateState({ status: 'downloading', phase: 'downloading', percent: 1, error: '' });
    const download = await downloadCodexPackage(state);
    downloadedPath = download.path;
    publishCodexUpdateState({ status: 'verifying', phase: 'verifying', percent: 90, sha256: download.sha256 });
    const metadata = validateCodexPackageMetadata(await readCodexPackageMetadata(download.path), state.latestVersion);
    publishCodexUpdateState({ status: 'installing', phase: 'installing', percent: 94 });
    await installCodexPackage(download.path);
    const installed = readInstalledCodexPackageState();
    if (!installed.installed || comparePackageVersions(installed.version, state.latestVersion) < 0) {
      throw new Error(`Windows completed deployment, but Codex is still v${installed.version || 'unknown'}.`);
    }
    fs.rmSync(download.path, { force: true });
    return publishCodexUpdateState({
      ...installed,
      status: 'completed', phase: 'completed', percent: 100,
      updateAvailable: false, packageReady: true, updated: true,
      verifiedPackage: metadata, error: '',
    });
  } catch (error) {
    if (downloadedPath) fs.rmSync(downloadedPath, { force: true });
    const propagating = String(error.message || error) === 'CODEX_PACKAGE_PROPAGATING';
    return publishCodexUpdateState({
      status: propagating ? 'propagating' : 'error',
      phase: propagating ? 'propagating' : 'error',
      percent: 0,
      error: propagating ? '' : String(error.message || error),
    });
  }
}

function registerUpdaterIpc() {
  ipcMain.handle('updates:get-state', () => updateState);
  ipcMain.handle('updates:check', () => checkForUpdates(true));
  ipcMain.handle('updates:download', async () => {
    if (updateState.status !== 'available') return updateState;
    publishUpdateState({ status: 'downloading', percent: 0, error: '' });
    try {
      const route = await configureUpdaterNetwork();
      publishUpdateState({ networkRoute: route.nodeName || '直连' });
      await autoUpdater.downloadUpdate();
    } catch (error) {
      publishUpdateError(error);
    }
    return updateState;
  });
  ipcMain.handle('updates:install', () => {
    if (updateState.status !== 'downloaded') return false;
    isQuitting = true;
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });
  ipcMain.handle('codex-updates:get-state', () => fetchOfficialCodexUpdateState());
  ipcMain.handle('codex-updates:install', (_event, options = {}) => installCodexWindowsUpdate(options));
  ipcMain.handle('notifications:show', (_event, payload = {}) => {
    if (!Notification.isSupported()) return false;
    const title = String(payload.title || 'Codex Navo').trim().slice(0, 120) || 'Codex Navo';
    const body = String(payload.body || '').trim().slice(0, 800);
    if (!body) return false;
    const notification = new Notification({
      title,
      body,
      icon: path.join(__dirname, 'icon.ico'),
      silent: true,
    });
    notification.on('click', showMainWindow);
    notification.show();
    return true;
  });
  ipcMain.handle('notifications:import-sound', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import notification sound', properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const bytes = fs.readFileSync(file);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Audio file must be 5 MB or smaller');
    const extension = path.extname(file).slice(1).toLowerCase();
    const mime = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' }[extension] || 'audio/mpeg';
    return {
      id: `custom:${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`,
      name: path.basename(file, path.extname(file)),
      dataUrl: `data:${mime};base64,${bytes.toString('base64')}`,
    };
  });
  ipcMain.handle('floating:get-settings', () => floatingSettings);
  ipcMain.handle('floating:show', () => showFloatingWindow());
  ipcMain.handle('floating:hide', () => hideFloatingWindow());
  ipcMain.handle('floating:update-settings', async (_event, patch = {}) => {
    floatingSettings = normalizeFloatingSettings({ ...floatingSettings, ...patch });
    saveFloatingSettings();
    if (floatingSettings.enabled) await createFloatingWindow();
    applyFloatingSettings();
    return floatingSettings;
  });
  ipcMain.handle('floating:update-locale', (_event, value) => {
    const locale = String(value || '').trim().slice(0, 24) || 'en-US';
    if (floatingWindow && !floatingWindow.isDestroyed()) floatingWindow.webContents.send('floating:locale', locale);
    return locale;
  });
  ipcMain.handle('floating:set-expanded', (_event, expanded) => {
    if (!floatingWindow || floatingWindow.isDestroyed()) return false;
    const targetHeight = expanded ? 566 : 426;
    const bounds = floatingWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const y = Math.min(bounds.y, area.y + area.height - targetHeight);
    floatingWindow.setBounds({ x: bounds.x, y, width: bounds.width, height: targetHeight }, true);
    return true;
  });
}

async function createWindow() {
  const root = applicationRoot();
  migrateLegacyData(root);
  const config = readSettings();
  const port = Number.isInteger(config.port) ? config.port : 47821;
  serverPort = port;
  await ensureServer(root, port);
  const tokenFile = path.join(USER_DATA_ROOT, 'data', 'access-token.txt');
  if (!fs.existsSync(tokenFile)) throw new Error('本地服务已启动，但没有生成访问凭据。请退出应用后重试。');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  floatingSettings = readFloatingSettings();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1050,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f6fa',
    title: 'Codex Navo',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle('Codex Navo');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    publishUpdateState({ currentVersion: app.getVersion() });
    setTimeout(async () => {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const health = await mainWindow.webContents.executeJavaScript(`({
          title: document.title,
          accountCards: document.querySelectorAll('.account-card').length,
          currentCodex: document.querySelector('#current-codex')?.textContent?.trim() || '',
          updateChip: document.querySelector('#update-chip')?.textContent?.trim() || '',
          updateChipVisible: !document.querySelector('#update-chip')?.hidden,
          loadedAt: new Date().toISOString()
        })`);
        fs.writeFileSync(path.join(USER_DATA_ROOT, 'data', 'desktop-health.json'), `${JSON.stringify(health, null, 2)}\n`);
      } catch {}
    }, 4000);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  floatingWindowUrl = `http://127.0.0.1:${port}/floating.html?token=${encodeURIComponent(token)}`;
  if (floatingSettings.enabled) await createFloatingWindow();
  createTray();
  registerFloatingShortcut();
  if (floatingSettings.enabled && floatingWindow && !floatingWindow.isDestroyed()) {
    floatingWindow.show();
    floatingWindow.moveTop();
  }
  configureAutoUpdater();
}

registerUpdaterIpc();

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Codex Navo 无法启动', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  if (serverRestartTimer) {
    clearTimeout(serverRestartTimer);
    serverRestartTimer = null;
  }
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  const serverPid = managedServerPid || serverProcess?.pid;
  if (Number.isInteger(serverPid) && serverPid > 0 && serverPid !== process.pid) {
    try {
      // Stop only Navo's local service. /T would also terminate an independently
      // running Codex desktop process that was originally launched by the service.
      const result = spawnSync('taskkill.exe', ['/PID', String(serverPid), '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 5_000,
      });
      if (result.error && startedServer && serverProcess && !serverProcess.killed) serverProcess.kill();
    } catch {
      if (startedServer && serverProcess && !serverProcess.killed) {
        try { serverProcess.kill(); } catch {}
      }
    }
  }
  managedServerPid = null;
});

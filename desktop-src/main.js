const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, screen, shell, Tray } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

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

function readCodexPackageState() {
  const query = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$package = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($package) { [PSCustomObject]@{ Installed = $true; Version = $package.Version.ToString(); PackageFamilyName = $package.PackageFamilyName } | ConvertTo-Json -Compress } else { [PSCustomObject]@{ Installed = $false; Version = ''; PackageFamilyName = '' } | ConvertTo-Json -Compress }",
  ], { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
  if (query.error) throw query.error;
  try {
    const value = JSON.parse(String(query.stdout || '').trim());
    return { installed: value.Installed === true, version: String(value.Version || ''), packageFamilyName: String(value.PackageFamilyName || '') };
  } catch {
    throw new Error('Failed to read the installed Codex desktop version.');
  }
}

function codexDesktopIsRunning() {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "if (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue) { exit 10 } else { exit 0 }",
  ], { windowsHide: true, stdio: 'ignore', timeout: 8_000 });
  return result.status === 10;
}

function runHiddenProcess(command, args, timeoutMs = 10 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

async function installCodexWindowsUpdate() {
  if (codexDesktopIsRunning()) {
    return { ...readCodexPackageState(), updated: false, blocked: true, message: '请先退出 Codex，再点击“检查并更新”。关闭 Codex 可避免 Microsoft Store 安装包被占用。' };
  }
  const localWinget = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'winget.exe');
  const executable = fs.existsSync(localWinget) ? localWinget : 'winget.exe';
  const commonArgs = ['--id', '9PLM9XGG6VKS', '--source', 'msstore', '--exact', '--accept-source-agreements', '--disable-interactivity'];
  const before = readCodexPackageState();
  if (!before.installed) {
    const install = await runHiddenProcess(executable, ['install', ...commonArgs, '--accept-package-agreements', '--silent']);
    if (install.code !== 0) throw new Error('Codex 安装失败，请改用 Microsoft Store 重试。');
    const afterInstall = readCodexPackageState();
    return { ...afterInstall, updated: afterInstall.installed, message: afterInstall.installed ? 'Codex 已通过 Microsoft Store 安装完成。' : 'Windows 已接收安装请求，请稍后重新检查。' };
  }
  const available = await runHiddenProcess(executable, ['list', ...commonArgs, '--upgrade-available']);
  if (available.code !== 0) throw new Error('Codex 更新检查失败，请检查 Microsoft Store 和网络连接。');
  if (!available.output.includes('9PLM9XGG6VKS')) {
    return { ...before, updated: false, message: 'Codex 已是 Microsoft Store 当前提供的最新版。' };
  }
  const upgrade = await runHiddenProcess(executable, ['upgrade', ...commonArgs, '--accept-package-agreements', '--silent']);
  if (upgrade.code !== 0) throw new Error('Codex 更新失败，请确认 Microsoft Store 可用后重试。');
  const after = readCodexPackageState();
  return { ...after, updated: after.version !== before.version, message: after.version !== before.version ? `Codex 已更新到 v${after.version}。` : 'Windows 已完成更新请求，当前版本号没有变化。' };
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
  ipcMain.handle('codex-updates:get-state', () => readCodexPackageState());
  ipcMain.handle('codex-updates:install', () => installCodexWindowsUpdate());
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

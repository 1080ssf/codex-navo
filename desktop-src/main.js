const { app, BrowserWindow, dialog, ipcMain, Menu, Tray } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn, spawnSync } = require('node:child_process');
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
let serverProcess = null;
let startedServer = false;
let managedServerPid = null;
let tray = null;
let isQuitting = false;
let updateTimer = null;
let updaterConfigured = false;
let updateState = {
  status: 'idle',
  currentVersion: app.getVersion(),
  availableVersion: '',
  percent: 0,
  releaseNotes: '',
  error: '',
};

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip('Codex Navo');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', showMainWindow);
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
  serverProcess = spawn(serverExecutable, serverArguments, {
    cwd: app.isPackaged ? path.dirname(process.execPath) : root,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_MANAGER_NO_OPEN: '1',
      CODEX_SWITCHBOARD_USER_DATA: USER_DATA_ROOT,
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
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

function registerUpdaterIpc() {
  ipcMain.handle('updates:get-state', () => updateState);
  ipcMain.handle('updates:check', () => checkForUpdates(true));
  ipcMain.handle('updates:download', async () => {
    if (updateState.status !== 'available') return updateState;
    publishUpdateState({ status: 'downloading', percent: 0, error: '' });
    try {
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
}

async function createWindow() {
  const root = applicationRoot();
  migrateLegacyData(root);
  const config = readSettings();
  const port = Number.isInteger(config.port) ? config.port : 47821;
  await ensureServer(root, port);
  const tokenFile = path.join(USER_DATA_ROOT, 'data', 'access-token.txt');
  if (!fs.existsSync(tokenFile)) throw new Error('本地服务已启动，但没有生成访问凭据。请退出应用后重试。');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();

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
  createTray();
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
      const result = spawnSync('taskkill.exe', ['/PID', String(serverPid), '/T', '/F'], {
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

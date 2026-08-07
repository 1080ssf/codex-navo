const { app, BrowserWindow, dialog, Menu, Tray } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

let mainWindow = null;
let serverProcess = null;
let startedServer = false;
let tray = null;
let isQuitting = false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  tray.setToolTip('Codex 账号切换');
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

function managerRoot() {
  if (process.env.CODEX_MANAGER_ROOT) return path.resolve(process.env.CODEX_MANAGER_ROOT);
  return app.isPackaged
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, '..');
}

function settings(root) {
  const file = path.join(root, 'config', 'settings.json');
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
  if (await isReady(port)) return;
  const serverExecutable = app.isPackaged ? process.execPath : 'node.exe';
  const serverArguments = app.isPackaged ? [path.join(root, 'server.js')] : ['server.js'];
  serverProcess = spawn(serverExecutable, serverArguments, {
    cwd: root,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CODEX_MANAGER_NO_OPEN: '1',
      ...(app.isPackaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  });
  startedServer = true;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(200);
    if (await isReady(port)) return;
  }
  throw new Error('本地服务没有启动，请确认 Node.js 可用并检查 data/server.log');
}

async function createWindow() {
  const root = managerRoot();
  const config = settings(root);
  const port = Number.isInteger(config.port) ? config.port : 47821;
  await ensureServer(root, port);
  const token = fs.readFileSync(path.join(root, 'data', 'access-token.txt'), 'utf8').trim();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1050,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f3f6fa',
    title: 'Codex 账号切换',
    webPreferences: {
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
    mainWindow.setTitle('Codex 账号切换');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const health = await mainWindow.webContents.executeJavaScript(`({
          title: document.title,
          accountCards: document.querySelectorAll('.account-card').length,
          currentCodex: document.querySelector('#current-codex')?.textContent?.trim() || '',
          loadedAt: new Date().toISOString()
        })`);
        fs.writeFileSync(path.join(root, 'data', 'desktop-health.json'), `${JSON.stringify(health, null, 2)}\n`);
      } catch {}
    }, 4000);
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  await mainWindow.loadURL(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  createTray();
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Codex 账号切换无法启动', error.message);
  app.quit();
});

app.on('window-all-closed', () => app.quit());

app.on('before-quit', () => {
  isQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  if (startedServer && serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch {}
  }
});

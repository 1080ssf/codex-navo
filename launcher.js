const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = __dirname;
const dataDir = path.join(root, 'data');
const settingsFile = path.join(root, 'config', 'settings.json');
const settings = fs.existsSync(settingsFile)
  ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  : {};
const port = Number.isInteger(settings.port) ? settings.port : 47821;
const logFile = path.join(dataDir, 'server.log');
const tokenFile = path.join(dataDir, 'access-token.txt');

fs.mkdirSync(dataDir, { recursive: true });

function isReady() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 500 }, (response) => {
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

function findAppBrowser() {
  const configured = String(settings.browserExecutable || '').trim();
  const candidates = [
    configured,
    path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

async function main() {
  let ready = await isReady();
  if (!ready) {
    const output = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, ['server.js'], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', output, output],
      env: { ...process.env, CODEX_MANAGER_NO_OPEN: '1' },
    });
    child.unref();
    fs.closeSync(output);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(200);
      ready = await isReady();
      if (ready) break;
    }
  }

  if (!ready) throw new Error(`本地服务没有启动，请查看 ${logFile}`);
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  const appBrowser = findAppBrowser();
  const browser = appBrowser
    ? spawn(appBrowser, [`--app=${url}`, '--start-maximized'], {
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
      })
    : spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
  browser.unref();
  console.log('Launcher is running in the background. Opening the desktop window...');
}

main().catch((error) => {
  console.error(`[ERROR] ${error.message}`);
  process.exitCode = 1;
});

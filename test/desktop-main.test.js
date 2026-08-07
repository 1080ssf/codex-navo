const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('关闭主窗口时驻留系统托盘，并提供显式退出入口', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop-src', 'main.js'), 'utf8');
  assert.match(source, /new Tray\(/);
  assert.match(source, /mainWindow\.on\('close'/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /mainWindow\.hide\(\)/);
  assert.match(source, /label: '退出应用'/);
  assert.match(source, /isQuitting = true/);
});

test('桌面安装版将运行数据放到 LocalAppData 并接入自动更新', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop-src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'desktop-src', 'preload.js'), 'utf8');
  assert.match(source, /process\.env\.LOCALAPPDATA/);
  assert.match(source, /CODEX_SWITCHBOARD_USER_DATA/);
  assert.match(source, /autoUpdater\.checkForUpdates/);
  assert.match(source, /autoUpdater\.downloadUpdate/);
  assert.match(source, /autoUpdater\.quitAndInstall/);
  assert.match(preload, /contextBridge\.exposeInMainWorld\('codexUpdater'/);
  assert.match(source, /mainWindow\.setTitle\('Codex Navo'\)/);
});

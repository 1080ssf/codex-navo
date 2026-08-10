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

test('Store 版 Codex 被 Windows 拒绝直接执行时提供系统激活回退', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /AppUserModelId/);
  assert.match(source, /shell:AppsFolder/);
  assert.match(source, /\['EPERM', 'EACCES'\]/);
  assert.match(source, /await waitForCodexDesktop\(\)/);
});

test('自动更新器在无控制台的安装版中不会写入失效输出管道', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop-src', 'main.js'), 'utf8');
  assert.match(source, /autoUpdater\.logger = null/);
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
  assert.match(source, /端口 \$\{port\} 已被其他程序或旧版 Codex Navo 占用/);
});

test('退出和更新只清理 Navo 进程，不沿进程树关闭 Codex 桌面端', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop-src', 'main.js'), 'utf8');
  const installer = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  assert.match(source, /managedServerPid/);
  assert.match(source, /taskkill\.exe/);
  assert.match(source, /\['\/PID', String\(serverPid\), '\/F'\]/);
  assert.doesNotMatch(source, /\['\/PID', String\(serverPid\), '\/T', '\/F'\]/);
  assert.match(installer, /taskkill \/F \/IM "Codex Navo\.exe"/);
  assert.doesNotMatch(installer, /taskkill \/F \/T \/IM "Codex Navo\.exe"/);
});

test('后台服务异常退出后自动重启并保留本机错误日志', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'desktop-src', 'main.js'), 'utf8');
  assert.match(source, /server\.log/);
  assert.match(source, /launchedServer\.once\('exit'/);
  assert.match(source, /await ensureServer\(root, port\)/);
  assert.match(source, /mainWindow\.reload\(\)/);
  assert.match(source, /serverRestartTimer/);
});

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

test('固定账号启动会等待稳定 Codex 进程并在引导进程切换时保留目标授权', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /waitForCodexDesktop\(timeoutMs = 8_000, stableMs = 1_200\)/);
  assert.match(source, /Date\.now\(\) - candidateSince >= stableMs/);
  assert.match(source, /const desktopArgs = accountNetwork/);
  assert.match(source, /--proxy-server=http:\/\/127\.0\.0\.1:\$\{accountNetwork\.mixedPort\}/);
  assert.match(source, /--proxy-bypass-list=<local>;localhost;\*\.localhost;127\.0\.0\.1;\[::1\]/);
  assert.match(source, /spawnDetached\(installation\.executable, desktopArgs/);
  assert.match(source, /lease\.process-reconciled/);
  assert.match(source, /lease\.launchType === 'codex' && !lease\.processPid/);
  assert.match(source, /activeProcessMissing && !launchPending/);
  assert.match(source, /codexProcessIdentityMatches\(activeAuth\.processIdentity, codexSnapshot\)/);
});

test('Codex 运行状态检测失败时使用缓存并保持账号池可读取', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /CODEX_PROCESS_CACHE_MS/);
  assert.match(source, /Get-Process -Name ChatGPT/);
  assert.match(source, /reliable: false/);
  assert.match(source, /const codexSnapshot = detectCodexDesktopSnapshot\(\)/);
  assert.match(source, /cleanLeases\(codexSnapshot\)/);
  assert.match(source, /codexRunning: Boolean\(codexSnapshot\.pid\)/);
  assert.match(source, /codexSnapshot\.reliable && activeProcessMissing/);
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
  assert.match(source, /\/api\/network\/background-route/);
  assert.match(source, /autoUpdater\.netSession/);
  assert.match(source, /updaterSession\.setProxy/);
  assert.match(source, /networkRoute: route\.nodeName \|\| '直连'/);
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

test('安装包内置经过固定摘要校验的 Mihomo 核心并传递给后台服务', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'desktop-src', 'main.js'), 'utf8');
  const manager = fs.readFileSync(path.join(root, 'lib', 'account-network.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(source, /CODEX_NAVO_BUNDLED_NETWORK_CORE/);
  assert.match(source, /process\.resourcesPath, 'network-core', 'mihomo-v1\.19\.29\.exe'/);
  assert.match(manager, /CORE_EXECUTABLE_SHA256/);
  assert.match(manager, /network\.core\.installed/);
  assert.ok(manifest.build.extraResources.some((item) => item.to === 'network-core/mihomo-v1.19.29.exe'));
});

test('任务进展与消息提醒模块已从应用中移除', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const html = read('public/index.html');
  const app = read('public/app.js');
  const server = read('server.js');
  const css = read('public/styles.css');
  assert.doesNotMatch(html, /data-workspace="tasks"/);
  assert.doesNotMatch(html, /id="tasks-section"/);
  assert.doesNotMatch(html, /id="notification-settings-dialog"/);
  assert.doesNotMatch(app, /taskMonitor|task-monitor|deliverDesktopNotifications/);
  assert.doesNotMatch(server, /CodexTaskMonitor|task-monitor/);
  assert.doesNotMatch(css, /task-project-sidebar|notification-settings-dialog/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', 'task-monitor.js')), false);
  assert.match(server, /removeLegacyCodexNavoHooks/);
  assert.match(server, /codex-navo-hook\.ps1/);
});

test('应用设置在 Navo 内通过 OpenAI 官方清单直接更新 Codex 桌面版', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'desktop-src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'desktop-src', 'preload.js'), 'utf8');
  assert.match(main, /codex-updates:get-state/);
  assert.match(main, /Get-AppxPackage -Name OpenAI\.Codex/);
  assert.match(main, /CODEX_UPDATE_MANIFEST_URL/);
  assert.match(main, /buildCodexPackageUrl/);
  assert.match(main, /Add-AppxPackage/);
  assert.match(main, /Invoke-CommandInDesktopPackage/);
  assert.match(main, /codex-store-update\.ps1/);
  assert.match(main, /codex-store-update\.vbs/);
  assert.match(main, /wscript\.exe/);
  assert.doesNotMatch(main, /Invoke-CommandInDesktopPackage[^\n]+WindowsPowerShell/);
  const storeHelper = fs.readFileSync(path.join(root, 'desktop-src', 'codex-store-update.ps1'), 'utf8');
  assert.match(storeHelper, /CanSilentlyDownloadStorePackageUpdates/);
  assert.match(storeHelper, /TrySilentDownloadAndInstallStorePackageUpdatesAsync/);
  assert.doesNotMatch(storeHelper, /\$context\.RequestDownloadAndInstallStorePackageUpdatesAsync/);
  assert.match(storeHelper, /List\[Windows\.Services\.Store\.StorePackageUpdate\]/);
  assert.doesNotMatch(storeHelper, /\$updates\s*=\s*@\(Await-Operation/);
  assert.match(fs.readFileSync(path.join(root, 'desktop-src', 'codex-store-update.vbs'), 'utf8'), /shell\.Run\(commandLine, 0, True\)/);
  assert.match(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), /asarUnpack[\s\S]*codex-store-update\.ps1[\s\S]*codex-store-update\.vbs/);
  assert.match(main, /ForceApplicationShutdown/);
  assert.match(main, /showMessageBox/);
  assert.match(main, /关闭 Codex 并更新/);
  assert.match(main, /updateAvailable/);
  assert.match(main, /codex-updates:install/);
  assert.match(main, /codex-updates:state/);
  assert.doesNotMatch(main, /winget\.exe/);
  assert.doesNotMatch(main, /ms-windows-store:/);
  assert.match(preload, /getCodexState/);
  assert.match(preload, /installCodexUpdate/);
  assert.match(preload, /onCodexState/);
});

test('desktop forwards application locale changes to the floating window', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'desktop-src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'desktop-src', 'preload.js'), 'utf8');
  assert.match(main, /floating:update-locale/);
  assert.match(main, /floating:locale/);
  assert.match(preload, /updateLocale/);
  assert.match(preload, /onLocale/);
});

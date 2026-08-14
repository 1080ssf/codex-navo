const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('添加账号弹窗的关闭按钮不会触发必填校验', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const accountForm = html.match(/<form method="dialog" id="account-form">([\s\S]*?)<\/form>/)?.[1] || '';
  const cancelButtons = [...accountForm.matchAll(/<button[^>]*value="cancel"[^>]*>/g)].map((match) => match[0]);
  assert.equal(cancelButtons.length, 2);
  assert.equal(cancelButtons.every((button) => /\bformnovalidate\b/.test(button)), true);
});

test('添加账号可以在首次登录授权前选择独立网络线路', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="account-create-route"/);
  assert.match(client, /populateAccountRouteSelect\(elements\.accountCreateRoute\)/);
  assert.match(client, /network: route === 'direct'/);
  assert.match(server, /networkManager\.assign\(account\.id, body\.network\)/);
  assert.match(server, /networkManager\.assign\(account\.id, body\.network\)[\s\S]{0,900}startCodexBrowserLogin\(account, operator\)/);
});

test('账号线路明确覆盖 Codex 内的 GitHub 访问', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const network = fs.readFileSync(path.join(__dirname, '..', 'lib', 'account-network.js'), 'utf8');
  assert.match(html, /Codex 桌面端及其 GitHub 访问都使用这条线路/);
  assert.match(html, /GitHub 访问都会使用同一节点/);
  assert.match(network, /HTTP_PROXY: url, HTTPS_PROXY: url/);
  assert.match(network, /ALL_PROXY: url, all_proxy: url/);
  assert.match(network, /NODE_USE_ENV_PROXY: '1'/);
  assert.match(network, /const bypass = 'localhost,127\.0\.0\.1,::1,\.localhost,0\.0\.0\.0'/);
  assert.match(server, /const environment = codexEnvironment\(\{ \.\.\.process\.env, CODEX_HOME: SHARED_CODEX_HOME \}, account\)/);
  assert.match(server, /--proxy-server=http:\/\/127\.0\.0\.1:\$\{accountNetwork\.mixedPort\}/);
});

test('添加账号不再提供后台交互登录入口', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(html, /name="loginMethod" value="protocol"/);
  assert.doesNotMatch(html, /后台交互登录/);
  assert.doesNotMatch(app, /openProtocolDialog\(created\)/);
  assert.doesNotMatch(app, /\/authorize-protocol/);
  assert.doesNotMatch(server, /\(launch\|release[^\n]*authorize-protocol/);
});

test('侧边栏不再展示独立应用更新板块', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="app-settings-button"/);
});

test('顶栏恢复版本检查入口且网络控件沿用应用字体与新图标', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="update-chip"/);
  assert.doesNotMatch(styles, /#update-chip[^\{]*\{\s*display:\s*none\s*!important/);
  assert.match(styles, /\.network-import-panel[^\{]*\{[^}]*Segoe UI Variable Text/);
  assert.match(client, /<circle cx="12" cy="12" r="8\.5"><\/circle>/);
});

test('顶栏状态居中，并为外部 Codex 提供独立关闭入口', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="close-external-codex"/);
  assert.match(client, /\/api\/codex\/quit-external/);
  assert.match(server, /function stopExternalCodexDesktop\(\)/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
  assert.match(styles, /\.close-external-codex\[hidden\]\s*\{\s*display:\s*none/);
});

test('Codex 运行时不会向其他账号提供无效的切换操作', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /暂不可切换/);
  assert.match(client, /请先退出当前 Codex/);
  assert.match(client, /关闭后启动/);
  assert.doesNotMatch(client, />切换账号</);
  assert.match(html, /<strong>Google Chrome<\/strong>/);
  assert.doesNotMatch(html, /Microsoft Edge/);
});

test('添加账号期间不会被后台刷新或更新弹窗抢走输入焦点', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /requestAnimationFrame\(\(\) => elements\.form\.querySelector\('input\[name="loginMethod"\]:checked'\)\?\.focus\(\)\)/);
  assert.match(client, /function editingSurfaceActive\(\)/);
  assert.match(client, /document\.querySelector\('dialog\[open\]'\)/);
  assert.match(client, /refresh\(\{ background: true \}\)/);
  assert.doesNotMatch(client, /nextState\.status === 'available'[\s\S]{0,160}showModal/);
});

test('版本入口进入应用设置更新卡片且官方授权结束后验证并落地网页会话', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /<dialog id="update-dialog"/);
  assert.doesNotMatch(html, /data-app-page="updates"/);
  assert.match(html, /id="navo-settings-update-action"/);
  assert.match(html, /id="codex-update-action"/);
  assert.match(html, /https:\/\/t\.me\/\+4VH9hBsRu7phNjg1/);
  assert.match(html, /https:\/\/qm\.qq\.com\/q\/f92ySNuLss/);
  assert.match(html, /https:\/\/github\.com\/1080ssf\/codex-navo/);
  assert.match(client, /showAppPage\('language'\)/);
  assert.doesNotMatch(client, /showAppPage\('updates'\)/);
  assert.match(server, /injectProtocolCookies\(\{[\s\S]{0,180}pending\.browser\.port[\s\S]{0,180}cookies: \[\]/);
  assert.match(server, /account\.webLoginComplete = webLoginComplete/);
});

test('新增账号使用官方浏览器 OAuth 一次完成登录和授权', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /登录并授权/);
  assert.doesNotMatch(html, /id="device-auth-dialog"/);
  assert.match(client, /data-action="authorize-device"/);
  assert.match(client, /\/\$\{action\}`/);
  assert.match(server, /\['app-server'\]/);
  assert.match(server, /method: 'account\/login\/start'/);
  assert.match(server, /type: 'chatgpt'/);
  assert.match(server, /launchAccountBrowser\(account, authUrl, \{ returnSession: true \}\)/);
  assert.match(server, /authorize-device/);
});

test('账号级节点池支持订阅、自动识别、测速和独立线路选择', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="network-settings-button"/);
  assert.match(html, /data-app-page="network"/);
  assert.match(html, /id="network-source-form"/);
  assert.match(html, /SS \/ SSR \/ VMess \/ VLESS \/ Trojan \/ Hysteria2 \/ TUIC \/ WireGuard \/ HTTP \/ SOCKS5/);
  assert.match(html, /id="account-network-dialog"/);
  assert.match(html, /id="account-network-empty"/);
  assert.match(html, /id="manage-account-network"/);
  assert.match(client, /class="network-workspace"/);
  assert.match(client, /elements\.accountNetworkEmpty\.hidden = !noNodes/);
  assert.match(client, /\/api\/network\/sources/);
  assert.match(client, /data-network-action="test-all"/);
  assert.match(client, /\/test-all/);
  assert.match(server, /networkManager\.testSource/);
  assert.match(client, /data-action="network"/);
  assert.match(server, /AccountNetworkManager/);
  assert.match(server, /networkManager\.browserArgs/);
  assert.match(server, /networkManager\.ensureAccount/);
});

test('官方 OAuth 会监测独立 Chrome 关闭和登录接口 HTML 响应并自动释放', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /function watchOfficialLoginBrowser\(account, pending, browser\)/);
  assert.match(server, /missed >= 3[^\n]+登录窗口已关闭/);
  assert.match(server, /function attachOfficialLoginDiagnostics\(account, pending, browser\)/);
  assert.match(server, /CODEX_NAVO_LOGIN_DIAGNOSTICS === '1'/);
  assert.match(server, /\^\(\?:Fetch\|XHR\)\$/);
  assert.match(server, /browserDiagnostics\.push\(diagnostic\)/);
  assert.doesNotMatch(server, /pending\.fail\(`官方登录接口/);
  assert.match(server, /pendingCodexLogins\.delete\(account\.id\)/);
  assert.match(server, /resetIncompleteLoginBrowser\(account\)/);
  assert.match(server, /codex\.login\.browser-state-preserved/);
  const resetBody = server.slice(
    server.indexOf('async function resetIncompleteLoginBrowser'),
    server.indexOf('function completeCodexLogin'),
  );
  assert.doesNotMatch(resetBody, /rmSync\(browserDir,/);
});

test('新增账号在界面和服务端都默认使用 Chrome', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /每个账号使用独立的 Chrome 环境/);
  assert.doesNotMatch(html, /name="browserType"/);
  assert.doesNotMatch(client, /formData\.get\('browserType'\)/);
  assert.match(server, /browserType: 'chrome'/);
  assert.match(server, /function findBrowser\(\)/);
});

test('账号唤醒具备真实 Codex 调用、单账号入口、批量入口与自动策略设置', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="wake-all"/);
  assert.match(html, /data-app-page="wake"/);
  assert.match(html, /id="wake-form"/);
  assert.match(html, /value="after-reset"/);
  assert.match(html, /select name="model"/);
  assert.match(html, /select name="reasoningEffort"/);
  assert.match(client, /data-action="wake"/);
  assert.match(client, /\/api\/wake-all/);
  assert.match(server, /'exec', '--ephemeral'/);
  assert.match(server, /CODEX_HOME: codexHomeDir/);
  assert.match(server, /model_reasoning_effort=/);
  assert.match(server, /\/api\/wake-settings/);
  assert.match(server, /runScheduledWakes/);
  assert.match(server, /detectResetForAccount/);
  assert.match(html, /额度突然恢复/);
});

test('使用中统计同时识别租约和当前 Codex 账号', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(client, /account\.lease \|\| account\.codexActive/);
  assert.match(client, /网页使用中/);
  assert.match(client, /release-action/);
  assert.match(client, /不会关闭网页/);
  assert.match(styles, /\.session-badge/);
});

test('账号池支持可记忆的列表与卡片双视图', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="view-switcher"/);
  assert.match(html, /data-view="list"/);
  assert.match(html, /data-view="grid"/);
  assert.match(client, /codex-navo-account-view/);
  assert.match(client, /classList\.toggle\('account-grid'/);
  assert.match(styles, /\.account-list\.account-grid/);
  assert.match(styles, /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) repeat\(4, 38px\)/);
});

test('账号池展示本机实时用量、历史范围和每账号明细', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="usage-overview"/);
  assert.match(html, /data-range="yesterday"/);
  assert.match(html, /data-range="30d"/);
  assert.match(client, /function renderAccountUsage\(account\)/);
  assert.match(client, /Token 估值/);
  assert.match(styles, /\.account-usage-strip/);
  assert.match(server, /\/api\/usage/);
  assert.match(server, /CodexUsageTracker/);
});

test('账号用量默认隐藏，点击卡片后独立展开并记住状态', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(client, /codex-navo-expanded-account-usage/);
  assert.match(client, /state\.expandedUsage\.has\(account\.id\)/);
  assert.match(client, /usageExpanded \? renderAccountUsage\(account\) : ''/);
  assert.match(client, /event\.target\.closest\('a, input, select, textarea, label'\)/);
  assert.match(styles, /\.account-card\.usage-expanded/);
});

test('本机与账号用量会显示简洁缓存率', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /function formatCacheHitRate\(usage\)/);
  assert.match(client, /cachedTokens \/ inputTokens \* 100/);
  assert.match(client, /缓存率 \$\{formatCacheHitRate\(totals\)\}/);
  assert.match(client, /输入 \$\{formatTokenCount\(usage\.inputTokens, true\)\} · 缓存率 \$\{formatCacheHitRate\(usage\)\} · 输出/);
});

test('Key 编辑器名称使用完整行并与账号顺序面板留出间距', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /label\[data-api-field-row="name"\][^{]*\{[^}]*grid-column:\s*1\s*\/\s*-1/);
  assert.match(styles, /\.api-account-picker\s*\{[^}]*margin-top:\s*9px/);
});

test('Codex 启动过程提供右下角分阶段进度并阻止重复启动', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="codex-launch-status"/);
  assert.match(client, /\/api\/codex-launch-progress/);
  assert.match(client, /setLaunchControlsDisabled/);
  assert.match(server, /startCodexLaunchProgress/);
  assert.match(server, /正在检测代理可用性/);
  assert.match(server, /正在加载项目与会话/);
  assert.match(server, /正在打开 Codex/);
  assert.match(html, /id="codex-launch-status-close"[^>]+aria-label="关闭启动进度"/);
  assert.doesNotMatch(html, /id="codex-launch-status-close"[^>]+hidden/);
  assert.match(client, /state\.launchProgressDismissed = true/);
  assert.match(client, /1800 - \(Date\.now\(\) - completedAt\)/);
});

test('批量节点检测随完成结果实时刷新并继续后台检测', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(client, /\/api\/network-state/);
  assert.match(client, /setInterval\(async \(\) =>/);
  assert.match(client, /检测 \$\{selected\.testing\.completed\} \/ \$\{selected\.testing\.total\}/);
  assert.match(server, /url\.pathname === '\/api\/network-state'/);
});

test('节点列表按内容收缩且只在超过最大高度后滚动', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.network-page-form \.network-workspace\s*\{[^}]*min-height:\s*0/);
  assert.match(styles, /\.network-node-list\s*\{[^}]*max-height:\s*226px[^}]*overflow-y:\s*auto/);
  assert.match(styles, /\.network-node-list\s*\{[^}]*grid-auto-rows:\s*minmax\(38px, auto\)[^}]*align-content:\s*start/);
  assert.match(styles, /\.network-node-pane\s*\{[^}]*align-self:\s*start/);
});

test('Token 大数保留 M 主值并补充亿单位小标签', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(client, /notation: 'compact'/);
  assert.match(client, /function formatYiTokenNote\(value\)/);
  assert.match(client, /number < 100_000_000/);
  assert.match(client, /class="token-scale-note">约/);
  assert.match(styles, /\.usage-primary > div > \.token-scale-note/);
});

test('单账号今日用量以总 Token 为主并将美元降级为估值明细', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /class="account-usage-total"/);
  assert.match(client, /account-usage-total[\s\S]*formatTokenCount\(usage\.totalTokens, true\)/);
  assert.match(client, /class="usage-estimate"[\s\S]*Token 估值/);
});

test('再次打开账号网页端时恢复各自上次关闭的 Chrome 窗口', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /function hasRestorableBrowserSession\(browserDir\)/);
  assert.match(server, /--restore-last-session/);
  assert.match(server, /--disable-background-mode/);
  assert.match(server, /restoreLastSession: true/);
  assert.match(server, /launchAccountBrowser\(account, authUrl, \{ returnSession: true \}\)/);
});

test('首次创建账号时直接打开官方 OAuth 地址', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /startCodexBrowserLogin\(account, operator\)/);
  assert.match(server, /launchAccountBrowser\(account, authUrl, \{ returnSession: true \}\)/);
  assert.match(server, /args\.push\('--new-window', \.\.\.initialUrls\)/);
});

test('账号授权具备可恢复状态、健康检查与账号迁移入口', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="account-tools-button"/);
  assert.match(html, /data-app-page="authorization"/);
  assert.match(html, /id="health-list"/);
  assert.match(html, /账号授权包/);
  assert.match(client, /\/api\/accounts\/health-all/);
  assert.match(client, /\/api\/auth-packages\/import/);
  assert.match(client, /data-action="cancel-authorization"/);
  assert.match(server, /AUTH_ATTEMPTS_FILE/);
  assert.match(server, /status: 'interrupted'/);
  assert.match(server, /createAuthPackage/);
  assert.match(server, /readAuthPackage/);
});

test('授权工具锁定底层滚动并在弹窗内显示操作结果', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="tools-status"/);
  assert.match(client, /function showToolsStatus/);
  assert.match(client, /MutationObserver\(syncModalScrollLock\)/);
  assert.match(styles, /html\.modal-open, body\.modal-open \{ overflow: hidden/);
  assert.match(styles, /\.tools-status\.error/);
});

test('授权包使用单个文件且不要求密码或密钥文件', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /单个 \.codexnavo/);
  assert.doesNotMatch(html, /id="export-password"|id="import-password"|id="import-key-file"/);
  assert.doesNotMatch(client, /keyFileName|importKeyFile/);
  assert.match(server, /createAuthPackage/);
  assert.match(server, /readAuthPackage/);
});

test('添加账号直接展示官方登录与授权包导入', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /class="login-method-primary"[\s\S]*<strong>登录并授权<\/strong>/);
  assert.match(html, /class="login-method-import"[\s\S]*<strong>导入已有账号<\/strong>/);
  assert.doesNotMatch(html, /<details class="login-method-more">/);
  assert.doesNotMatch(html, /<strong>后台交互登录<\/strong>/);
  assert.doesNotMatch(client, /more\.open/);
  assert.doesNotMatch(client, /data-action="authorize-protocol"/);
  assert.match(server, /account\.loginMethod = 'official'/);
  assert.doesNotMatch(html, /protocol-login-note|mail-interface-endpoint|邮箱接口检测/);
  assert.doesNotMatch(client, /mailInterfaceEndpoint|checkMailInterface|\/api\/mail-interface\/check/);
  assert.doesNotMatch(server, /fetchPublicMetadata|\/api\/mail-interface\/check/);
});

test('皮肤管理已从界面与运行时完整移除', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(html, /皮肤管理|data-app-page="appearance"|theme-studio\.js/);
  assert.doesNotMatch(server, /themeManager|\/api\/themes/);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'public', 'theme-studio.js')), false);
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'lib', 'codex-theme.js')), false);
});

test('添加账号弹窗可直接导入单个授权包', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /name="loginMethod" value="import"/);
  assert.match(html, /id="account-import-package-file"/);
  assert.match(html, /id="account-import-panel"/);
  assert.match(app, /state\.accountImportPackageText/);
  assert.match(app, /requestedLoginMethod === 'import'/);
  assert.match(app, /readAuthorizationPackageFile/);
  assert.match(app, /\/api\/auth-packages\/import/);
  assert.match(styles, /\.account-import-panel/);
});

test('单账号授权检查显示进行中交互，完成提示可关闭并自动消失', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(app, /button\.textContent = '检查中…'/);
  assert.match(app, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /checked\.label.*health\.label.*health\.detail/s);
  assert.match(app, /close\.addEventListener\('click', hideToolsStatus/);
  assert.match(app, /autoHideMs = error \? 0 : 5_000/);
  assert.match(styles, /\.tools-status-close/);
  assert.match(styles, /\.health-row button\.is-loading/);
});

test('授权包导出和导入同时处理 Codex 授权与独立 Chrome 网页会话', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const protocol = fs.readFileSync(path.join(__dirname, '..', 'lib', 'protocol-login.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(server, /async function exportAccountWebSession/);
  assert.match(server, /async function importAccountWebSession/);
  assert.match(server, /files\['web-session\.json'\] = webSession/);
  assert.match(server, /webSessionIncluded: Boolean\(webSession\)/);
  assert.match(protocol, /async function readProtocolCookies/);
  assert.match(client, /双端授权包已生成/);
  assert.match(client, /Codex 授权与网页会话均已验证/);
});

test('协议登录移除临时凭证续期并保留官方重新授权入口', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.doesNotMatch(server, /operation === 'renew'|runScheduledAuthRenewals|beginProtocolRenewal/);
  assert.match(server, /const temporary = isNonRefreshableWebSessionAuth\(auth\)/);
  assert.match(server, /if \(temporary && account\.accountKind === 'relay'\)/);
  assert.match(server, /return !temporary/);
  assert.match(server, /旧版临时凭证不可刷新，请完成官方 Codex OAuth/);
  assert.doesNotMatch(client, /formatAuthExpiry|data-action="renew"|renewAction/);
  assert.match(client, /data-action="codex">登录 Codex</);
  assert.doesNotMatch(styles, /\.auth-expiry-badge|\.action-renew|\.account-grid \.account-actions\.has-renew/);
});

test('account creation keeps official login and package import only', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /name="loginMethod" value="official"/);
  assert.doesNotMatch(html, /name="loginMethod" value="protocol"/);
  assert.match(html, /name="loginMethod" value="official" checked/);
  assert.match(html, /class="login-method-import"/);
  assert.doesNotMatch(html, /value="cdk"|name="mockOtpEndpoint"|name="protocolPaste"/);
  assert.match(html, /name="loginMethod" value="import"/);
  assert.doesNotMatch(client, /openProtocolDialog\(created\)/);
  assert.doesNotMatch(client, /\/authorize-protocol/);
  assert.doesNotMatch(client, /cdkImportToken|mockOtpEndpoint|protocolPaste/);
  assert.doesNotMatch(server, /pendingCdkImports|\/api\/cdk\/redeem|MailOtpSession|mockOtpEndpoint|otpSession|otpController/);
});

test('网络线路使用单行添加布局，并在账号线路选择中展示排序后的延迟状态', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /<textarea[^>]+name="input"[^>]+rows="1"[^>]+wrap="off"/);
  assert.match(html, /class="network-add-button"[^>]*><span>＋<\/span>添加线路<\/button>/);
  assert.match(client, /function nodeRouteText\(node\)/);
  assert.match(client, /node\.protocol}  ·  \$\{nodeRouteText\(node\)}/);
  assert.match(styles, /\.network-import-panel \{[^}]*grid-template-columns: 190px minmax\(0, 1fr\) 108px/s);
  assert.match(styles, /\.network-import-panel textarea \{[^}]*white-space: nowrap/s);
  assert.match(html, /data-network-input-label/);
  assert.match(client, /querySelectorAll\('\[data-network-input-label\]'\)/);
  assert.match(client, /control\.focus\(\{ preventScroll: true \}\)/);
  assert.match(styles, /\.network-import-panel input, \.network-import-panel textarea \{[^}]*pointer-events:\s*auto[^}]*user-select:\s*text/s);
});

test('主界面使用可记忆侧边栏收纳七个居中功能入口', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  for (const label of ['账号管理', '网络代理', '授权迁移', '会话管理', 'API 服务', '唤醒设置']) {
    assert.match(html, new RegExp(`>${label}<`));
  }
  assert.match(html, /id="app-sidebar"/);
  assert.match(html, /id="sidebar-toggle"/);
  assert.match(client, /codex-navo-sidebar-collapsed/);
  assert.match(client, /function setSidebarActive\(section = 'accounts'\)/);
  assert.match(client, /function showAppPage\(section = 'accounts'\)/);
  for (const page of ['accounts', 'network', 'authorization', 'sessions', 'reverse-proxy', 'wake']) {
    assert.match(html, new RegExp(`data-app-page="${page}"`));
  }
  assert.match(client, /document\.querySelectorAll\('\[data-sidebar-section\]'\)/);
  assert.match(styles, /\.app-workspace \{[^}]*grid-template-columns: 176px minmax\(0, 1fr\)/s);
  assert.match(styles, /\.app-workspace\.sidebar-collapsed \{[^}]*grid-template-columns: 58px minmax\(0, 1fr\)/s);
  assert.match(styles, /\.sidebar-item \{[^}]*justify-content: center/s);
  assert.doesNotMatch(html, /class="sidebar-status"/);
});

test('API 服务使用应用内表单而不是 Electron 不支持的原生 prompt', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const apiSection = client.slice(client.indexOf('async function editApiKey'), client.indexOf('elements.codexUpdateAction'));
  assert.doesNotMatch(apiSection, /\bprompt\s*\(/);
  assert.match(client, /function openApiFormDialog/);
  assert.match(client, /function openApiConfirmDialog/);
  assert.match(styles, /\.api-editor-dialog/);
  assert.match(styles, /\.api-editor-fields/);
});

test('API 服务顶部展示文档并移除无效说明卡', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /class="feature-surface api-docs-panel"/);
  assert.match(html, /\/v1\/models/);
  assert.match(html, /\/v1\/responses/);
  assert.match(html, /\/v1\/chat\/completions/);
  assert.match(html, /class="api-management-grid"/);
  assert.doesNotMatch(html, /class="feature-surface api-service-overview"/);
  assert.doesNotMatch(html, /CODEX RUNTIME/);
  assert.match(client, /data-api-copy/);
  assert.match(styles, /\.api-docs-panel/);
});

test('Navo Key 只使用内置账号池并可选择账号池模型', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const manager = fs.readFileSync(path.join(__dirname, '..', 'lib', 'api-service.js'), 'utf8');
  const keyEditor = client.slice(client.indexOf('async function editApiKey'), client.indexOf('elements.apiKeyAdd'));
  assert.match(keyEditor, /providerIds: \[accountPool\.id\]/);
  assert.match(keyEditor, /mountModelPicker/);
  assert.doesNotMatch(keyEditor, /允许的供应商 ID|mountProviderPicker/);
  assert.match(server, /ensureAccountPool\(wakeModelCatalog/);
  assert.match(manager, /ACCOUNT_POOL_PROVIDER_ID = 'codex-navo-account-pool'/);
  assert.doesNotMatch(manager, /upsertProvider|removeProvider|ensureCodexProfile/);
});

test('外部模型供应商界面与服务端接口已完整移除', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(html, /外部模型供应商|添加供应商|api-provider-add|api-provider-list/);
  assert.doesNotMatch(client, /editApiProvider|API_PROVIDER_PRESETS|providers\/discover-models/);
  assert.doesNotMatch(server, /discoverApiProviderModels|launchProviderCodex|\/api\/api-service\/providers/);
});

test('API Key 管理使用独立整行布局', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const apiSection = client.slice(client.indexOf('function renderApiService'), client.indexOf('elements.apiKeyAdd'));
  assert.doesNotMatch(apiSection, /\?\?\?/);
  assert.match(apiSection, /创建 Navo API Key|还没有 Navo API Key/);
  assert.match(styles, /\.api-management-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s);
  assert.doesNotMatch(styles, /\.api-management-grid \.api-service-row \{[^}]*grid-template-columns: minmax\(0, 1fr\)/s);
});

test('Navo API cards are always shown and use a dedicated account-pool proxy route', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const editor = client.slice(client.indexOf('async function editApiKey'), client.indexOf('elements.apiKeyAdd'));
  const cards = client.slice(client.indexOf('function renderApiAccountCards'), client.indexOf('function render()'));
  assert.doesNotMatch(editor, /label: '添加到账号管理'/);
  assert.doesNotMatch(cards, /filter\(\(key\) => key\.showInAccounts\)/);
  assert.match(client, /function openApiKeyNetwork\(key\)/);
  assert.match(client, /\/api\/api-service\/keys\/\$\{apiKeyId\}\/network/);
  assert.match(server, /function apiKeyNetworkId\(keyId\)/);
  assert.match(server, /apiKeyNetworkMatch/);
  assert.match(server, /accountPoolDispatcher\(keyRecord\)/);
  assert.match(styles, /\.account-grid \.api-virtual-card \.account-actions \{[^}]*repeat\(3, 38px\)/s);
});

test('Codex launch dialog keeps actions visible and omits the redundant language hint', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const launchDialog = client.slice(client.indexOf('async function openCodexLaunchDialog'), client.indexOf('function parseModelList'));
  assert.doesNotMatch(launchDialog, /跟随 Navo 默认语言/);
  assert.match(styles, /\.codex-launch-dialog form \{[^}]*display: flex[^}]*height: 100%[^}]*flex-direction: column/s);
  assert.match(styles, /\.launch-projects \{[^}]*flex: 1 1 auto[^}]*overflow-y: auto/s);
  assert.match(styles, /\.codex-launch-dialog \.dialog-actions \{[^}]*flex: 0 0 auto/s);
});

test('launch selection exposes progress and account groups fold independently', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(client, /data-launch-progress/);
  assert.match(client, /selectionProgress\.value/);
  assert.match(client, /accountGroupsStorageKey/);
  assert.match(client, /data-account-group/);
  assert.match(styles, /\.launch-selection-progress/);
  assert.match(styles, /\.account-group-head/);
});

test('local usage includes API key usage and sessions use nested project hierarchy', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(client, /function mergedLocalUsageTotals/);
  assert.match(client, /state\.apiService\?\.keys/);
  assert.doesNotMatch(html, /id="session-monitor-state"/);
  assert.match(client, /session-project-icon/);
  assert.match(client, /session-thread-line/);
  assert.match(styles, /\.session-project-group \{[^}]*border-radius/s);
  assert.match(styles, /\.session-thread-line/);
});

test('failed sessions can be cleared in either list-only or local-delete mode', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="session-clear-failed"/);
  assert.match(client, /elements\.sessionClearFailed\.hidden = state\.sessionFilter !== 'failed'/);
  assert.match(client, /value: 'list'/);
  assert.match(client, /value: 'delete'/);
  assert.match(client, /\/api\/sessions\/failed\/clear/);
  assert.match(server, /url\.pathname === '\/api\/sessions\/failed\/clear'/);
  assert.match(server, /sessionMonitor\.clearFailed\(body\.mode \|\| 'list'\)/);
});

test('all-session projects start collapsed and the desktop sidebar stays viewport-fixed', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(client, /sessionAllSeenGroups: new Set\(\)/);
  assert.match(client, /state\.sessionFilter === 'all' && !state\.sessionAllSeenGroups\.has\(group\.key\)/);
  assert.match(client, /state\.sessionCollapsed\.add\(group\.key\)/);
  assert.match(styles, /\.app-sidebar \{ position: fixed; top: 96px;/);
  assert.match(styles, /\.app-workspace > main \{ grid-column: 2; min-width: 0; \}/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.app-sidebar \{ position: sticky;/);
  assert.match(styles, /\.app-workspace > main \{ grid-column: 1; \}/);
});

test('usage labels stay concise without a redundant approximation symbol', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.doesNotMatch(client, /estimatedCostApproximate \? '≈'/);
  assert.match(client, /const prefix = usage\.unpricedRequests \? '≥' : ''/);
  assert.match(client, /输入与输出合计/);
  assert.match(client, /<span>输入<\/span>[\s\S]*<small>缓存率 \$\{formatCacheHitRate\(totals\)\}<\/small>/);
  assert.doesNotMatch(client, /输入（含缓存）|其中缓存/);
  assert.match(client, /merged\.totalTokens = Number\(merged\.inputTokens \|\| 0\) \+ Number\(merged\.outputTokens \|\| 0\)/);
});

test('notification message is user-authored and sound rows keep aligned controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="notification-volume-value"/);
  assert.doesNotMatch(html, /id="notification-template"|内置文案/);
  assert.match(html, /textarea name="notificationText"[^>]+required/);
  assert.match(html, /placeholder="有任务已处理完毕。"/);
  assert.doesNotMatch(client, /notificationTemplates|notificationTemplate/);
  assert.match(client, /notificationVolumeValue\.textContent/);
  assert.match(styles, /\.notification-two-column \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/s);
  assert.match(styles, /\.notification-control-card \{[^}]*min-height: 126px/s);
  assert.match(styles, /\.compact-switch input \{[^}]*width: 1px[^}]*height: 1px/s);
  assert.match(styles, /\.notification-channel \.compact-switch input \{[^}]*width: 1px[^}]*height: 1px/s);
});

test('language, network, and wake fields avoid mixed-language preset text', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.doesNotMatch(html, /placeholder="例如：工作线路"|placeholder="粘贴订阅链接|placeholder="hi">hi/);
  assert.match(client, /function localizedReasoningLabel/);
  assert.match(client, /characterData: true/);
  assert.match(styles, /\.language-settings-layout \{[^}]*width: 100%[^}]*max-width: none/s);
});

test('英文界面翻译只写入真正变化的文本，避免 MutationObserver 自触发卡死', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /if \(translated !== root\.nodeValue\) root\.nodeValue = translated/);
  assert.match(client, /if \(translated !== node\.nodeValue\) node\.nodeValue = translated/);
  assert.match(client, /if \(translated !== value\) node\.setAttribute\(name, translated\)/);
  assert.doesNotMatch(client, /root\.nodeValue = translateText\(root\.nodeValue\)/);
  assert.doesNotMatch(client, /node\.nodeValue = translateText\(node\.nodeValue\)/);
});
test('Navo API Codex temporarily switches provider config while retaining the normal desktop state', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /prepareApiKeyCodexHome\(keyId, model, secret, selection\)/);
  assert.match(server, /next\.CODEX_HOME = SHARED_CODEX_HOME/);
  assert.match(server, /apiCodexEnvironment\(process\.env, secret\)/);
  assert.match(server, /copyFileAtomic\(configFile, API_SHARED_CONFIG_BACKUP_FILE\)/);
  assert.match(server, /authManaged: true/);
  assert.match(server, /writeJsonAtomic\(SHARED_CODEX_AUTH_FILE, \{ OPENAI_API_KEY: secret \}\)/);
  assert.match(server, /apiKeyCodexConfig\(sourceConfig, model, secret, selection\?\.language\)/);
  assert.match(server, /experimental_bearer_token/);
  assert.match(server, /model_provider = "codex_navo"/);
  assert.match(server, /\[model_providers\.codex_navo\]/);
  assert.match(server, /restoreApiKeyCodexHome\(active\)/);
  assert.match(server, /fs\.writeFileSync\(configFile, apiKeyCodexConfig/);
});

test('third-party packages are imported from Add Account and shown as temporary accounts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(html, /id="relay-account-import-button"/);
  assert.match(html, /name="loginMethod" value="relay-import"/);
  assert.match(html, /<strong>导入第三方数据包<\/strong>/);
  for (const id of ['relay-import-dialog', 'relay-import-form', 'relay-import-file', 'relay-import-submit']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(client, /\/api\/relay-accounts\/import/);
  assert.match(client, /groupHead\('relay',/);
  assert.match(client, /groupHead\('relay', '临时账号'/);
  assert.doesNotMatch(client, /class="relay-badge"/);
  assert.match(client, /relay-account-card/);
  assert.match(client, /action-primary action-blocked/);
  assert.match(client, /disabled title=/);
  assert.match(styles, /\.relay-account-card/);
  assert.match(styles, /\.relay-import-dialog/);
  assert.match(server, /url\.pathname === '\/api\/relay-accounts\/import'/);
  assert.match(server, /account\.accountKind === 'relay'/);
  assert.match(server, /desktopLaunchAllowed: account\.accountKind !== 'relay'/);
});

test('账号网络可以在保存前检测当前选择的代理线路', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="test-account-network"[^>]*>检测当前线路<\/button>/);
  assert.match(client, /testAccountNetwork:\s*document\.querySelector\('#test-account-network'\)/);
  assert.match(client, /elements\.testAccountNetwork\.addEventListener\('click'/);
  assert.match(client, /\/api\/network\/sources\/\$\{sourceId\}\/test/);
  assert.match(styles, /\.account-network-actions #test-account-network\s*\{[^}]*margin-right:\s*auto/);
});

test('Add Account can create the same one-time Navo API Key used by API Service', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(html, /name="loginMethod" value="create-api"/);
  assert.match(html, /<strong>创建 API<\/strong>/);
  assert.doesNotMatch(html, /id="api-key-created"/);
  assert.match(client, /async function createApiKeyAndShowSecret\(\)/);
  assert.match(client, /function openApiSecretDialog\(secret\)/);
  assert.match(client, /复制 API Key/);
  assert.match(client, /完整 Key 只在这里显示一次/);
});

test('new API keys start with no accounts and detect models per selected account', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const quota = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-quota.js'), 'utf8');
  assert.match(client, /const selected = new Set\(selectedIds\)/);
  assert.doesNotMatch(client, /selectedIds\.length \? selectedIds : accounts\.map/);
  assert.match(client, /普通账号[\s\S]*临时账号/);
  assert.match(client, /\/api\/api-service\/models\/detect/);
  assert.match(server, /detectSelectedAccountModels/);
  assert.match(server, /accountModelCapabilities\.set/);
  assert.match(server, /accountPoolCandidates\(keyRecord\?\.accountIds, model\)/);
  assert.match(quota, /method: 'model\/list'/);
});

test('temporary account health uses temporary credential wording', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /label: '临时凭证正常'/);
  assert.doesNotMatch(server, /label: '反代凭证正常'/);
  assert.match(client, /\['临时凭证正常', 'Temporary credential ready'\]/);
});

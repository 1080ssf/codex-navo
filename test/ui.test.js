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

test('协议登录的全部交互步骤保留在添加账号弹窗中', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(html, /id="protocol-dialog-progress"/);
  assert.match(html, /id="protocol-progress-input"/);
  assert.match(app, /openProtocolDialog\(created\)/);
  assert.match(app, /renderProtocolPrompt\(login, 'protocol-modal-input'\)/);
  assert.match(app, /state\.protocolDialogAccountId/);
  assert.match(styles, /\.protocol-progress-active/);
});

test('协议登录弹窗直接显示后台连接错误且背景不使用磨砂模糊', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(client, /function showProtocolDialogConnectionError\(message\)/);
  assert.match(client, /elements\.protocolProgressTitle\.textContent = '后台服务连接中断'/);
  assert.match(client, /if \(showProtocolDialogConnectionError\(error\.message\)\) return/);
  assert.match(styles, /dialog::backdrop \{ background: rgba\(21,36,58,\.18\); backdrop-filter: none; \}/);
  assert.doesNotMatch(styles, /dialog::backdrop[^}]*blur\(/);
});

test('桌面端提供克制的更新入口和可取消的更新弹窗', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="update-chip"/);
  assert.match(html, /id="update-dialog"/);
  const updateDialog = html.match(/<dialog id="update-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.match(updateDialog, /value="cancel"[^>]*formnovalidate/);
  assert.match(updateDialog, /id="update-primary-action"/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.update-progress\[hidden\]\s*\{\s*display:\s*none/);
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
  assert.match(client, /requestAnimationFrame\(\(\) => elements\.form\.elements\.label\.focus\(\)\)/);
  assert.match(client, /!elements\.dialog\.open && !elements\.wakeDialog\.open && !elements\.updateDialog\.open/);
  assert.doesNotMatch(client, /nextState\.status === 'available'[\s\S]{0,160}showModal/);
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
  assert.match(server, /launchAccountBrowser\(account, authUrl\)/);
  assert.match(server, /authorize-device/);
});

test('界面与服务端不再包含代理和节点池功能', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(html, /节点池|node-dialog|networkMode|代理范围/);
  assert.doesNotMatch(client, /\/api\/nodes|nodeDialog|networkMode/);
  assert.doesNotMatch(server, /NODES_FILE|--proxy-server|proxy-credentials/);
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
  assert.match(html, /id="wake-dialog"/);
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
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) repeat\(3, 38px\)/);
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

test('列表模式的账号用量可以独立折叠并记住状态', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(client, /codex-navo-collapsed-account-usage/);
  assert.match(client, /data-action="toggle-usage"/);
  assert.match(client, /state\.viewMode === 'list'/);
  assert.match(styles, /\.account-usage-strip\.collapsed \.account-usage-line/);
  assert.match(styles, /\.account-grid \.usage-collapse-button \{ display: none; \}/);
});

test('本机与账号用量会显示缓存命中率', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /function formatCacheHitRate\(usage\)/);
  assert.match(client, /cachedTokens \/ inputTokens \* 100/);
  assert.match(client, /命中 \$\{formatCacheHitRate\(totals\)\}/);
  assert.match(client, /命中 \$\{formatCacheHitRate\(usage\)\}/);
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
  assert.match(server, /launchAccountBrowser\(account, authUrl\)/);
});

test('首次创建账号时直接打开官方 OAuth 地址', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /startCodexBrowserLogin\(account, operator\)/);
  assert.match(server, /launchAccountBrowser\(account, authUrl\)/);
  assert.match(server, /args\.push\('--new-window', \.\.\.initialUrls\)/);
});

test('账号授权具备可恢复状态、健康检查与账号迁移入口', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /id="account-tools-button"/);
  assert.match(html, /id="account-tools-dialog"/);
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

test('添加账号突出官方登录并将后台交互登录收纳到更多方式', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /class="login-method-primary"[\s\S]*<strong>登录并授权<\/strong>/);
  assert.match(html, /<details class="login-method-more">[\s\S]*<strong>更多登录方式<\/strong>/);
  assert.match(html, /<strong>后台交互登录<\/strong>/);
  assert.match(html, /验证码、手机号或 2FA 会在应用内提示/);
  assert.match(client, /if \(more\) more\.open = method !== 'official'/);
  assert.match(client, /data-action="authorize" type="button">改用官方登录/);
  assert.match(server, /account\.loginMethod = useProtocol \? 'protocol' : 'official'/);
  assert.doesNotMatch(html, /protocol-login-note|mail-interface-endpoint|邮箱接口检测/);
  assert.doesNotMatch(client, /mailInterfaceEndpoint|checkMailInterface|\/api\/mail-interface\/check/);
  assert.doesNotMatch(server, /fetchPublicMetadata|\/api\/mail-interface\/check/);
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
  assert.match(server, /return !isNonRefreshableWebSessionAuth\(auth\)/);
  assert.match(server, /旧版临时凭证不可刷新，请完成官方 Codex OAuth/);
  assert.doesNotMatch(client, /formatAuthExpiry|data-action="renew"|renewAction/);
  assert.match(client, /data-action="codex">登录 Codex</);
  assert.doesNotMatch(styles, /\.auth-expiry-badge|\.action-renew|\.account-grid \.account-actions\.has-renew/);
});

test('account creation keeps official and protocol login with manual prompts only', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(html, /name="loginMethod" value="official"/);
  assert.match(html, /name="loginMethod" value="protocol"/);
  assert.match(html, /name="loginMethod" value="official" checked/);
  assert.match(html, /class="login-method-more"/);
  assert.doesNotMatch(html, /value="cdk"|name="mockOtpEndpoint"|name="protocolPaste"/);
  assert.match(client, /function renderProtocolPrompt/);
  assert.match(client, /\['email_otp', 'totp', 'phone_otp'\]/);
  assert.match(client, /submitLabel = phone/);
  assert.match(client, /autocomplete = kind === 'password' \? 'current-password' : otp \? 'one-time-code'/);
  assert.match(client, /inputMode = otp \? 'numeric' : phone \? 'tel'/);
  assert.match(client, /\/protocol-input/);
  assert.doesNotMatch(client, /cdkImportToken|mockOtpEndpoint|protocolPaste/);
  assert.doesNotMatch(server, /pendingCdkImports|\/api\/cdk\/redeem|MailOtpSession|mockOtpEndpoint|otpSession|otpController/);
});

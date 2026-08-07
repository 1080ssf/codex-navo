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
  assert.match(html, /<option value="chrome">Google Chrome<\/option><option value="edge">/);
});

test('添加账号期间不会被后台刷新或更新弹窗抢走输入焦点', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /requestAnimationFrame\(\(\) => elements\.form\.elements\.label\.focus\(\)\)/);
  assert.match(client, /!elements\.dialog\.open && !elements\.updateDialog\.open/);
  assert.doesNotMatch(client, /nextState\.status === 'available'[\s\S]{0,160}showModal/);
});

test('新增账号在界面和服务端都默认使用 Chrome', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const select = html.match(/<select name="browserType">([\s\S]*?)<\/select>/)?.[1] || '';
  assert.match(select, /^<option value="chrome">/);
  assert.match(server, /body\.browserType === 'edge' \? 'edge' : 'chrome'/);
  assert.match(server, /account\.browserType \|\| 'chrome'/);
});

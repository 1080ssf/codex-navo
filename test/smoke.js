const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.CODEX_MANAGER_MOCK_LAUNCH = '1';
process.env.CODEX_MANAGER_NO_OPEN = '1';
process.env.CODEX_MANAGER_PORT = '0';

const root = path.resolve(__dirname, '..');
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-smoke-'));
process.env.CODEX_SWITCHBOARD_USER_DATA = runtimeRoot;
const tokenFile = path.join(runtimeRoot, 'data', 'access-token.txt');
const { server } = require('../server');
let testAccountId = '';

async function run() {
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const entry = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  if (entry.status !== 302) throw new Error(`入口状态码异常：${entry.status}`);
  const cookie = entry.headers.get('set-cookie').split(';')[0];
  const bootstrap = await fetch(`${baseUrl}/api/bootstrap`, { headers: { Cookie: cookie } });
  const payload = await bootstrap.json();
  if (!bootstrap.ok || !payload.ok || !Array.isArray(payload.data.accounts)) throw new Error('bootstrap API 冒烟测试失败');
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': payload.data.csrfToken };
  const addedResponse = await fetch(`${baseUrl}/api/accounts`, {
    method: 'POST', headers, body: JSON.stringify({ operator: '冒烟测试', label: '临时测试账号' }),
  });
  const added = await addedResponse.json();
  if (!addedResponse.ok || !added.ok) throw new Error('添加账号接口失败');
  const accountId = added.data.id;
  testAccountId = accountId;
  const codexHome = path.join(runtimeRoot, 'profiles', 'codex', accountId, 'home');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), '{}');

  const wakeSettingsResponse = await fetch(`${baseUrl}/api/wake-settings`, {
    method: 'POST', headers, body: JSON.stringify({ enabled: false, mode: 'manual', model: 'gpt-5.6-sol', reasoningEffort: 'low', prompt: 'hi' }),
  });
  if (!wakeSettingsResponse.ok) throw new Error('唤醒设置接口失败');
  const wakeResponse = await fetch(`${baseUrl}/api/accounts/${accountId}/wake`, {
    method: 'POST', headers, body: JSON.stringify({ operator: '冒烟测试' }),
  });
  if (!wakeResponse.ok) throw new Error('单账号唤醒接口失败');
  const wakeAllResponse = await fetch(`${baseUrl}/api/wake-all`, {
    method: 'POST', headers, body: JSON.stringify({ operator: '冒烟测试' }),
  });
  const wakeAll = await wakeAllResponse.json();
  if (!wakeAllResponse.ok || wakeAll.data?.succeeded !== 1) throw new Error('批量唤醒接口失败');

  const launchResponse = await fetch(`${baseUrl}/api/accounts/${accountId}/launch`, {
    method: 'POST', headers, body: JSON.stringify({ operator: '冒烟测试', launchType: 'browser' }),
  });
  if (!launchResponse.ok) throw new Error('启动接口失败');
  const repeatedLaunchResponse = await fetch(`${baseUrl}/api/accounts/${accountId}/launch`, {
    method: 'POST', headers, body: JSON.stringify({ operator: '另一位测试员', launchType: 'codex' }),
  });
  if (!repeatedLaunchResponse.ok) throw new Error('本机重复打开账号失败');
  const releaseResponse = await fetch(`${baseUrl}/api/accounts/${accountId}/release`, {
    method: 'POST', headers, body: JSON.stringify({ operator: '冒烟测试' }),
  });
  if (!releaseResponse.ok) throw new Error('释放接口失败');
  const removeResponse = await fetch(`${baseUrl}/api/accounts/${accountId}`, {
    method: 'DELETE', headers, body: JSON.stringify({ operator: '冒烟测试' }),
  });
  if (!removeResponse.ok) throw new Error('移除接口失败');

  console.log('Smoke API: OK (bootstrap, add, wake settings, wake, wake all, launch, reopen, release, remove)');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => server.close());

process.on('beforeExit', () => {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

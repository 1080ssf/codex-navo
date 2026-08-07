const fs = require('node:fs');
const path = require('node:path');

process.env.CODEX_MANAGER_MOCK_LAUNCH = '1';
process.env.CODEX_MANAGER_NO_OPEN = '1';
process.env.CODEX_MANAGER_PORT = '0';

const root = path.resolve(__dirname, '..');
const tokenFile = path.join(root, 'data', 'access-token.txt');
const accountsFile = path.join(root, 'config', 'accounts.json');
const leasesFile = path.join(root, 'data', 'leases.json');
const auditFile = path.join(root, 'data', 'audit.jsonl');
const auditBefore = fs.existsSync(auditFile) ? fs.readFileSync(auditFile) : null;
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
    method: 'POST', headers, body: JSON.stringify({ operator: '冒烟测试', label: '临时测试账号', browserType: 'edge' }),
  });
  const added = await addedResponse.json();
  if (!addedResponse.ok || !added.ok) throw new Error('添加账号接口失败');
  const accountId = added.data.id;
  testAccountId = accountId;

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

  console.log('Smoke API: OK (bootstrap, add, launch, reopen, release, remove)');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => server.close());

process.on('beforeExit', () => {
  if (testAccountId) {
    const savedAccounts = JSON.parse(fs.readFileSync(accountsFile, 'utf8')).filter((item) => item.id !== testAccountId);
    const savedLeases = JSON.parse(fs.readFileSync(leasesFile, 'utf8'));
    delete savedLeases[testAccountId];
    fs.writeFileSync(accountsFile, `${JSON.stringify(savedAccounts, null, 2)}\n`);
    fs.writeFileSync(leasesFile, `${JSON.stringify(savedLeases, null, 2)}\n`);
    fs.rmSync(path.join(root, 'profiles', 'browser', testAccountId), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'profiles', 'codex', testAccountId), { recursive: true, force: true });
  }
  if (auditBefore) fs.writeFileSync(auditFile, auditBefore);
  else fs.rmSync(auditFile, { force: true });
});

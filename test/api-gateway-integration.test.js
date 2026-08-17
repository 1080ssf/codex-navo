const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { ApiServiceManager } = require('../lib/api-service');

function json(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const response = await fetch(url); if (response.status) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${url}`);
}

test('gateway serves account-pool models with Navo key authentication', { timeout: 20_000 }, async (t) => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-gateway-'));
  const gatewayPort = await port();
  const service = new ApiServiceManager({ runtimeRoot, readJson: json, writeJsonAtomic: write, gatewayPort });
  service.saveConfig({ enabled: true });
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ name: 'Integration' });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, CODEX_SWITCHBOARD_USER_DATA: runtimeRoot, CODEX_NAVO_API_PORT: String(gatewayPort), CODEX_MANAGER_PORT: '0', CODEX_MANAGER_NO_OPEN: '1', CODEX_MANAGER_MOCK_LAUNCH: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch {} });
  await waitFor(`http://127.0.0.1:${gatewayPort}/v1/models`);
  const headers = { Authorization: `Bearer ${created.secret}`, 'Content-Type': 'application/json' };
  const models = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers }).then((value) => value.json());
  assert.ok(models.data.some((model) => model.id === 'gpt-5.6-sol'));
  const healthResponse = await fetch(`http://127.0.0.1:${gatewayPort}/v1/pool/health`, { headers });
  assert.match(healthResponse.headers.get('x-request-id') || '', /^req_[a-f0-9]+$/);
  const health = await healthResponse.json();
  assert.equal(health.object, 'account_pool.health');
  assert.equal(health.status, 'unavailable');
  assert.equal(health.limits.timeout_seconds, 600);
  const noAccounts = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hello' }),
  });
  assert.equal(noAccounts.status, 503);
  assert.match(noAccounts.headers.get('x-request-id') || '', /^req_[a-f0-9]+$/);
  const noAccountsText = await noAccounts.text();
  assert.doesNotMatch(noAccountsText, /resolveProvider/);
  assert.equal(JSON.parse(noAccountsText).error.code, 'account_pool_unavailable');
  const largeHistory = await fetch(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
    method: 'POST', headers, body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'x'.repeat(3 * 1024 * 1024) }),
  });
  assert.equal(largeHistory.status, 503, 'large conversation payload should reach routing instead of failing with 413');
  const unauthorized = await fetch(`http://127.0.0.1:${gatewayPort}/v1/models`);
  assert.equal(unauthorized.status, 401);
  child.kill();
});

test('gateway keeps its configured fixed port when that port is occupied', { timeout: 20_000 }, async (t) => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const occupiedPort = blocker.address().port;
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-gateway-conflict-'));
  const service = new ApiServiceManager({ runtimeRoot, readJson: json, writeJsonAtomic: write, gatewayPort: occupiedPort });
  service.saveConfig({ enabled: true });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, CODEX_SWITCHBOARD_USER_DATA: runtimeRoot, CODEX_NAVO_API_PORT: String(occupiedPort), CODEX_MANAGER_PORT: '0', CODEX_MANAGER_NO_OPEN: '1', CODEX_MANAGER_MOCK_LAUNCH: '1' },
    stdio: 'ignore', windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch {} });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const stored = json(path.join(runtimeRoot, 'api-service', 'config.json'), {});
  assert.equal(stored.port, occupiedPort);
  assert.equal(service.publicState().baseUrl, `http://127.0.0.1:${occupiedPort}/v1`);
  child.kill();
});

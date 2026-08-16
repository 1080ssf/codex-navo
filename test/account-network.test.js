const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {
  AccountNetworkManager,
  classifyChatGptResponse,
  classifyOpenAiEndpoint,
  parseProxyInput,
  publicSource,
  selectTaskRoute,
  freeProxyPort,
  PROXY_PORT_END,
  PROXY_PORT_START,
  unsupportedRegionFromNodeName,
} = require('../lib/account-network');

test('descriptive proxy text and split SOCKS5 fields are accepted', () => {
  const described = parseProxyInput([
    'Proxy Type: SOCKS5',
    'Proxy URL: socks5://demo:secret@127.0.0.1:1080',
    'Host: 127.0.0.1',
  ].join('\n'));
  assert.equal(described.nodes.length, 1);
  assert.equal(described.nodes[0].protocol, 'SOCKS5');
  assert.equal(described.nodes[0].name, '127.0.0.1:1080');

  const split = parseProxyInput([
    'Proxy Type: SOCKS5',
    'Host: 127.0.0.1',
    'Port: 1080',
    'Username: demo user',
    'Password: demo password',
  ].join('\n'));
  assert.equal(split.nodes.length, 1);
  assert.equal(split.nodes[0].protocol, 'SOCKS5');
  assert.match(split.content, /^socks5:\/\/demo%20user:demo%20password@127\.0\.0\.1:1080$/);
});

test('代理运行时使用 18301-18399 可复用端口池并跳过已占用端口', async (t) => {
  assert.equal(PROXY_PORT_START, 18301);
  assert.equal(PROXY_PORT_END, 18399);
  const candidate = await freeProxyPort();
  const occupied = net.createServer();
  await new Promise((resolve, reject) => occupied.once('error', reject).listen(candidate, '127.0.0.1', resolve));
  t.after(() => { if (occupied.listening) occupied.close(); });
  assert.notEqual(await freeProxyPort(candidate), candidate);
  await new Promise((resolve) => occupied.close(resolve));
  assert.equal(await freeProxyPort(candidate), candidate);
});

test('批量节点检测通过公开状态逐个发布进度', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'account-network.js'), 'utf8');
  assert.match(source, /sourceTestProgress/);
  assert.match(source, /status: 'checking'/);
  assert.match(source, /publish\(\)/);
  assert.match(source, /completed: summary\.available \+ summary\.unsupported \+ summary\.failed/);
});

test('自动识别单节点、多节点、Base64 订阅内容和远程订阅', () => {
  const direct = parseProxyInput('socks5://user:pass@127.0.0.1:1080#Local');
  assert.equal(direct.kind, 'local');
  assert.equal(direct.nodes[0].protocol, 'SOCKS5');
  assert.equal(direct.nodes[0].name, 'Local');

  const multiple = parseProxyInput('ss://YWVzLTI1Ni1nY206cGFzcw@example.com:443#HK\nvless://uuid@example.org:443#Tokyo');
  assert.deepEqual(multiple.nodes.map((node) => node.protocol), ['SS', 'VLESS']);

  const encoded = Buffer.from('trojan://secret@example.com:443#SG\nhy2://secret@example.net:8443#US').toString('base64');
  assert.deepEqual(parseProxyInput(encoded).nodes.map((node) => node.protocol), ['TROJAN', 'HYSTERIA2']);

  const subscription = parseProxyInput('https://sub.example.com/api/v1/client/subscribe?token=secret', '机场 A');
  assert.equal(subscription.kind, 'subscription');
  assert.equal(subscription.name, '机场 A');
});

test('HTTP 主机端口识别为节点，带路径和令牌的 URL 识别为订阅', () => {
  assert.equal(parseProxyInput('http://127.0.0.1:7890').kind, 'local');
  assert.equal(parseProxyInput('https://sub.example.com/link/abc?token=secret').kind, 'subscription');
});

test('公开订阅信息会隐藏查询参数和节点密钥', () => {
  const source = {
    id: 'network-123456789abc', kind: 'subscription', name: '机场', format: 'subscription',
    url: 'https://sub.example.com/path?token=secret', nodes: [{ name: 'HK', protocol: 'VMESS', uri: 'vmess://secret' }],
  };
  const visible = publicSource(source);
  assert.equal(visible.location, 'https://sub.example.com/path');
  assert.equal(JSON.stringify(visible).includes('secret'), false);
  assert.equal('uri' in visible.nodes[0], false);
  assert.equal(visible.nodes[0].delay, null);
});

test('公开节点按照可用状态和连接延迟排序，失败与未检测节点后置', () => {
  const visible = publicSource({
    id: 'network-sort', kind: 'local', name: '排序测试', format: 'links',
    nodes: [
      { name: '连接失败', protocol: 'VMESS', delay: null, status: 'connection-failed' },
      { name: '高延迟', protocol: 'VMESS', connectDelay: 320, delay: 920, status: 'available' },
      { name: '未检测', protocol: 'VMESS', delay: null, status: '' },
      { name: '地区限制', protocol: 'VMESS', connectDelay: 30, delay: 80, status: 'unsupported-region' },
      { name: '低延迟', protocol: 'VMESS', connectDelay: 45, delay: 105, status: 'available' },
    ],
  });
  assert.deepEqual(visible.nodes.map((node) => node.name), [
    '低延迟', '高延迟', '地区限制', '未检测', '连接失败',
  ]);
});

test('ChatGPT 测速会区分正常、地区不支持和普通拒绝', () => {
  assert.equal(classifyChatGptResponse('HTTP/1.1 200 OK\r\n\r\n', 123).status, 'available');
  assert.equal(classifyChatGptResponse('HTTP/1.1 401 Unauthorized\r\n\r\n', 180).status, 'available');
  assert.equal(classifyChatGptResponse('HTTP/1.1 403 Forbidden\r\n\r\n{"error":"unsupported_country"}', 234).status, 'unsupported-region');
  assert.equal(classifyChatGptResponse('HTTP/1.1 403 Forbidden\r\n\r\nAccess denied', 345).status, 'blocked');
  const challenge = classifyChatGptResponse('HTTP/1.1 403 Forbidden\r\ncf-mitigated: challenge\r\ncontent-type: text/html\r\n\r\nJust a moment', 321);
  assert.equal(challenge.status, 'cloudflare-protected');
  assert.equal(challenge.ok, true);
  assert.equal(classifyChatGptResponse('HTTP/1.1 429 Too Many Requests\r\n\r\n', 456).status, 'rate-limited');
});

test('节点测速只访问 ChatGPT 首页并使用普通 Chrome 标识', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'account-network.js'), 'utf8');
  const probe = source.slice(source.indexOf('function probeChatGpt('), source.indexOf('class AccountNetworkManager'));
  assert.match(probe, /GET \/ HTTP\/1\.1/);
  assert.match(probe, /AppleWebKit\/537\.36/);
  assert.match(probe, /secure\.once\('secureConnect',[\s\S]*connectLatencyMs = Date\.now\(\) - startedAt/);
  assert.ok(probe.indexOf('connectLatencyMs = Date.now() - startedAt') > probe.indexOf("secure.once('secureConnect'"));
  assert.match(probe, /connectLatencyMs/);
  assert.doesNotMatch(probe, /backend-api\/models|Codex-Navo\/1\.0/);
});

test('官方不支持地区可从节点国旗和名称预先识别', () => {
  assert.equal(unsupportedRegionFromNodeName('🇭🇰 香港01 CloudFront'), '中国香港');
  assert.equal(unsupportedRegionFromNodeName('RU Moscow Premium'), '俄罗斯');
  assert.equal(unsupportedRegionFromNodeName('🇻🇪 Venezuela 01'), '委内瑞拉');
  assert.equal(unsupportedRegionFromNodeName('🇹🇼 台湾 01'), '');
  assert.equal(unsupportedRegionFromNodeName('🇸🇬 Singapore 01'), '');
});

test('登录链路检测会区分 JSON、Cloudflare HTML 和伪 JSON 页面', () => {
  const json = classifyOpenAiEndpoint(
    'chatgpt-auth-api',
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"csrfToken":"fixture"}',
    120,
  );
  assert.equal(json.ok, true);
  assert.equal(json.status, 'available');

  const blocked = classifyOpenAiEndpoint(
    'chatgpt-auth-api',
    'HTTP/1.1 403 Forbidden\r\nContent-Type: text/html; charset=UTF-8\r\nServer: cloudflare\r\n\r\n<!DOCTYPE html>',
    180,
  );
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'cloudflare-blocked');

  const html = classifyOpenAiEndpoint(
    'chatgpt-auth-api',
    'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<!DOCTYPE html>',
    190,
  );
  assert.equal(html.ok, false);
  assert.equal(html.status, 'html-instead-of-json');

  const authJson = classifyOpenAiEndpoint(
    'openai-auth-api',
    'HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"error":"missing parameters"}',
    83,
  );
  assert.equal(authJson.ok, true);

  const authHtml = classifyOpenAiEndpoint(
    'openai-auth-api',
    'HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\n\r\n<!DOCTYPE html><title>Just a moment...</title>',
    91,
  );
  assert.equal(authHtml.ok, false);
  assert.equal(authHtml.status, 'cloudflare-blocked');
});

test('账号可以独立绑定节点，公开状态不会包含代理凭据', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-network-'));
  try {
    const manager = new AccountNetworkManager({ runtimeRoot });
    const source = manager.addSource('vless://uuid@example.org:443#Tokyo', '测试节点');
    const assignment = manager.assign('account-demo', { mode: 'proxy', sourceId: source.id, nodeName: 'Tokyo' });
    assert.equal(assignment.mode, 'proxy');
    assert.equal(assignment.label, '测试节点');
    assert.equal(assignment.displayName, '测试节点');
    assert.equal(JSON.stringify(manager.publicState()).includes('uuid'), false);
    assert.equal(manager.assign('account-demo', { mode: 'direct' }).mode, 'direct');
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('账号代理覆盖任意远程站点并只绕过本机回环连接', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-network-env-'));
  try {
    const manager = new AccountNetworkManager({ runtimeRoot });
    manager.accountRuntimes.set('account-demo', { child: { exitCode: null, killed: false }, mixedPort: 17890 });
    const environment = manager.environment('account-demo', {
      ALL_PROXY: 'http://old.proxy:1',
      NO_PROXY: 'github.com,api.github.com',
    });
    assert.equal(environment.HTTP_PROXY, 'http://127.0.0.1:17890');
    assert.equal(environment.HTTPS_PROXY, environment.HTTP_PROXY);
    assert.equal(environment.ALL_PROXY, environment.HTTP_PROXY);
    assert.equal(environment.all_proxy, environment.HTTP_PROXY);
    assert.match(environment.NO_PROXY, /localhost/);
    assert.match(environment.NO_PROXY, /127\.0\.0\.1/);
    assert.doesNotMatch(environment.NO_PROXY, /github\.com/);
    assert.doesNotMatch(environment.NO_PROXY, /example\.com/);
    assert.equal(environment.no_proxy, environment.NO_PROXY);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('后台任务优先使用正在运行账号的可用节点，否则选择最低连接延迟节点', () => {
  const data = {
    sources: [
      { id: 'source-a', nodes: [{ name: 'Active', status: 'available', connectDelay: 88, delay: 680 }] },
      { id: 'source-b', nodes: [{ name: 'Fast', status: 'available', connectDelay: 42, delay: 95 }, { name: 'Failed', status: 'connection-failed', connectDelay: 12, delay: 12 }] },
    ],
    assignments: {
      active: { mode: 'proxy', sourceId: 'source-a', nodeName: 'Active' },
      fast: { mode: 'proxy', sourceId: 'source-b', nodeName: 'Fast' },
      failed: { mode: 'proxy', sourceId: 'source-b', nodeName: 'Failed' },
    },
  };
  assert.deepEqual(selectTaskRoute(data, 'active'), {
    accountId: 'active', sourceId: 'source-a', nodeName: 'Active', delay: 88,
  });
  assert.deepEqual(selectTaskRoute(data), {
    accountId: '', sourceId: 'source-b', nodeName: 'Fast', delay: 42,
  });
  assert.equal(selectTaskRoute({
    sources: [{ id: 'failed-source', nodes: [{ name: 'Failed', status: 'connection-failed', delay: 12 }] }],
    assignments: { failed: { mode: 'proxy', sourceId: 'failed-source', nodeName: 'Failed' } },
  }), null);
});

test('direct, live proxy, dead proxy and per-account routes stay isolated', () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-network-routing-'));
  try {
    const manager = new AccountNetworkManager({ runtimeRoot });
    const base = { SAMPLE_ENV: 'kept' };
    assert.deepEqual(manager.environment('direct-account', base), base);
    assert.deepEqual(manager.browserArgs('direct-account'), []);

    manager.accountRuntimes.set('account-a', { child: { exitCode: null, killed: false }, mixedPort: 17891 });
    manager.accountRuntimes.set('account-b', { child: { exitCode: null, killed: false }, mixedPort: 17892 });
    manager.accountRuntimes.set('dead-account', { child: { exitCode: 1, killed: false }, mixedPort: 17893 });

    assert.equal(manager.environment('account-a', base).ALL_PROXY, 'http://127.0.0.1:17891');
    assert.equal(manager.environment('account-b', base).ALL_PROXY, 'http://127.0.0.1:17892');
    assert.deepEqual(manager.environment('dead-account', base), base);
    assert.deepEqual(manager.browserArgs('dead-account'), []);
    assert.equal(manager.isAccountRuntimeReady('account-a'), true);
    assert.equal(manager.isAccountRuntimeReady('dead-account'), false);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('同一账号并发准备代理只启动一个核心，不会影响其他账号运行时', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-network-singleflight-'));
  try {
    const manager = new AccountNetworkManager({ runtimeRoot });
    const source = manager.addSource('vless://uuid@example.org:443#Tokyo', '测试节点');
    manager.assign('account-b', { mode: 'proxy', sourceId: source.id, nodeName: 'Tokyo' });
    let starts = 0;
    let releaseStart;
    const startGate = new Promise((resolve) => { releaseStart = resolve; });
    manager.startRuntime = async () => {
      starts += 1;
      await startGate;
      return { child: { exitCode: null, killed: false, kill() { this.killed = true; } }, mixedPort: 17895, groupName: 'Navo Account' };
    };
    manager.waitForProviderNodes = async () => [{ name: 'Tokyo' }];
    manager.request = async () => ({});

    const accountA = { child: { exitCode: null, killed: false, kill() { this.killed = true; } }, mixedPort: 17894 };
    manager.accountRuntimes.set('account-a', accountA);
    const first = manager.ensureAccount('account-b');
    const second = manager.ensureAccount('account-b');
    releaseStart();
    const [left, right] = await Promise.all([first, second]);

    assert.equal(starts, 1);
    assert.equal(left, right);
    assert.equal(manager.accountRuntimes.get('account-a'), accountA);
    assert.equal(accountA.child.killed, false);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('switching a node keeps the running account proxy port and core process', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-network-hot-switch-'));
  try {
    const manager = new AccountNetworkManager({ runtimeRoot });
    const source = manager.addSource(
      'vless://first@example.org:443#Tokyo\nvless://second@example.net:443#Singapore',
      'Nodes',
    );
    manager.assign('account-demo', { mode: 'proxy', sourceId: source.id, nodeName: 'Tokyo' });
    const child = { exitCode: null, killed: false, kill() { this.killed = true; } };
    const runtime = {
      child,
      mixedPort: 17896,
      controllerPort: 17897,
      groupName: 'Navo Account',
      sourceId: source.id,
      nodeName: 'Tokyo',
    };
    manager.accountRuntimes.set('account-demo', runtime);
    const requests = [];
    manager.request = async (_runtime, pathname, options) => {
      requests.push({ pathname, body: options?.body });
      return {};
    };

    manager.assign('account-demo', { mode: 'proxy', sourceId: source.id, nodeName: 'Singapore' });
    const selected = await manager.ensureAccount('account-demo');

    assert.equal(selected, runtime);
    assert.equal(selected.mixedPort, 17896);
    assert.equal(selected.nodeName, 'Singapore');
    assert.equal(child.killed, false);
    assert.equal(requests.length, 1);
    assert.match(requests[0].body, /Singapore/);
    assert.equal(manager.data.assignments['account-demo'].mixedPort, 17896);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('switching between sources and direct keeps the live proxy endpoint', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-network-cross-source-'));
  try {
    const manager = new AccountNetworkManager({ runtimeRoot });
    const tokyo = manager.addSource('vless://first@example.org:443#Tokyo', 'Tokyo line');
    const hongKong = manager.addSource('vless://second@example.net:443#Hong Kong', 'Hong Kong line');
    manager.assign('account-demo', { mode: 'proxy', sourceId: tokyo.id, nodeName: 'Tokyo' });
    const child = { exitCode: null, killed: false, kill() { this.killed = true; } };
    const runtime = {
      child,
      mixedPort: 17898,
      controllerPort: 17899,
      secret: 'fixture',
      runtimeDir: runtimeRoot,
      groupName: 'Navo Account',
      sourceId: tokyo.id,
      nodeName: 'Tokyo',
    };
    manager.accountRuntimes.set('account-demo', runtime);
    const selected = [];
    manager.request = async (_runtime, pathname, options) => {
      if (pathname.startsWith('/proxies/')) selected.push(JSON.parse(options.body).name);
      return {};
    };

    manager.assign('account-demo', { mode: 'proxy', sourceId: hongKong.id, nodeName: 'Hong Kong' });
    assert.equal(await manager.ensureAccount('account-demo'), runtime);
    manager.assign('account-demo', { mode: 'direct' });
    assert.equal(await manager.ensureAccount('account-demo'), runtime);

    assert.deepEqual(selected, ['Hong Kong', 'DIRECT']);
    assert.equal(runtime.mixedPort, 17898);
    assert.equal(child.killed, false);
    assert.equal(manager.environment('account-demo').HTTP_PROXY, 'http://127.0.0.1:17898');
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('account route endpoint permits live hot switching and rolls back failures', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(server, /leases\[accountId\].*更换代理节点/);
  assert.match(server, /const previousAssignment = networkManager\.publicAssignment\(accountId\)/);
  assert.match(server, /await networkManager\.ensureAccount\(accountId\)/);
  assert.match(server, /networkManager\.assign\(accountId, previousAssignment\)/);
});

test('正在运行的 Codex 代理由后台守护任务按原端口恢复', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /async function recoverActiveCodexNetwork\(\)/);
  assert.match(server, /networkManager\.isAccountRuntimeReady\(account\.id\)/);
  assert.match(server, /networkManager\.ensureAccount\(account\.id\)/);
  assert.match(server, /setInterval\(recoverActiveCodexNetwork, 5_000\)/);
  assert.match(server, /network\.account\.recovered/);
});

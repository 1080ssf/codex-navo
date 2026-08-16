const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {
  applyProxyEnvironment,
  normalizeProxySettings,
  proxyUrl,
  publicProxySettings,
  testProxyConnection,
} = require('../lib/codex-proxy');

test('Codex 启动代理支持 HTTP、HTTPS 和 SOCKS5', () => {
  for (const protocol of ['http', 'https', 'socks5']) {
    const settings = normalizeProxySettings({ enabled: true, protocol, host: '127.0.0.1', port: 7890 });
    assert.equal(settings.protocol, protocol);
    assert.equal(proxyUrl(settings), `${protocol}://127.0.0.1:7890`);
  }
});

test('代理认证写入进程环境但不会返回到界面', () => {
  const settings = normalizeProxySettings({
    enabled: true,
    protocol: 'socks5',
    host: 'proxy.example.com',
    port: 1080,
    username: 'user name',
    password: 'p@ss:word',
  });
  const environment = applyProxyEnvironment({ PATH: 'test' }, settings);
  assert.equal(environment.HTTP_PROXY, 'socks5://user%20name:p%40ss%3Aword@proxy.example.com:1080');
  assert.equal(environment.HTTPS_PROXY, environment.HTTP_PROXY);
  assert.equal(environment.ALL_PROXY, undefined);
  assert.equal(environment.all_proxy, undefined);
  assert.equal(environment.http_proxy, environment.HTTP_PROXY);
  assert.equal(environment.NODE_USE_ENV_PROXY, '1');
  assert.match(environment.NO_PROXY, /127\.0\.0\.1/);
  assert.equal(environment.no_proxy, environment.NO_PROXY);
  const publicValue = publicProxySettings(settings);
  assert.equal(publicValue.hasPassword, true);
  assert.equal(publicValue.displayUrl, 'socks5://proxy.example.com:1080');
  assert.equal('password' in publicValue, false);
});

test('关闭代理时清除继承的代理变量，检测直连不会发起网络请求', async () => {
  const environment = applyProxyEnvironment({
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    HTTP_PROXY: 'http://127.0.0.1:7897',
    ALL_PROXY: 'http://127.0.0.1:7897',
    NODE_USE_ENV_PROXY: '1',
  }, { enabled: false });
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.ALL_PROXY, undefined);
  assert.equal(environment.NODE_USE_ENV_PROXY, undefined);
  const result = await testProxyConnection({ enabled: false });
  assert.deepEqual(result, { ok: true, latencyMs: 0, message: '当前使用直连' });
});

test('代理地址、端口与认证信息会严格校验', () => {
  assert.throws(() => normalizeProxySettings({ enabled: true, protocol: 'http', host: '', port: 7890 }), /主机地址/);
  assert.throws(() => normalizeProxySettings({ enabled: true, protocol: 'http', host: '127.0.0.1', port: 70_000 }), /端口/);
  assert.throws(() => normalizeProxySettings({ enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890, username: 'user' }), /同时填写/);
});

test('SOCKS5 检测保留同一数据包中 CONNECT 响应的剩余字节', async (t) => {
  const server = net.createServer((socket) => {
    let stage = 0;
    socket.on('data', () => {
      if (stage === 0) socket.write(Buffer.from([0x05, 0x02]));
      else if (stage === 1) socket.write(Buffer.from([0x01, 0x00]));
      else if (stage === 2) socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x01, 0xbb]));
      stage += 1;
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const result = await testProxyConnection({
    enabled: true,
    protocol: 'socks5',
    host: '127.0.0.1',
    port: server.address().port,
    username: 'fixture',
    password: 'fixture',
  }, 2_000);
  assert.equal(result.ok, true);
});

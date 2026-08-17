const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { StableProxyRelay } = require('../lib/stable-proxy-relay');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

test('stable proxy relay keeps its front port while the backend target changes', async (t) => {
  const first = net.createServer((socket) => socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('A:'), chunk]))));
  const second = net.createServer((socket) => socket.on('data', (chunk) => socket.write(Buffer.concat([Buffer.from('B:'), chunk]))));
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const relay = new StableProxyRelay({ port: 0 });
  relay.setTargetPort(firstPort);
  await relay.listen();
  const frontPort = relay.server.address().port;
  t.after(() => {
    relay.close();
    first.close();
    second.close();
  });

  const exchange = (text) => new Promise((resolve, reject) => {
    const socket = net.connect(frontPort, '127.0.0.1', () => socket.write(text));
    socket.once('data', (chunk) => { resolve(chunk.toString()); socket.destroy(); });
    socket.once('error', reject);
  });

  assert.equal(await exchange('one'), 'A:one');
  relay.setTargetPort(secondPort);
  assert.equal(relay.server.address().port, frontPort);
  assert.equal(await exchange('two'), 'B:two');
});

const net = require('node:net');
const tls = require('node:tls');

const PROXY_PROTOCOLS = new Set(['http', 'https', 'socks5']);
const SOCKET_READ_BUFFERS = new WeakMap();

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\r\n\0]/g, '').trim().slice(0, maxLength);
}

function normalizeProxySettings(value = {}, previous = {}) {
  const protocol = PROXY_PROTOCOLS.has(String(value.protocol || '').toLowerCase())
    ? String(value.protocol).toLowerCase()
    : 'http';
  const host = cleanText(value.host, 253).replace(/^\[|\]$/g, '');
  const port = Number.parseInt(value.port, 10);
  const username = cleanText(value.username, 160);
  const suppliedPassword = typeof value.password === 'string' ? cleanText(value.password, 512) : '';
  const password = suppliedPassword || (value.keepPassword === true ? cleanText(previous.password, 512) : '');
  const enabled = value.enabled === true;

  if (enabled || host || value.port) {
    if (!host || /[:/\\?#@\s]/.test(host) && !net.isIP(host)) {
      throw new Error('请输入有效的代理主机地址');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('代理端口必须是 1 到 65535 之间的数字');
    }
    if ((username && !password) || (!username && password)) {
      throw new Error('代理认证需要同时填写用户名和密码');
    }
  }

  return { enabled, protocol, host, port: Number.isInteger(port) ? port : 0, username, password };
}

function proxyAuthority(settings, includeCredentials = true) {
  const host = net.isIP(settings.host) === 6 ? `[${settings.host}]` : settings.host;
  const credentials = includeCredentials && settings.username
    ? `${encodeURIComponent(settings.username)}:${encodeURIComponent(settings.password)}@`
    : '';
  return `${credentials}${host}:${settings.port}`;
}

function proxyUrl(settings, includeCredentials = true) {
  return `${settings.protocol}://${proxyAuthority(settings, includeCredentials)}`;
}

function publicProxySettings(settings) {
  return {
    enabled: settings.enabled === true,
    protocol: settings.protocol,
    host: settings.host,
    port: settings.port || '',
    username: settings.username || '',
    hasPassword: Boolean(settings.password),
    displayUrl: settings.host ? proxyUrl(settings, false) : '',
  };
}

function applyProxyEnvironment(environment, settings) {
  const next = { ...environment };
  if (!settings?.enabled) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete next[key];
    delete next.NODE_USE_ENV_PROXY;
    return next;
  }
  const url = proxyUrl(settings);
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    next[key] = url;
  }
  delete next.ALL_PROXY;
  delete next.all_proxy;
  next.NODE_USE_ENV_PROXY = '1';
  next.NO_PROXY = next.NO_PROXY || next.no_proxy || 'localhost,127.0.0.1,::1';
  next.no_proxy = next.NO_PROXY;
  return next;
}

function connectSocket(settings, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = { host: settings.host, port: settings.port };
    const socket = settings.protocol === 'https'
      ? tls.connect({ ...options, servername: net.isIP(settings.host) ? undefined : settings.host })
      : net.connect(options);
    const timer = setTimeout(() => socket.destroy(new Error('连接代理超时')), timeoutMs);
    const readyEvent = settings.protocol === 'https' ? 'secureConnect' : 'connect';
    socket.once(readyEvent, () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function readBytes(socket, count, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = SOCKET_READ_BUFFERS.get(socket) || Buffer.alloc(0);
    SOCKET_READ_BUFFERS.delete(socket);
    let settled = false;
    const timer = setTimeout(() => finish(new Error('代理响应超时')), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= count) {
        const value = buffer.subarray(0, count);
        const rest = buffer.subarray(count);
        if (rest.length) SOCKET_READ_BUFFERS.set(socket, rest);
        finish(null, value);
      }
    };
    socket.on('data', onData);
    socket.once('error', onError);
    if (buffer.length >= count) queueMicrotask(() => onData(Buffer.alloc(0)));
  });
}

function readHeaders(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => finish(new Error('代理响应超时')), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      if (error) reject(error); else resolve(value);
    };
    const onError = (error) => finish(error);
    const onData = (chunk) => {
      text += chunk.toString('latin1');
      if (text.length > 16_384) return finish(new Error('代理返回了异常响应'));
      if (text.includes('\r\n\r\n')) finish(null, text);
    };
    socket.on('data', onData);
    socket.once('error', onError);
  });
}

async function testHttpProxy(settings, timeoutMs) {
  const socket = await connectSocket(settings, timeoutMs);
  try {
    const auth = settings.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${settings.username}:${settings.password}`).toString('base64')}\r\n`
      : '';
    socket.write(`CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\n${auth}Connection: close\r\n\r\n`);
    const headers = await readHeaders(socket, timeoutMs);
    const status = Number(headers.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || 0);
    if (status !== 200) throw new Error(status === 407 ? '代理认证失败' : `代理拒绝连接（HTTP ${status || '未知'}）`);
  } finally {
    socket.destroy();
  }
}

async function testSocks5Proxy(settings, timeoutMs) {
  const socket = await connectSocket(settings, timeoutMs);
  try {
    socket.write(Buffer.from([0x05, settings.username ? 0x02 : 0x01, settings.username ? 0x02 : 0x00]));
    const greeting = await readBytes(socket, 2, timeoutMs);
    if (greeting[0] !== 0x05 || greeting[1] === 0xff) throw new Error('SOCKS5 代理不接受当前认证方式');
    if (greeting[1] === 0x02) {
      const user = Buffer.from(settings.username, 'utf8');
      const pass = Buffer.from(settings.password, 'utf8');
      if (!user.length || !pass.length || user.length > 255 || pass.length > 255) throw new Error('SOCKS5 认证信息无效');
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await readBytes(socket, 2, timeoutMs);
      if (auth[1] !== 0x00) throw new Error('代理认证失败');
    } else if (greeting[1] !== 0x00) {
      throw new Error('SOCKS5 代理返回了未知认证方式');
    }
    const target = Buffer.from('chatgpt.com', 'ascii');
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, target.length]), target, Buffer.from([0x01, 0xbb])]));
    const reply = await readBytes(socket, 4, timeoutMs);
    if (reply[0] !== 0x05 || reply[1] !== 0x00) throw new Error(`SOCKS5 代理拒绝连接（代码 ${reply[1]}）`);
    const addressLength = reply[3] === 0x01 ? 4 : reply[3] === 0x04 ? 16 : (await readBytes(socket, 1, timeoutMs))[0];
    await readBytes(socket, addressLength + 2, timeoutMs);
  } finally {
    socket.destroy();
  }
}

async function testProxyConnection(settings, timeoutMs = 8_000) {
  const startedAt = Date.now();
  if (!settings.enabled) return { ok: true, latencyMs: 0, message: '当前使用直连' };
  if (settings.protocol === 'socks5') await testSocks5Proxy(settings, timeoutMs);
  else await testHttpProxy(settings, timeoutMs);
  return { ok: true, latencyMs: Date.now() - startedAt, message: '代理已连接到 ChatGPT' };
}

module.exports = {
  applyProxyEnvironment,
  normalizeProxySettings,
  proxyUrl,
  publicProxySettings,
  testProxyConnection,
};

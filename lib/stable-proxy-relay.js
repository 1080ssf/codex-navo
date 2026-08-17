const net = require('node:net');

const MAX_HEADER_BYTES = 64 * 1024;

function parseAuthority(value, defaultPort) {
  const source = String(value || '').trim();
  if (!source) throw new Error('Proxy target is empty');
  const bracketed = source.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2] || defaultPort) };
  const separator = source.lastIndexOf(':');
  if (separator > 0 && /^\d+$/.test(source.slice(separator + 1))) {
    return { host: source.slice(0, separator), port: Number(source.slice(separator + 1)) };
  }
  return { host: source, port: Number(defaultPort) };
}

function connectPipes(client, host, port, initialData, onConnect) {
  const upstream = net.connect({ host, port });
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.once('error', close);
  upstream.once('error', close);
  upstream.once('connect', () => {
    onConnect?.();
    if (initialData?.length) upstream.write(initialData);
    client.pipe(upstream);
    upstream.pipe(client);
  });
}

class StableProxyRelay {
  constructor({ host = '127.0.0.1', port }) {
    this.host = host;
    this.port = Number(port);
    this.targetPort = 0;
    this.server = null;
    this.startPromise = null;
  }

  setTargetPort(port) {
    const value = Number(port);
    this.targetPort = Number.isInteger(value) && value > 0 && value <= 65_535 ? value : 0;
  }

  async listen() {
    if (this.server?.listening) return this;
    if (this.startPromise) return this.startPromise;
    this.server = net.createServer((client) => this.handle(client));
    this.startPromise = new Promise((resolve, reject) => {
      const failed = (error) => {
        this.startPromise = null;
        reject(error);
      };
      this.server.once('error', failed);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', failed);
        this.server.on('error', () => {});
        this.server.unref();
        resolve(this);
      });
    });
    return this.startPromise;
  }

  handle(client) {
    const targetPort = this.targetPort;
    if (targetPort) {
      connectPipes(client, '127.0.0.1', targetPort);
      return;
    }
    let buffered = Buffer.alloc(0);
    const receive = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HEADER_BYTES) {
        client.destroy();
        return;
      }
      const headerEnd = buffered.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      client.removeListener('data', receive);
      const head = buffered.subarray(0, headerEnd + 4).toString('latin1');
      const remaining = buffered.subarray(headerEnd + 4);
      const [requestLine, ...headerLines] = head.split('\r\n');
      const match = requestLine.match(/^(\S+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/i);
      if (!match) {
        client.destroy();
        return;
      }
      const [, method, requestTarget, version] = match;
      try {
        if (method.toUpperCase() === 'CONNECT') {
          const { host, port } = parseAuthority(requestTarget, 443);
          connectPipes(client, host, port, remaining, () => client.write(`${version} 200 Connection Established\r\n\r\n`));
          return;
        }
        const url = new URL(requestTarget);
        if (url.protocol !== 'http:') throw new Error('Only HTTP absolute-form requests are supported');
        const rewrittenHeaders = headerLines.filter((line) => !/^proxy-connection\s*:/i.test(line));
        const rewritten = Buffer.from(`${method} ${url.pathname}${url.search} ${version}\r\n${rewrittenHeaders.join('\r\n')}\r\n`, 'latin1');
        connectPipes(client, url.hostname, Number(url.port || 80), Buffer.concat([rewritten, remaining]));
      } catch {
        client.destroy();
      }
    };
    client.on('data', receive);
  }

  close() {
    if (!this.server) return;
    try { this.server.close(); } catch {}
    this.server = null;
    this.startPromise = null;
  }
}

module.exports = { StableProxyRelay };

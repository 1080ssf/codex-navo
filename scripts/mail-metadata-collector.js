const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 3;
const MAX_METADATA_RECORDS = 100;
const SENSITIVE_KEY = /(auth|authorization|cookie|password|passwd|secret|token|otp|code|验证码|校验码|credential|session|csrf|nonce|challenge|reset|body|content|text|html|subject|snippet|preview|payload)/i;
const ID_KEY = /(^|_)(id|uid|uuid|message_?id|mail_?id|email_?id)$/i;
const TIME_KEY = /(created|received|sent|updated|timestamp|date|time)/i;
const STATUS_KEY = /^(status|state|read|unread|folder)$/i;

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('base64url').slice(0, 16);
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || parts[0] === 0;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc')
      || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('::ffff:127.');
  }
  return true;
}

async function validatePublicUrl(value, options = {}) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('接口仅支持 HTTP(S)');
  if (url.username || url.password) throw new Error('接口地址不能包含 URL 用户名或密码');
  const lookup = options.lookup || dns.lookup;
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('公网采集器不允许访问回环、私网或链路本地地址');
  }
  return url;
}

function redactUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const pathname = url.pathname
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
      .replace(/[A-Za-z0-9_-]{18,}/g, '<redacted>');
    return `${url.origin}${pathname}${url.search ? '?<redacted>' : ''}`;
  } catch {
    return '<redacted-endpoint>';
  }
}

async function readLimitedResponse(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('接口响应超过 2 MB 限制');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('接口响应超过 2 MB 限制');
    return buffer;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('接口响应超过 2 MB 限制');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function collectJsonMetadata(value) {
  const fieldNames = new Set();
  const records = [];
  let objectCount = 0;
  let arrayItemCount = 0;

  function visit(current) {
    if (records.length >= MAX_METADATA_RECORDS || current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      arrayItemCount += current.length;
      current.forEach(visit);
      return;
    }
    objectCount += 1;
    const metadata = {};
    for (const [key, child] of Object.entries(current)) {
      if (SENSITIVE_KEY.test(key)) continue;
      fieldNames.add(key);
      if (child !== null && typeof child === 'object') {
        visit(child);
        continue;
      }
      if (ID_KEY.test(key) && child !== '') metadata.identityFingerprint = fingerprint(child);
      else if (TIME_KEY.test(key)) metadata.time = String(child).slice(0, 80);
      else if (STATUS_KEY.test(key)) metadata.status = String(child).slice(0, 40);
    }
    if (Object.keys(metadata).length) records.push(metadata);
  }

  visit(value);
  return {
    objectCount,
    arrayItemCount,
    fieldNames: [...fieldNames].sort().slice(0, 100),
    records,
  };
}

function summarizeResponse(body, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('json') || /^[\s\r\n]*[\[{]/.test(body.toString('utf8'))) {
    try {
      return { format: 'json', ...collectJsonMetadata(JSON.parse(body.toString('utf8'))) };
    } catch {}
  }
  if (type.includes('html') || /<html\b|<!doctype\s+html/i.test(body.toString('utf8'))) {
    return { format: 'html', objectCount: 0, arrayItemCount: 0, fieldNames: [], records: [] };
  }
  return { format: 'text', objectCount: 0, arrayItemCount: 0, fieldNames: [], records: [] };
}

async function fetchPublicMetadata(endpoint, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const lookup = options.lookup || dns.lookup;
  let current = await validatePublicUrl(endpoint, { lookup });
  const originalOrigin = current.origin;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || HTTP_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'application/json, text/html, text/plain, */*' },
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('接口请求超时');
      throw new Error('接口请求失败');
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('接口返回无效重定向');
      const next = await validatePublicUrl(new URL(location, current), { lookup });
      if (next.origin !== originalOrigin) throw new Error('采集器不跟随跨源重定向');
      current = next;
      continue;
    }
    if (!response.ok) throw new Error(`接口请求失败（HTTP ${response.status}）`);
    const body = await readLimitedResponse(response, options.maxBytes || MAX_RESPONSE_BYTES);
    return {
      endpoint: redactUrl(current),
      httpStatus: response.status,
      contentType: response.headers.get('content-type') || '',
      responseBytes: body.length,
      ...summarizeResponse(body, response.headers.get('content-type') || ''),
    };
  }
  throw new Error('接口重定向次数过多');
}

async function promptForEndpoint() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try { return String(await terminal.question('请输入公网邮件元数据接口地址：')).trim(); }
  finally { terminal.close(); }
}

if (require.main === module) {
  const argumentIndex = process.argv.indexOf('--endpoint');
  const endpointPromise = argumentIndex >= 0 ? Promise.resolve(process.argv[argumentIndex + 1] || '') : promptForEndpoint();
  endpointPromise
    .then((endpoint) => fetchPublicMetadata(endpoint))
    .then((metadata) => process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`采集失败：${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  collectJsonMetadata,
  fetchPublicMetadata,
  isPrivateAddress,
  redactUrl,
  summarizeResponse,
  validatePublicUrl,
};

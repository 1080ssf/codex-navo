const crypto = require('node:crypto');
const { validatePublicUrl } = require('../scripts/mail-metadata-collector');

function configuredDuration(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const DEFAULT_INTERVAL_MS = configuredDuration('MAIL_POLL_INTERVAL_MS', 2_500);
const DEFAULT_WAIT_MS = configuredDuration('MAIL_POLL_TIMEOUT_MS', 10 * 60 * 1000);
const DEFAULT_HTTP_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HIGH_CONFIDENCE_SCORE = 12;

function hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('base64url').slice(0, 24);
}

function assertLoopbackUrl(value, expectedOrigin = '') {
  let url;
  try { url = new URL(String(value || '')); }
  catch { throw new Error('邮箱验证码接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('邮箱验证码接口仅支持 HTTP(S)');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error('邮箱验证码自动读取仅允许本机 Mock 接口');
  }
  if (expectedOrigin && url.origin !== expectedOrigin) throw new Error('邮件数据接口必须与查询页面同源');
  return url;
}

function isLoopbackUrl(value) {
  const url = value instanceof URL ? value : new URL(String(value || ''));
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
}

function isPrivateIpv4(hostname) {
  const parts = String(hostname || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

function assertMailboxEndpointUrl(value, expectedOrigin = '') {
  let url;
  try { url = value instanceof URL ? value : new URL(String(value || '')); }
  catch { throw new Error('邮箱验证码接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('邮箱验证码接口仅支持 HTTP(S)');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!isLoopbackUrl(url)) {
    if (url.protocol !== 'https:') throw new Error('公网邮箱验证码接口必须使用 HTTPS');
    if (hostname === '0.0.0.0' || hostname.endsWith('.local') || hostname.endsWith('.internal') || isPrivateIpv4(hostname)) {
      throw new Error('公网邮箱验证码接口地址无效');
    }
  }
  if (expectedOrigin && url.origin !== expectedOrigin) throw new Error('邮件数据接口必须与查询页面同源');
  return url;
}

function resolveMailboxContentUrl(value) {
  const url = assertMailboxEndpointUrl(value);
  const email = url.searchParams.get('email') || url.searchParams.get('mail') || '';
  const rawKey = url.searchParams.get('auth_code') || url.searchParams.get('code') || url.searchParams.get('key') || '';
  const key = String(rawKey).split('----', 1)[0].trim();
  if (!email || !key) return url;
  const apiUrl = new URL(`/mail-api/${encodeURIComponent(key)}/${encodeURIComponent(email)}`, url.origin);
  apiUrl.searchParams.set('folder', 'inbox');
  return assertMailboxEndpointUrl(apiUrl, url.origin);
}

function redactEndpoint(value) {
  try {
    const url = new URL(String(value || ''));
    const safePath = url.pathname
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
      .replace(/[A-Za-z0-9_-]{18,}/g, '<redacted>');
    return `${url.origin}${safePath}${url.search ? '?<redacted>' : ''}`;
  } catch {
    return '<redacted-endpoint>';
  }
}

function htmlToText(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function flatten(value, path = '', records = [], seen = new Set()) {
  if (value === null || value === undefined) return records;
  if (typeof value === 'object') {
    if (seen.has(value)) return records;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      flatten(child, path ? `${path}.${key}` : key, records, seen);
    }
    return records;
  }
  records.push({ path, value: String(value) });
  return records;
}

function decodedBase64Records(records) {
  const decoded = [];
  for (const record of records) {
    const compact = record.value.replace(/\s+/g, '');
    if (compact.length < 16 || compact.length > 200_000 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) continue;
    try {
      const value = Buffer.from(compact, 'base64').toString('utf8');
      if (!value || value.includes('\uFFFD')) continue;
      const printable = [...value].filter((character) => /[\t\n\r\x20-\x7E\u4E00-\u9FFF]/.test(character)).length;
      if (printable / value.length < 0.85) continue;
      decoded.push({ path: `${record.path}.base64`, value });
    } catch {}
  }
  return decoded;
}

function codeMatches(value) {
  const matches = [];
  const pattern = /(^|\D)(\d{6})(?!\d)/g;
  let match;
  while ((match = pattern.exec(String(value || ''))) !== null) matches.push(match[2]);
  return matches;
}

function contextScore(path, value) {
  const field = String(path || '').toLowerCase();
  const text = String(value || '').toLowerCase();
  let score = 0;
  if (/(^|\.)(otp|code|verification_code|verify_code|验证码|驗證碼)$/.test(field)) score += 40;
  else if (/(otp|verification|verify|验证码|驗證碼|security.?code)/.test(field)) score += 40;
  if (/(openai|chatgpt|验证码|驗證碼|verification|security code|one[- ]?time|otp|登录代码|登入代碼)/i.test(text)) score += 40;
  if (/(^|\.)(body|content|text|html|message|subject|snippet|preview|payload|data|mail)(\.|$)/.test(field)) score += 12;
  if (/^\s*\d{6}\s*$/.test(text)) score += 30;
  if (text.length <= 500) score += 4;
  return score;
}

function findMetadata(records, pattern) {
  return records.find((record) => pattern.test(record.path.toLowerCase()))?.value || '';
}

function extractMailboxOtpCandidates(raw, options = {}) {
  let parsed = raw;
  const contentType = String(options.contentType || '').toLowerCase();
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString('utf8');
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (contentType.includes('json') || /^[\[{]/.test(trimmed)) {
      try { parsed = JSON.parse(trimmed); } catch { parsed = contentType.includes('html') ? htmlToText(trimmed) : trimmed; }
    } else if (contentType.includes('html') || /<html\b|<!doctype\s+html/i.test(trimmed)) {
      parsed = htmlToText(trimmed);
    }
  }

  const baseRecords = flatten(parsed);
  const records = [...baseRecords, ...decodedBase64Records(baseRecords)];
  const messageId = findMetadata(records, /(^|\.)(message_?id|mail_?id|email_?id|uid|uuid|id)$/);
  const receivedAt = findMetadata(records, /(^|\.)(received_?at|received_?time|received|timestamp|created_?at|created|sent_?at|sent|updated_?at|updated|date|time)$/);
  const candidates = [];
  for (const record of records) {
    for (const code of codeMatches(record.value)) {
      const score = contextScore(record.path, record.value);
      const identitySource = messageId
        ? `message:${messageId}:${receivedAt}`
        : receivedAt ? `time:${receivedAt}` : `context:${record.path}:${record.value}`;
      candidates.push({
        code,
        score,
        stableKey: hash(`${identitySource}:${code}`),
        sourcePath: record.path,
        receivedAt,
      });
    }
  }
  return candidates.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return (Date.parse(right.receivedAt) || 0) - (Date.parse(left.receivedAt) || 0);
  });
}

function findSameOriginDataUrl(html, baseUrl) {
  const source = String(html || '');
  const patterns = [
    /<meta\b[^>]*\bname=["']mail-data-url["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["']mail-data-url["']/i,
    /\bdata-mail-(?:api|url)=["']([^"']+)["']/i,
    /<link\b[^>]*\brel=["']mail-data["'][^>]*\bhref=["']([^"']+)["']/i,
  ];
  for (const pattern of patterns) {
    const candidate = source.match(pattern)?.[1];
    if (!candidate) continue;
    const resolved = new URL(candidate, baseUrl);
    assertMailboxEndpointUrl(resolved, new URL(baseUrl).origin);
    return resolved.href;
  }
  return '';
}

async function readLimitedResponse(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('邮箱验证码接口响应过大');
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('邮箱验证码接口响应过大');
    return buffer.toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error('邮箱验证码接口响应过大');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchOnce(url, options) {
  const endpoint = assertMailboxEndpointUrl(url);
  if (!isLoopbackUrl(endpoint)) await validatePublicUrl(endpoint, { lookup: options.lookup });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.httpTimeoutMs);
  try {
    const response = await options.fetchImpl(endpoint, {
      redirect: 'manual',
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        Accept: 'application/json, text/html, text/plain, */*',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'User-Agent': 'Codex-Navo-Mail-Poller/1.0',
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('邮箱验证码接口返回了无效重定向');
      const redirected = new URL(location, endpoint);
      assertMailboxEndpointUrl(redirected, endpoint.origin);
      return { redirect: redirected.href };
    }
    if (!response.ok) throw new Error(`邮箱验证码接口请求失败（HTTP ${response.status}）`);
    const body = await readLimitedResponse(response, options.maxResponseBytes);
    return { body, contentType: response.headers.get('content-type') || '' };
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('邮箱验证码接口请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMailboxOtpCandidates(endpoint, options = {}) {
  const initial = resolveMailboxContentUrl(endpoint);
  const requestOptions = {
    fetchImpl: options.fetchImpl || globalThis.fetch,
    lookup: options.lookup,
    httpTimeoutMs: options.httpTimeoutMs || DEFAULT_HTTP_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES,
  };
  if (typeof requestOptions.fetchImpl !== 'function') throw new Error('当前运行环境没有可用的 HTTP 客户端');
  let current = initial.href;
  let result;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    result = await fetchOnce(current, requestOptions);
    if (!result.redirect) break;
    current = result.redirect;
  }
  if (!result || result.redirect) throw new Error('邮箱验证码接口重定向次数过多');

  if (/text\/html/i.test(result.contentType) || /<html\b|<!doctype\s+html/i.test(result.body)) {
    const dataUrl = findSameOriginDataUrl(result.body, current);
    if (dataUrl) {
      const followed = await fetchOnce(dataUrl, requestOptions);
      if (followed.redirect) throw new Error('邮件数据接口不能再次重定向');
      return extractMailboxOtpCandidates(followed.body, { contentType: followed.contentType });
    }
  }
  return extractMailboxOtpCandidates(result.body, { contentType: result.contentType });
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('验证码轮询已取消'), { name: 'AbortError' }));
    }, { once: true });
  });
}

class MailOtpSession {
  constructor(endpoint, options = {}) {
    this.endpoint = assertMailboxEndpointUrl(endpoint).href;
    this.isPublicEndpoint = !isLoopbackUrl(this.endpoint);
    this.fetchCandidates = options.fetchCandidates || ((url) => fetchMailboxOtpCandidates(url, options));
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.waitMs = options.waitMs || DEFAULT_WAIT_MS;
    this.highConfidenceScore = options.highConfidenceScore || HIGH_CONFIDENCE_SCORE;
    this.baselineKeys = new Set();
    this.sightings = new Map();
    this.baselineReady = false;
  }

  async captureBaseline() {
    const candidates = await this.fetchCandidates(this.endpoint);
    this.baselineKeys = new Set(candidates.map((candidate) => candidate.stableKey));
    this.baselineReady = true;
    return { candidateCount: candidates.length };
  }

  evaluateCandidates(candidates) {
    for (const candidate of candidates) {
      if (this.baselineKeys.has(candidate.stableKey)) continue;
      const count = (this.sightings.get(candidate.stableKey) || 0) + 1;
      this.sightings.set(candidate.stableKey, count);
      if (candidate.score < this.highConfidenceScore && count < 2) continue;
      return candidate;
    }
    return null;
  }

  async checkOnce(options = {}) {
    if (!this.baselineReady) throw new Error('必须先成功建立验证码基线');
    const candidates = await this.fetchCandidates(this.endpoint);
    const candidate = this.evaluateCandidates(candidates);
    if (!candidate) return { status: 'waiting', candidateCount: candidates.length };
    await options.submitCode?.(candidate.code);
    return { status: 'detected', stableKey: candidate.stableKey, score: candidate.score };
  }

  async waitForCode(options = {}) {
    if (!this.baselineReady) throw new Error('必须先成功建立验证码基线');
    if (options.state !== 'waiting-for-email-otp') throw new Error('登录流程尚未进入等待邮箱验证码状态');
    const deadline = Date.now() + this.waitMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) return { status: 'cancelled' };
      attempt += 1;
      let candidates;
      try {
        candidates = await this.fetchCandidates(this.endpoint);
      } catch (error) {
        options.onError?.(`邮箱验证码读取失败：${redactEndpoint(this.endpoint)}`);
        await sleep(Math.min(this.intervalMs, Math.max(0, deadline - Date.now())), options.signal).catch(() => {});
        continue;
      }
      options.onPoll?.({ attempt, candidateCount: candidates.length });
      const candidate = this.evaluateCandidates(candidates);
      if (candidate) {
        await options.submitCode(candidate.code);
        return { status: 'submitted', stableKey: candidate.stableKey, score: candidate.score };
      }
      await sleep(Math.min(this.intervalMs, Math.max(0, deadline - Date.now())), options.signal).catch(() => {});
    }
    options.onTimeout?.('自动读取验证码超时，已保留人工输入流程');
    return { status: 'timeout' };
  }
}

module.exports = {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_WAIT_MS,
  HIGH_CONFIDENCE_SCORE,
  MailOtpSession,
  assertMailboxEndpointUrl,
  assertLoopbackUrl,
  extractMailboxOtpCandidates,
  fetchMailboxOtpCandidates,
  findSameOriginDataUrl,
  isLoopbackUrl,
  redactEndpoint,
  resolveMailboxContentUrl,
};

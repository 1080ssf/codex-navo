const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');
const { spawn, spawnSync } = require('node:child_process');

const CORE_VERSION = 'v1.19.29';
const CORE_ARCHIVE_URL = `https://github.com/MetaCubeX/mihomo/releases/download/${CORE_VERSION}/mihomo-windows-amd64-compatible-${CORE_VERSION}.zip`;
const CORE_ARCHIVE_SHA256 = '322aaa5957ba9e72afdda9b71cc4329f691d2d45ec39e70bbca3f7bf5aa93d52';
const CORE_EXECUTABLE_SHA256 = '82cd796a23492f43a71c1ec27e4e5e0b3d58932014da5a36e79ed9b11fee8162';
const PROXY_PORT_START = 18301;
const PROXY_PORT_END = 18399;
const URI_PROTOCOLS = new Set([
  'http', 'https', 'socks', 'socks5', 'ss', 'ssr', 'vmess', 'vless', 'trojan',
  'hysteria', 'hysteria2', 'hy2', 'tuic', 'wireguard',
]);
// OpenAI's supported-country list is an allowlist. These are the common
// unsupported exit regions that can be identified reliably from proxy names.
// Unknown labels still receive a real ChatGPT reachability check.
const UNSUPPORTED_REGION_RULES = Object.freeze([
  { label: '中国香港', flags: ['🇭🇰'], aliases: ['中国香港', '香港', 'hong kong', 'hongkong', 'hk'] },
  { label: '中国澳门', flags: ['🇲🇴'], aliases: ['中国澳门', '澳门', 'macao', 'macau', 'mo'] },
  { label: '中国大陆', flags: ['🇨🇳'], aliases: ['中国大陆', '中国', '大陆', 'mainland china', 'china', 'cn'] },
  { label: '俄罗斯', flags: ['🇷🇺'], aliases: ['俄罗斯', '俄国', '莫斯科', 'russia', 'moscow', 'ru'] },
  { label: '白俄罗斯', flags: ['🇧🇾'], aliases: ['白俄罗斯', '白俄', 'belarus', 'by'] },
  { label: '古巴', flags: ['🇨🇺'], aliases: ['古巴', 'cuba', 'cu'] },
  { label: '伊朗', flags: ['🇮🇷'], aliases: ['伊朗', 'iran', 'ir'] },
  { label: '朝鲜', flags: ['🇰🇵'], aliases: ['朝鲜', '北韩', 'north korea', 'dprk', 'kp'] },
  { label: '叙利亚', flags: ['🇸🇾'], aliases: ['叙利亚', 'syria', 'sy'] },
  { label: '委内瑞拉', flags: ['🇻🇪'], aliases: ['委内瑞拉', 'venezuela', 've'] },
]);

function unsupportedRegionFromNodeName(nodeName) {
  const raw = cleanText(nodeName, 200);
  const source = raw.toLowerCase();
  const tokens = raw.split(/[^a-z0-9\u3400-\u9fff]+/iu).filter(Boolean);
  for (const rule of UNSUPPORTED_REGION_RULES) {
    if (rule.flags.some((flag) => source.includes(flag))) return rule.label;
    if (rule.aliases.some((alias) => alias.length <= 2 ? tokens.includes(alias.toUpperCase()) : source.includes(alias))) return rule.label;
  }
  return '';
}

function unsupportedRegionResult(region) {
  return {
    ok: false,
    status: 'unsupported-region',
    httpStatus: 0,
    latencyMs: null,
    delay: null,
    message: `${region} 不在 OpenAI 官方支持地区列表中，默认标记为 ChatGPT 不支持`,
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function cleanText(value, maxLength = 300) {
  return String(value || '').replace(/[\r\n\0]/g, ' ').trim().slice(0, maxLength);
}

function safeDecode(value) {
  try { return decodeURIComponent(String(value || '').replace(/\+/g, '%20')); }
  catch { return String(value || ''); }
}

function decodeBase64(value) {
  const source = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!source || !/^[a-z0-9+/=]+$/i.test(source)) return '';
  try { return Buffer.from(source.padEnd(Math.ceil(source.length / 4) * 4, '='), 'base64').toString('utf8'); }
  catch { return ''; }
}

function protocolLabel(protocol) {
  const normalized = String(protocol || '').toLowerCase();
  const labels = { hy2: 'HYSTERIA2', socks: 'SOCKS5' };
  return labels[normalized] || normalized.toUpperCase();
}

function nodeNameFromUri(uri, protocol, index) {
  const hash = safeDecode(String(uri).split('#').slice(1).join('#')).trim();
  if (hash) return hash.slice(0, 100);
  if (protocol === 'vmess') {
    const encoded = String(uri).slice(String(uri).indexOf('://') + 3).split('#')[0];
    try {
      const parsed = JSON.parse(decodeBase64(encoded));
      if (parsed.ps) return cleanText(parsed.ps, 100);
      if (parsed.add) return `${parsed.add}:${parsed.port || ''}`.replace(/:$/, '');
    } catch {}
  }
  if (protocol === 'ssr') {
    const decoded = decodeBase64(String(uri).slice(6));
    const remarks = decoded.match(/[?&]remarks=([^&]+)/)?.[1];
    const name = safeDecode(decodeBase64(remarks));
    if (name) return cleanText(name, 100);
  }
  try {
    const parsed = new URL(uri);
    if (parsed.hostname) return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {}
  return `${protocolLabel(protocol)} 节点 ${index + 1}`;
}

function looksLikeSubscriptionUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const directProxy = parsed.port && (!parsed.pathname || parsed.pathname === '/') && !parsed.search;
    return !directProxy;
  } catch { return false; }
}

function normalizeInput(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|proxies\s*:|proxy-providers\s*:)/im.test(trimmed)) return trimmed;
  const decoded = decodeBase64(trimmed.replace(/\s+/g, ''));
  return /(?:ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic|wireguard|socks5?|https?):\/\//i.test(decoded)
    ? decoded.trim()
    : trimmed;
}

function proxyUrisFromText(value) {
  const matches = [];
  for (const rawLine of String(value || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(?:https?|socks5?|ssr?|vmess|vless|trojan|hysteria2?|hy2|tuic|wireguard):\/\//i.test(line)) {
      matches.push(line);
      continue;
    }
    matches.push(...(line.match(/(?:https?|socks5?|ssr?|vmess|vless|trojan|hysteria2?|hy2|tuic|wireguard):\/\/[^\s<>"']+/gi) || []));
  }
  return matches
    .map((item) => item.replace(/[\]})>,;，；。]+$/g, ''))
    .filter((item) => URI_PROTOCOLS.has(item.match(/^([^:]+):/i)?.[1]?.toLowerCase()));
}

function proxyUriFromFields(value) {
  const fields = {};
  for (const line of String(value || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(proxy\s+type|type|protocol|host|server|port|username|user|password|pass)\s*[:：]\s*(.*?)\s*$/i);
    if (match) fields[match[1].toLowerCase().replace(/\s+/g, '')] = match[2];
  }
  const protocol = String(fields.proxytype || fields.type || fields.protocol || '').toLowerCase();
  const normalizedProtocol = protocol === 'socks' ? 'socks5' : protocol;
  const host = cleanText(fields.host || fields.server, 255);
  const port = Number(fields.port);
  if (!URI_PROTOCOLS.has(normalizedProtocol) || !host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
  const username = fields.username ?? fields.user ?? '';
  const password = fields.password ?? fields.pass ?? '';
  const credentials = username || password
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    : '';
  return `${normalizedProtocol}://${credentials}${host}:${port}`;
}

function parseProxyInput(input, requestedName = '') {
  const normalized = normalizeInput(input);
  if (!normalized) throw new Error('请粘贴代理节点、订阅地址或 Clash 配置');
  if (/^https?:\/\/\S+$/i.test(normalized) && looksLikeSubscriptionUrl(normalized)) {
    const parsed = new URL(normalized);
    return {
      kind: 'subscription',
      name: cleanText(requestedName, 60) || parsed.hostname,
      url: normalized,
      format: 'subscription',
      nodes: [],
    };
  }
  if (/^(?:proxies|proxy-providers)\s*:/im.test(normalized)) {
    return {
      kind: 'local',
      name: cleanText(requestedName, 60) || 'Clash 配置',
      content: normalized,
      format: 'yaml',
      nodes: [],
    };
  }
  let uriLines = proxyUrisFromText(normalized);
  if (!uriLines.length) {
    const fieldUri = proxyUriFromFields(normalized);
    if (fieldUri) uriLines = [fieldUri];
  }
  const nodes = [];
  for (const line of uriLines) {
    const protocol = line.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
    if (!protocol || !URI_PROTOCOLS.has(protocol)) continue;
    nodes.push({
      name: nodeNameFromUri(line, protocol, nodes.length),
      protocol: protocolLabel(protocol),
      uri: line,
    });
  }
  if (!nodes.length) throw new Error('没有识别到受支持的代理格式');
  return {
    kind: 'local',
    name: cleanText(requestedName, 60) || (nodes.length === 1 ? nodes[0].name : `节点组 ${nodes.length}`),
    content: nodes.map((node) => node.uri).join('\n'),
    format: 'uri-list',
    nodes,
  };
}

function redactedLocation(source) {
  if (source.kind !== 'subscription') return source.format === 'yaml' ? '本地 Clash 配置' : `${source.nodes?.length || 0} 个本地节点`;
  try {
    const parsed = new URL(source.url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch { return '远程订阅'; }
}

function publicSource(source) {
  const nodes = (source.nodes || []).map((node) => ({
    name: node.name,
    protocol: node.protocol || node.type || 'PROXY',
    connectDelay: node.connectDelay == null || !Number.isFinite(Number(node.connectDelay)) ? null : Number(node.connectDelay),
    delay: node.delay == null || !Number.isFinite(Number(node.delay)) ? null : Number(node.delay),
    status: node.status || '',
    checkedAt: node.checkedAt || null,
  }));
  const measuredDelay = (node) => node.connectDelay ?? node.delay;
  const statusRank = (node) => {
    if (node.status === 'available' && measuredDelay(node) != null) return 0;
    if (node.status === 'unsupported-region' && measuredDelay(node) != null) return 1;
    if (measuredDelay(node) != null) return 2;
    if (!node.status) return 3;
    return 4;
  };
  nodes.sort((left, right) => {
    const rank = statusRank(left) - statusRank(right);
    if (rank) return rank;
    const delay = (measuredDelay(left) ?? Number.POSITIVE_INFINITY) - (measuredDelay(right) ?? Number.POSITIVE_INFINITY);
    if (delay) return delay;
    return String(left.name).localeCompare(String(right.name), 'zh-CN');
  });
  return {
    id: source.id,
    kind: source.kind,
    name: source.name,
    format: source.format,
    location: redactedLocation(source),
    updatedAt: source.updatedAt || null,
    error: source.error || '',
    nodes,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function freeProxyPort(preferredPort) {
  const preferred = Number(preferredPort);
  if (Number.isInteger(preferred) && preferred >= PROXY_PORT_START && preferred <= PROXY_PORT_END
    && await canListen(preferred)) return preferred;
  for (let port = PROXY_PORT_START; port <= PROXY_PORT_END; port += 1) {
    if (port !== preferred && await canListen(port)) return port;
  }
  throw new Error(`代理端口池 ${PROXY_PORT_START}-${PROXY_PORT_END} 已全部占用`);
}

function providerName(sourceId) {
  return `source-${String(sourceId).replace(/[^a-z0-9-]/gi, '')}`;
}

function processAlive(child) {
  return child && child.exitCode == null && !child.killed;
}

function selectTaskRoute(data, preferredAccountId = '') {
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const assignments = data?.assignments && typeof data.assignments === 'object' ? data.assignments : {};
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const resolveAssignment = (accountId) => {
    const assignment = assignments[accountId];
    if (!assignment || assignment.mode !== 'proxy') return null;
    const source = sourceById.get(assignment.sourceId);
    const node = (source?.nodes || []).find((item) => item.name === assignment.nodeName);
    const measuredDelay = Number(node?.connectDelay ?? node?.delay);
    if (!source || !node || !['available', 'cloudflare-protected', 'challenge-required'].includes(node.status) || !Number.isFinite(measuredDelay)) return null;
    return { accountId, sourceId: source.id, nodeName: node.name, delay: measuredDelay };
  };

  const preferred = preferredAccountId ? resolveAssignment(preferredAccountId) : null;
  if (preferred) return preferred;

  return sources
    .flatMap((source) => (source.nodes || [])
      .filter((node) => ['available', 'cloudflare-protected', 'challenge-required'].includes(node.status)
        && Number.isFinite(Number(node.connectDelay ?? node.delay)))
      .map((node) => ({ accountId: '', sourceId: source.id, nodeName: node.name, delay: Number(node.connectDelay ?? node.delay) })))
    .sort((left, right) => left.delay - right.delay || left.nodeName.localeCompare(right.nodeName, 'zh-CN'))[0] || null;
}

function classifyChatGptResponse(text, latencyMs) {
  const httpStatus = Number(String(text || '').match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || 0);
  const unsupported = /unsupported[_ -]?country|not available in your country|country[^<]{0,40}not supported|所在地区.{0,20}(?:不支持|不可用)/i.test(text);
  const challenge = httpStatus === 403
    && /(?:^|\r\n)cf-mitigated:\s*challenge(?:\r\n|$)|challenge-platform|cf-chl-|just a moment|verify you are human/i.test(text);
  if (unsupported) return {
    ok: false, status: 'unsupported-region', httpStatus, latencyMs,
    message: '节点可以连接 ChatGPT，但所在国家或地区不受支持',
  };
  if ((httpStatus >= 200 && httpStatus < 400) || httpStatus === 401) return {
    ok: true, status: 'available', httpStatus, latencyMs, message: 'ChatGPT 可正常访问',
  };
  if (challenge) return {
    ok: true, status: 'cloudflare-protected', httpStatus, latencyMs,
    message: '节点可以连接 ChatGPT；检测请求受到 Cloudflare 保护，不要求在 Navo 中单独验证',
  };
  if (httpStatus === 429) return {
    ok: false, status: 'rate-limited', httpStatus, latencyMs,
    message: '节点可以连接 ChatGPT，但当前请求受到速率限制',
  };
  return {
    ok: false,
    status: httpStatus === 403 ? 'blocked' : 'http-error',
    httpStatus,
    latencyMs,
    message: httpStatus === 403 ? 'ChatGPT 拒绝了该节点的访问' : `ChatGPT 返回 HTTP ${httpStatus || '未知'}`,
  };
}

function responseMetadata(text) {
  const source = String(text || '');
  const splitAt = source.indexOf('\r\n\r\n');
  const headers = splitAt >= 0 ? source.slice(0, splitAt) : source;
  const body = splitAt >= 0 ? source.slice(splitAt + 4) : '';
  const httpStatus = Number(headers.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || 0);
  const contentType = String(headers.match(/^content-type:\s*([^\r\n]+)/im)?.[1] || '').trim().toLowerCase();
  return { httpStatus, contentType, body };
}

function classifyOpenAiEndpoint(name, text, latencyMs) {
  const { httpStatus, contentType, body } = responseMetadata(text);
  const combined = `${text}\n${body}`;
  const unsupported = /unsupported[_ -]?country|not available in your country|country[^<]{0,40}not supported|所在地区.{0,20}(?:不支持|不可用)/i.test(combined);
  if (unsupported) return {
    ok: false, name, status: 'unsupported-region', httpStatus, contentType, latencyMs,
    message: '节点可以连接 OpenAI，但所在国家或地区不受支持',
  };
  if (httpStatus === 403) return {
    ok: false, name, status: 'cloudflare-blocked', httpStatus, contentType, latencyMs,
    message: '节点被 OpenAI 或 Cloudflare 拒绝访问',
  };
  if (httpStatus === 429) return {
    ok: false, name, status: 'rate-limited', httpStatus, contentType, latencyMs,
    message: '节点访问 OpenAI 时受到速率限制',
  };
  if (name === 'chatgpt-auth-api' || name === 'openai-auth-api') {
    const jsonType = /(?:application|text)\/json/i.test(contentType);
    if (httpStatus >= 200 && httpStatus < 500 && jsonType) return {
      ok: true, name, status: 'available', httpStatus, contentType, latencyMs,
      message: name === 'openai-auth-api' ? 'OpenAI 账号认证接口可用' : 'ChatGPT 登录接口可用',
    };
    if (httpStatus >= 200 && httpStatus < 500 && /html/i.test(contentType)) return {
      ok: false, name, status: 'html-instead-of-json', httpStatus, contentType, latencyMs,
      message: name === 'openai-auth-api'
        ? 'OpenAI 账号认证接口返回了 HTML，填写邮箱后会出现 JSON 解析错误'
        : 'ChatGPT 登录接口返回了 HTML，继续登录会出现 JSON 解析错误',
    };
  }
  if (httpStatus >= 200 && httpStatus < 400) return {
    ok: true, name, status: 'available', httpStatus, contentType, latencyMs, message: 'OpenAI 认证页面可用',
  };
  return {
    ok: false, name, status: httpStatus ? 'http-error' : 'connection-failed', httpStatus, contentType, latencyMs,
    message: `OpenAI 认证链路返回 HTTP ${httpStatus || '未知'}`,
  };
}

function requestHttpsThroughProxy(mixedPort, { hostname, pathname, timeoutMs = 12_000 }) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.connect({ host: '127.0.0.1', port: mixedPort });
    let connectHeaders = '';
    let response = Buffer.alloc(0);
    let settled = false;
    let secure = null;
    const timer = setTimeout(() => finish(new Error(`访问 ${hostname} 超时`)), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { secure?.destroy(); } catch {}
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once('connect', () => socket.write(`CONNECT ${hostname}:443 HTTP/1.1\r\nHost: ${hostname}:443\r\nConnection: keep-alive\r\n\r\n`));
    socket.on('data', (chunk) => {
      if (secure) return;
      connectHeaders += chunk.toString('latin1');
      if (connectHeaders.length > 16_384) return finish(new Error('代理返回了异常响应'));
      if (!connectHeaders.includes('\r\n\r\n')) return;
      const status = Number(connectHeaders.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || 0);
      if (status !== 200) return finish(new Error(`代理隧道连接失败（HTTP ${status || '未知'}）`));
      socket.removeAllListeners('data');
      secure = tls.connect({ socket, servername: hostname });
      secure.once('secureConnect', () => {
        secure.write(`GET ${pathname} HTTP/1.1\r\nHost: ${hostname}\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36\r\nAccept: application/json,text/html,text/plain,*/*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
      });
      secure.on('data', (data) => {
        response = Buffer.concat([response, data]);
        if (response.length > 256 * 1024) secure.destroy();
      });
      secure.once('error', (error) => finish(error));
      secure.once('close', () => {
        if (!response.length) return finish(new Error(`${hostname} 没有返回响应`));
        return finish(null, { text: response.toString('utf8'), latencyMs: Date.now() - startedAt });
      });
    });
    socket.once('error', (error) => finish(error));
  });
}

async function probeOpenAiRoute(mixedPort, timeoutMs = 12_000) {
  const targets = [
    { name: 'chatgpt-home', hostname: 'chatgpt.com', pathname: '/' },
    { name: 'chatgpt-auth-api', hostname: 'chatgpt.com', pathname: '/api/auth/csrf' },
    { name: 'openai-auth-page', hostname: 'auth.openai.com', pathname: '/log-in' },
    { name: 'openai-auth-api', hostname: 'auth.openai.com', pathname: '/api/accounts/authorize' },
  ];
  const checks = [];
  for (const target of targets) {
    let result;
    try {
      const response = await requestHttpsThroughProxy(mixedPort, { ...target, timeoutMs });
      result = classifyOpenAiEndpoint(target.name, response.text, response.latencyMs);
    } catch (error) {
      result = {
        ok: false, name: target.name, status: 'connection-failed', httpStatus: 0, contentType: '', latencyMs: null,
        message: `无法连接 ${target.hostname}：${cleanText(error.message, 180)}`,
      };
    }
    checks.push(result);
    if (!result.ok) return { ...result, checks };
  }
  return {
    ok: true,
    status: 'available',
    httpStatus: checks.at(-1)?.httpStatus || 200,
    latencyMs: Math.max(...checks.map((item) => Number(item.latencyMs) || 0)),
    message: 'ChatGPT 登录、OpenAI OAuth 与网页访问均可用',
    checks,
  };
}

function probeChatGpt(mixedPort, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const socket = net.connect({ host: '127.0.0.1', port: mixedPort });
    let stage = 'connect';
    let headers = '';
    let response = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('访问 ChatGPT 超时')), timeoutMs);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once('connect', () => socket.write('CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nConnection: keep-alive\r\n\r\n'));
    socket.on('data', (chunk) => {
      if (stage !== 'connect') return;
      headers += chunk.toString('latin1');
      if (headers.length > 16_384) return finish(new Error('代理返回了异常响应'));
      if (!headers.includes('\r\n\r\n')) return;
      const status = Number(headers.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i)?.[1] || 0);
      if (status !== 200) return finish(new Error(`代理隧道连接失败（HTTP ${status || '未知'}）`));
      let connectLatencyMs = null;
      stage = 'tls';
      socket.removeAllListeners('data');
      const secure = tls.connect({ socket, servername: 'chatgpt.com' });
      secure.once('secureConnect', () => {
        // The local proxy can acknowledge CONNECT before its remote route has
        // completed. Time through the real ChatGPT TLS handshake so a local
        // 1 ms acknowledgement is never presented as remote route latency.
        connectLatencyMs = Date.now() - startedAt;
        stage = 'http';
        secure.write('GET / HTTP/1.1\r\nHost: chatgpt.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36\r\nAccept: text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8\r\nAccept-Language: zh-CN,zh;q=0.9,en;q=0.8\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n');
      });
      secure.on('data', (data) => {
        response = Buffer.concat([response, data]);
        if (response.length > 256 * 1024) secure.destroy();
      });
      secure.once('error', (error) => {
        const wrapped = new Error(`代理隧道已建立，但 ChatGPT TLS 握手被中断：${cleanText(error.message, 140)}`);
        wrapped.code = 'CHATGPT_TLS_FAILED';
        wrapped.connectLatencyMs = null;
        finish(wrapped);
      });
      secure.once('close', () => {
        if (!response.length) return finish(new Error('ChatGPT 没有返回响应'));
        const text = response.toString('utf8');
        return finish(null, { ...classifyChatGptResponse(text, Date.now() - startedAt), connectLatencyMs });
      });
    });
    socket.once('error', (error) => finish(error));
  });
}

async function probeChatGptWithRetry(mixedPort, timeoutMs = 12_000, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await probeChatGpt(mixedPort, timeoutMs); }
    catch (error) {
      lastError = error;
      if (error.code !== 'CHATGPT_TLS_FAILED' || attempt >= attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  if (lastError?.code === 'CHATGPT_TLS_FAILED' && attempts > 1) {
    const error = new Error(`代理认证和隧道正常，但 ChatGPT TLS 连续 ${attempts} 次被中断；节点出口或代理服务端可能不稳定`);
    error.code = lastError.code;
    error.connectLatencyMs = lastError.connectLatencyMs;
    throw error;
  }
  throw lastError;
}

class AccountNetworkManager {
  constructor({ runtimeRoot, audit = () => {} }) {
    this.runtimeRoot = runtimeRoot;
    this.audit = audit;
    this.dataFile = path.join(runtimeRoot, 'config', 'network-settings.json');
    this.coreDir = path.join(runtimeRoot, 'network-core');
    this.sourcesDir = path.join(this.coreDir, 'sources');
    this.runtimesDir = path.join(this.coreDir, 'runtimes');
    this.bundledCore = cleanText(process.env.CODEX_NAVO_BUNDLED_NETWORK_CORE, 1_000);
    this.data = readJson(this.dataFile, { version: 1, sources: [], assignments: {} });
    this.data.sources = Array.isArray(this.data.sources) ? this.data.sources : [];
    this.data.assignments = this.data.assignments && typeof this.data.assignments === 'object' ? this.data.assignments : {};
    this.inspector = null;
    this.accountRuntimes = new Map();
    this.accountRuntimePromises = new Map();
    this.accountRuntimeGenerations = new Map();
    this.runtimeStartQueue = Promise.resolve();
    this.taskRuntime = null;
    this.taskRuntimePromise = null;
    this.sourceTestProgress = new Map();
  }

  save() { writeJsonAtomic(this.dataFile, this.data); }

  publicState() {
    return {
      core: { installed: fs.existsSync(this.coreExecutable()), version: CORE_VERSION },
      sources: this.data.sources.map((source) => ({
        ...publicSource(source),
        testing: this.sourceTestProgress.has(source.id) ? { ...this.sourceTestProgress.get(source.id) } : null,
      })),
      assignments: Object.fromEntries(Object.entries(this.data.assignments).map(([accountId, assignment]) => [accountId, this.publicAssignment(accountId, assignment)])),
    };
  }

  publicAssignment(accountId, value = this.data.assignments[accountId]) {
    if (!value || value.mode !== 'proxy') return { mode: 'direct', sourceId: '', nodeName: '', label: '直连' };
    const source = this.data.sources.find((item) => item.id === value.sourceId);
    const node = source?.nodes?.find((item) => item.name === value.nodeName);
    const standalone = source?.kind !== 'subscription' && source?.nodes?.length === 1;
    const displayName = standalone ? (source?.name || value.nodeName) : value.nodeName;
    return {
      mode: 'proxy',
      sourceId: value.sourceId,
      nodeName: value.nodeName,
      label: source && !standalone ? `${source.name} · ${value.nodeName}` : displayName,
      displayName,
      status: node?.status || 'untested',
      delay: Number(node?.delay) || null,
      checkedAt: node?.checkedAt || '',
    };
  }

  coreExecutable() { return path.join(this.coreDir, `mihomo-${CORE_VERSION}.exe`); }

  async installCore() {
    const executable = this.coreExecutable();
    if (fs.existsSync(executable)) {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
      if (digest === CORE_EXECUTABLE_SHA256) return executable;
      fs.rmSync(executable, { force: true });
      this.audit('network.core.repair', { result: `${CORE_VERSION}:checksum-mismatch` });
    }
    fs.mkdirSync(this.coreDir, { recursive: true });
    if (this.bundledCore && fs.existsSync(this.bundledCore)) {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(this.bundledCore)).digest('hex');
      if (digest !== CORE_EXECUTABLE_SHA256) throw new Error('安装包内的代理核心校验失败，请重新安装 Codex Navo');
      const temporaryExecutable = `${executable}.${process.pid}.tmp`;
      fs.copyFileSync(this.bundledCore, temporaryExecutable);
      fs.renameSync(temporaryExecutable, executable);
      this.audit('network.core.installed', { result: `${CORE_VERSION}:bundled` });
      return executable;
    }
    const archive = path.join(this.coreDir, `mihomo-${CORE_VERSION}.zip`);
    const temporary = `${archive}.download`;
    fs.rmSync(temporary, { force: true });
    fs.rmSync(archive, { force: true });
    for (const entry of fs.readdirSync(this.coreDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('extract-')) {
        fs.rmSync(path.join(this.coreDir, entry.name), { recursive: true, force: true });
      }
    }
    let response;
    try {
      response = await fetch(CORE_ARCHIVE_URL, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new Error(`代理核心下载失败：连接 GitHub 失败（${cleanText(error.cause?.code || error.message, 120)}）`);
    }
    if (!response.ok) throw new Error(`代理核心下载失败（HTTP ${response.status}）`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 5_000_000 || buffer.length > 60_000_000) throw new Error('代理核心下载内容异常');
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    if (digest !== CORE_ARCHIVE_SHA256) throw new Error('代理核心校验失败，下载内容与官方发布文件不一致');
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, archive);
    const extractDir = path.join(this.coreDir, `extract-${Date.now()}`);
    fs.mkdirSync(extractDir, { recursive: true });
    const result = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath $env:CODEX_NAVO_CORE_ARCHIVE -DestinationPath $env:CODEX_NAVO_CORE_DESTINATION -Force',
    ], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...process.env,
        CODEX_NAVO_CORE_ARCHIVE: archive,
        CODEX_NAVO_CORE_DESTINATION: extractDir,
      },
    });
    if (result.status !== 0) throw new Error(`代理核心解压失败：${String(result.stderr || '').trim()}`);
    const found = fs.readdirSync(extractDir).find((name) => /^mihomo.*\.exe$/i.test(name));
    if (!found) throw new Error('代理核心压缩包中没有找到可执行文件');
    fs.copyFileSync(path.join(extractDir, found), executable);
    const executableDigest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    if (executableDigest !== CORE_EXECUTABLE_SHA256) {
      fs.rmSync(executable, { force: true });
      throw new Error('代理核心校验失败，解压后的文件与官方发布版本不一致');
    }
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(archive, { force: true });
    this.audit('network.core.installed', { result: CORE_VERSION });
    return executable;
  }

  addSource(input, name) {
    const parsed = parseProxyInput(input, name);
    const source = {
      ...parsed,
      id: `network-${crypto.randomBytes(6).toString('hex')}`,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      error: '',
    };
    this.data.sources.push(source);
    this.save();
    this.stopInspector();
    this.stopTask();
    return publicSource(source);
  }

  removeSource(sourceId) {
    const index = this.data.sources.findIndex((item) => item.id === sourceId);
    if (index < 0) throw new Error('节点来源不存在');
    this.data.sources.splice(index, 1);
    for (const [accountId, assignment] of Object.entries(this.data.assignments)) {
      if (assignment.sourceId === sourceId) {
        delete this.data.assignments[accountId];
        this.stopAccount(accountId);
      }
    }
    this.save();
    this.stopInspector();
    this.stopTask();
  }

  assign(accountId, value) {
    if (!value || value.mode !== 'proxy') {
      const previous = this.data.assignments[accountId];
      const runtime = this.accountRuntimes.get(accountId);
      if (runtime && processAlive(runtime.child)) {
        this.data.assignments[accountId] = {
          mode: 'direct',
          ...(Number.isInteger(previous?.mixedPort) ? { mixedPort: previous.mixedPort } : {}),
          ...(Number.isInteger(previous?.controllerPort) ? { controllerPort: previous.controllerPort } : {}),
        };
      } else {
        delete this.data.assignments[accountId];
        this.stopAccount(accountId);
      }
      this.stopTask();
      this.save();
      return this.publicAssignment(accountId);
    }
    const source = this.data.sources.find((item) => item.id === cleanText(value.sourceId, 80));
    if (!source) throw new Error('请选择有效的节点来源');
    const nodeName = cleanText(value.nodeName, 160);
    if (!nodeName || !(source.nodes || []).some((node) => node.name === nodeName)) throw new Error('请选择有效的代理节点');
    const previous = this.data.assignments[accountId];
    this.data.assignments[accountId] = {
      mode: 'proxy',
      sourceId: source.id,
      nodeName,
      ...(Number.isInteger(previous?.mixedPort) ? { mixedPort: previous.mixedPort } : {}),
      ...(Number.isInteger(previous?.controllerPort) ? { controllerPort: previous.controllerPort } : {}),
    };
    // Keep the account-local core alive. ensureAccount() can switch a node in
    // place through Mihomo's controller, preserving the proxy endpoint already
    // held by Chrome and Codex Desktop.
    this.stopTask();
    this.save();
    return this.publicAssignment(accountId);
  }

  source(sourceId) {
    const source = this.data.sources.find((item) => item.id === sourceId);
    if (!source) throw new Error('节点来源不存在');
    return source;
  }

  writeProvider(source, runtimeDir) {
    const runtimeSourcesDir = path.join(runtimeDir, 'sources');
    fs.mkdirSync(runtimeSourcesDir, { recursive: true });
    if (source.kind === 'subscription') return {
      type: 'http',
      url: source.url,
      path: path.join(runtimeSourcesDir, `${source.id}.yaml`),
      interval: 3600,
      header: { 'User-Agent': ['clash.meta'] },
      'health-check': { enable: false },
    };
    const extension = source.format === 'yaml' ? 'yaml' : 'txt';
    const sourceFile = path.join(runtimeSourcesDir, `${source.id}.${extension}`);
    fs.writeFileSync(sourceFile, source.content, { mode: 0o600 });
    return { type: 'file', path: sourceFile, 'health-check': { enable: false } };
  }

  async writeConfig(runtimeDir, sources, mixedPort, controllerPort, secret, groupName) {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const providers = {};
    for (const source of sources) providers[providerName(source.id)] = this.writeProvider(source, runtimeDir);
    const config = {
      'mixed-port': mixedPort,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'warning',
      ipv6: true,
      'external-controller': `127.0.0.1:${controllerPort}`,
      secret,
      'proxy-providers': providers,
      'proxy-groups': [{ name: groupName, type: 'select', proxies: ['DIRECT'], use: Object.keys(providers) }],
      rules: [`MATCH,${groupName}`],
    };
    const configFile = path.join(runtimeDir, 'config.yaml');
    fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return configFile;
  }

  async request(runtime, pathname, options = {}) {
    const response = await fetch(`http://127.0.0.1:${runtime.controllerPort}${pathname}`, {
      ...options,
      headers: { Authorization: `Bearer ${runtime.secret}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: options.signal || AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`代理核心请求失败（HTTP ${response.status}）`);
    if (response.status === 204) return {};
    return response.json();
  }

  async startRuntime(name, sources, groupName, ports = {}) {
    const previous = this.runtimeStartQueue;
    let release;
    this.runtimeStartQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.startRuntimeExclusive(name, sources, groupName, ports);
    } finally {
      release();
    }
  }

  async startRuntimeExclusive(name, sources, groupName, ports = {}) {
    const executable = await this.installCore();
    const mixedPort = await freeProxyPort(ports.mixedPort);
    // The controller is internal and intentionally stays outside the public
    // proxy pool. Only the reusable mixed proxy endpoint uses 18301-18399.
    let controllerPort = await freePort();
    while (controllerPort === mixedPort || (controllerPort >= PROXY_PORT_START && controllerPort <= PROXY_PORT_END)) controllerPort = await freePort();
    const secret = crypto.randomBytes(24).toString('base64url');
    const runtimeDir = path.join(this.runtimesDir, `${name}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
    const configFile = await this.writeConfig(runtimeDir, sources, mixedPort, controllerPort, secret, groupName);
    const child = spawn(executable, ['-d', runtimeDir, '-f', configFile], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    const runtime = { child, mixedPort, controllerPort, secret, runtimeDir, groupName };
    child.once('exit', () => {
      try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
    });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (!processAlive(child)) throw new Error('代理核心启动后提前退出，请检查节点或订阅格式');
      try { await this.request(runtime, '/version', { signal: AbortSignal.timeout(800) }); return runtime; }
      catch { await new Promise((resolve) => setTimeout(resolve, 180)); }
    }
    this.stopRuntime(runtime);
    throw new Error('代理核心启动超时');
  }

  stopRuntime(runtime) {
    if (!runtime) return;
    try { runtime.child.kill(); } catch {}
  }

  stopInspector() { this.stopRuntime(this.inspector); this.inspector = null; }

  stopAccount(accountId) {
    this.accountRuntimeGenerations.set(accountId, (this.accountRuntimeGenerations.get(accountId) || 0) + 1);
    this.stopRuntime(this.accountRuntimes.get(accountId));
    this.accountRuntimes.delete(accountId);
    this.accountRuntimePromises.delete(accountId);
  }

  stopTask() {
    this.stopRuntime(this.taskRuntime);
    this.taskRuntime = null;
    this.taskRuntimePromise = null;
  }

  async ensureInspector() {
    if (this.inspector && processAlive(this.inspector.child)) return this.inspector;
    if (!this.data.sources.length) throw new Error('请先添加节点或机场订阅');
    this.inspector = await this.startRuntime('inspector', this.data.sources, 'Navo Inspector');
    return this.inspector;
  }

  async readProviderNodes(runtime, source) {
    const data = await this.request(runtime, `/providers/proxies/${encodeURIComponent(providerName(source.id))}`);
    const proxies = Array.isArray(data.proxies) ? data.proxies : [];
    return proxies.map((node) => ({
      name: cleanText(node.name, 160),
      protocol: protocolLabel(node.type || 'proxy'),
      delay: Number(node.history?.at(-1)?.delay) || null,
    })).filter((node) => node.name);
  }

  async waitForProviderNodes(runtime, source, { refresh = false, timeoutMs = 30_000 } = {}) {
    if (source.kind !== 'subscription') return this.readProviderNodes(runtime, source);
    const providerPath = `/providers/proxies/${encodeURIComponent(providerName(source.id))}`;
    const deadline = Date.now() + timeoutMs;
    let nextUpdateAt = refresh ? 0 : Date.now() + 1_500;
    while (Date.now() < deadline) {
      if (Date.now() >= nextUpdateAt) {
        try { await this.request(runtime, providerPath, { method: 'PUT', signal: AbortSignal.timeout(12_000) }); }
        catch {}
        nextUpdateAt = Date.now() + 2_000;
      }
      const nodes = await this.readProviderNodes(runtime, source);
      if (nodes.length) return nodes;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return [];
  }

  async refreshSource(sourceId) {
    const source = this.source(sourceId);
    this.stopInspector();
    try {
      const runtime = await this.ensureInspector();
      source.nodes = await this.waitForProviderNodes(runtime, source, { refresh: true });
      if (!source.nodes.length) throw new Error('订阅或节点配置中没有可用节点');
      source.updatedAt = new Date().toISOString();
      source.error = '';
      this.save();
      this.stopTask();
      return publicSource(source);
    } catch (error) {
      source.error = cleanText(error.message, 500);
      this.save();
      this.stopTask();
      throw error;
    }
  }

  async testNode(sourceId, nodeName) {
    const source = this.source(sourceId);
    const found = (source.nodes || []).find((item) => item.name === nodeName);
    if (!found) throw new Error('要检测的节点不存在，请先刷新节点列表');
    const unsupportedRegion = unsupportedRegionFromNodeName(nodeName);
    if (unsupportedRegion) {
      const result = unsupportedRegionResult(unsupportedRegion);
      Object.assign(found, { connectDelay: null, delay: null, status: result.status, checkedAt: new Date().toISOString() });
      source.updatedAt = new Date().toISOString();
      this.save();
      return result;
    }
    const runtime = await this.startRuntime(`test-${source.id}`, [source], 'Navo Test');
    try {
      const availableNodes = await this.waitForProviderNodes(runtime, source);
      if (!availableNodes.some((node) => node.name === nodeName)) throw new Error('代理核心没有加载到该节点');
      await this.request(runtime, `/proxies/${encodeURIComponent(runtime.groupName)}`, {
        method: 'PUT',
        body: JSON.stringify({ name: cleanText(nodeName, 160) }),
      });
      const result = await probeChatGptWithRetry(runtime.mixedPort);
      const delay = result.latencyMs;
      Object.assign(found, { connectDelay: result.connectLatencyMs, delay, status: result.status, checkedAt: new Date().toISOString() });
      source.updatedAt = new Date().toISOString();
      this.save();
      this.stopTask();
      return { ...result, delay };
    } catch (error) {
      const status = error.code === 'CHATGPT_TLS_FAILED' ? 'tls-failed' : 'connection-failed';
      Object.assign(found, { connectDelay: Number(error.connectLatencyMs) || null, delay: null, status, checkedAt: new Date().toISOString() });
      source.updatedAt = new Date().toISOString();
      this.save();
      this.stopTask();
      return {
        ok: false,
        status,
        httpStatus: 0,
        latencyMs: null,
        connectLatencyMs: Number(error.connectLatencyMs) || null,
        delay: null,
        message: `无法通过该节点连接 ChatGPT：${cleanText(error.message, 220)}`,
      };
    } finally {
      this.stopRuntime(runtime);
    }
  }

  async testSource(sourceId, concurrency = 3) {
    const source = this.source(sourceId);
    if (!(source.nodes || []).length) throw new Error('该线路还没有节点，请先刷新订阅');
    if (this.sourceTestProgress.has(sourceId)) throw new Error('该线路正在检测中');
    const availableNames = new Set();
    let cursor = 0;
    const summary = { total: source.nodes.length, available: 0, unsupported: 0, failed: 0 };
    const progress = { ...summary, completed: 0, startedAt: new Date().toISOString() };
    this.sourceTestProgress.set(sourceId, progress);
    const publish = () => {
      Object.assign(progress, summary, { completed: summary.available + summary.unsupported + summary.failed });
      source.updatedAt = new Date().toISOString();
      this.save();
    };
    for (const node of source.nodes) {
      const unsupportedRegion = unsupportedRegionFromNodeName(node.name);
      if (unsupportedRegion) {
        Object.assign(node, { connectDelay: null, delay: null, status: 'unsupported-region', checkedAt: new Date().toISOString() });
        summary.unsupported += 1;
      } else {
        Object.assign(node, { connectDelay: null, delay: null, status: 'checking', checkedAt: null });
      }
    }
    publish();
    const worker = async (workerIndex) => {
      const runtime = await this.startRuntime(`test-all-${source.id}-${workerIndex}`, [source], `Navo Batch ${workerIndex}`);
      try {
        for (const node of await this.waitForProviderNodes(runtime, source)) availableNames.add(node.name);
        while (cursor < source.nodes.length) {
          const index = cursor++;
          const node = source.nodes[index];
          if (node.status === 'unsupported-region') continue;
          if (!availableNames.has(node.name)) {
            Object.assign(node, { connectDelay: null, delay: null, status: 'connection-failed', checkedAt: new Date().toISOString() });
            summary.failed += 1;
            publish();
            continue;
          }
          try {
            await this.request(runtime, `/proxies/${encodeURIComponent(runtime.groupName)}`, {
              method: 'PUT',
              body: JSON.stringify({ name: node.name }),
            });
            const result = await probeChatGpt(runtime.mixedPort, 10_000);
            Object.assign(node, { connectDelay: result.connectLatencyMs, delay: result.latencyMs, status: result.status, checkedAt: new Date().toISOString() });
            if (result.ok) summary.available += 1;
            else if (result.status === 'unsupported-region') summary.unsupported += 1;
            else summary.failed += 1;
            publish();
          } catch (error) {
            Object.assign(node, { connectDelay: Number(error.connectLatencyMs) || null, delay: null, status: error.code === 'CHATGPT_TLS_FAILED' ? 'tls-failed' : 'connection-failed', checkedAt: new Date().toISOString() });
            summary.failed += 1;
            publish();
          }
        }
      } finally {
        this.stopRuntime(runtime);
      }
    };
    try {
      const workerCount = Math.min(Math.max(1, Number(concurrency) || 3), 4, source.nodes.length);
      const workers = await Promise.allSettled(Array.from({ length: workerCount }, (_, index) => worker(index + 1)));
      const failedWorker = workers.find((result) => result.status === 'rejected');
      if (failedWorker) throw failedWorker.reason;
      source.updatedAt = new Date().toISOString();
      source.error = '';
      this.save();
      this.stopTask();
      return summary;
    } catch (error) {
      for (const node of source.nodes.filter((item) => item.status === 'checking')) {
        Object.assign(node, { connectDelay: null, delay: null, status: 'connection-failed', checkedAt: new Date().toISOString() });
        summary.failed += 1;
      }
      source.updatedAt = new Date().toISOString();
      source.error = cleanText(error.message, 500);
      this.save();
      throw error;
    } finally {
      this.sourceTestProgress.delete(sourceId);
    }
  }

  async ensureAccount(accountId) {
    const assignment = this.data.assignments[accountId];
    const current = this.accountRuntimes.get(accountId);
    if (current && processAlive(current.child)) {
      if (assignment && (!Number.isInteger(assignment.mixedPort) || !Number.isInteger(assignment.controllerPort))) {
        assignment.mixedPort = current.mixedPort;
        assignment.controllerPort = current.controllerPort;
        this.save();
      }
      if (!assignment || assignment.mode !== 'proxy') {
        if (current.nodeName !== 'DIRECT') {
          try {
            await this.request(current, `/proxies/${encodeURIComponent(current.groupName)}`, {
              method: 'PUT',
              body: JSON.stringify({ name: 'DIRECT' }),
            });
          } catch {
            const configFile = await this.writeConfig(
              current.runtimeDir,
              this.data.sources,
              current.mixedPort,
              current.controllerPort,
              current.secret,
              current.groupName,
            );
            await this.request(current, '/configs?force=true', {
              method: 'PUT',
              body: JSON.stringify({ path: configFile }),
            });
            await this.request(current, `/proxies/${encodeURIComponent(current.groupName)}`, {
              method: 'PUT',
              body: JSON.stringify({ name: 'DIRECT' }),
            });
          }
          current.sourceId = '';
          current.nodeName = 'DIRECT';
          this.audit('network.account.hot-switched', { accountId, result: `DIRECT:${current.mixedPort}` });
        }
        return current;
      }
      if (current.sourceId === assignment.sourceId && current.nodeName === assignment.nodeName) return current;
      try {
        await this.request(current, `/proxies/${encodeURIComponent(current.groupName)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: assignment.nodeName }),
        });
      } catch (firstError) {
        // A source may have been added after this account core started. Reload
        // the complete provider set through Mihomo's controller while keeping
        // the same mixed port, so Chrome and Codex keep their live connection.
        const configFile = await this.writeConfig(
          current.runtimeDir,
          this.data.sources,
          current.mixedPort,
          current.controllerPort,
          current.secret,
          current.groupName,
        );
        await this.request(current, '/configs?force=true', {
          method: 'PUT',
          body: JSON.stringify({ path: configFile }),
        });
        const source = this.source(assignment.sourceId);
        const availableNodes = await this.waitForProviderNodes(current, source);
        if (!availableNodes.some((node) => node.name === assignment.nodeName)) throw firstError;
        await this.request(current, `/proxies/${encodeURIComponent(current.groupName)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: assignment.nodeName }),
        });
      }
      const latest = this.data.assignments[accountId];
      if (latest?.sourceId !== assignment.sourceId || latest?.nodeName !== assignment.nodeName) {
        return this.ensureAccount(accountId);
      }
      current.sourceId = assignment.sourceId;
      current.nodeName = assignment.nodeName;
      this.audit('network.account.hot-switched', {
        accountId,
        result: `${assignment.nodeName}:${current.mixedPort}`,
      });
      return current;
    }
    if (!assignment || assignment.mode !== 'proxy') return null;
    const pending = this.accountRuntimePromises.get(accountId);
    if (pending && pending.sourceId === assignment.sourceId && pending.nodeName === assignment.nodeName) return pending.promise;
    this.stopAccount(accountId);
    const generation = this.accountRuntimeGenerations.get(accountId) || 0;
    const sourceId = assignment.sourceId;
    const nodeName = assignment.nodeName;
    const promise = (async () => {
      const source = this.source(sourceId);
      const runtime = await this.startRuntime(`account-${accountId}`, this.data.sources, 'Navo Account', {
        mixedPort: Number.isInteger(assignment.mixedPort) ? assignment.mixedPort : undefined,
        controllerPort: Number.isInteger(assignment.controllerPort) ? assignment.controllerPort : undefined,
      });
      try {
        const availableNodes = await this.waitForProviderNodes(runtime, source);
        if (!availableNodes.some((node) => node.name === nodeName)) throw new Error('代理核心没有加载到已选择的节点');
        await this.request(runtime, `/proxies/${encodeURIComponent('Navo Account')}`, {
          method: 'PUT',
          body: JSON.stringify({ name: nodeName }),
        });
        const latest = this.data.assignments[accountId];
        if ((this.accountRuntimeGenerations.get(accountId) || 0) !== generation
          || latest?.sourceId !== sourceId || latest?.nodeName !== nodeName) {
          throw new Error('账号线路在代理启动期间发生了变化');
        }
      } catch (error) {
        this.stopRuntime(runtime);
        throw new Error(`无法选择节点“${nodeName}”：${error.message}`);
      }
      Object.assign(runtime, { sourceId, nodeName });
      const latest = this.data.assignments[accountId];
      if (latest?.sourceId === sourceId && latest?.nodeName === nodeName) {
        latest.mixedPort = runtime.mixedPort;
        latest.controllerPort = runtime.controllerPort;
        this.save();
      }
      this.accountRuntimes.set(accountId, runtime);
      return runtime;
    })();
    const entry = { sourceId, nodeName, promise };
    this.accountRuntimePromises.set(accountId, entry);
    try { return await promise; }
    finally {
      if (this.accountRuntimePromises.get(accountId) === entry) this.accountRuntimePromises.delete(accountId);
    }
  }

  async preflightAccount(accountId, timeoutMs = 12_000) {
    const assignment = this.data.assignments[accountId];
    if (!assignment || assignment.mode !== 'proxy') return { ok: true, status: 'direct', message: '直连线路' };
    const unsupportedRegion = unsupportedRegionFromNodeName(assignment.nodeName);
    if (unsupportedRegion) {
      const result = unsupportedRegionResult(unsupportedRegion);
      const source = this.source(assignment.sourceId);
      const node = (source.nodes || []).find((item) => item.name === assignment.nodeName);
      if (node) {
        Object.assign(node, { connectDelay: null, delay: null, status: result.status, checkedAt: new Date().toISOString() });
        source.updatedAt = node.checkedAt;
        this.save();
      }
      return result;
    }
    const runtime = await this.ensureAccount(accountId);
    const result = await probeChatGptWithRetry(runtime.mixedPort, timeoutMs);
    const source = this.source(assignment.sourceId);
    const node = (source.nodes || []).find((item) => item.name === assignment.nodeName);
    if (node) {
      node.status = result.status;
      node.connectDelay = Number(result.connectLatencyMs) || null;
      node.delay = result.ok ? result.latencyMs : null;
      node.checkedAt = new Date().toISOString();
      source.updatedAt = node.checkedAt;
      this.save();
    }
    return result;
  }

  async ensureTask(preferredAccountId = '') {
    const selected = selectTaskRoute(this.data, preferredAccountId);
    if (!selected) {
      this.stopTask();
      return null;
    }
    const accountRuntime = this.accountRuntimes.get(selected.accountId);
    if (accountRuntime && processAlive(accountRuntime.child)
      && accountRuntime.sourceId === selected.sourceId && accountRuntime.nodeName === selected.nodeName) {
      return accountRuntime;
    }
    if (this.taskRuntime && processAlive(this.taskRuntime.child)
      && this.taskRuntime.sourceId === selected.sourceId && this.taskRuntime.nodeName === selected.nodeName) {
      return this.taskRuntime;
    }
    if (this.taskRuntimePromise) return this.taskRuntimePromise;
    this.stopTask();
    this.taskRuntimePromise = (async () => {
      const source = this.source(selected.sourceId);
      const runtime = await this.startRuntime('background-tasks', [source], 'Navo Tasks');
      try {
        const availableNodes = await this.waitForProviderNodes(runtime, source);
        if (!availableNodes.some((node) => node.name === selected.nodeName)) throw new Error('代理核心没有加载到后台任务节点');
        await this.request(runtime, `/proxies/${encodeURIComponent(runtime.groupName)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: selected.nodeName }),
        });
      } catch (error) {
        this.stopRuntime(runtime);
        throw error;
      }
      Object.assign(runtime, { sourceId: selected.sourceId, nodeName: selected.nodeName });
      this.taskRuntime = runtime;
      return runtime;
    })().finally(() => { this.taskRuntimePromise = null; });
    return this.taskRuntimePromise;
  }

  environmentForRuntime(runtime, environment = process.env) {
    if (!runtime || !processAlive(runtime.child)) return { ...environment };
    const url = `http://127.0.0.1:${runtime.mixedPort}`;
    // Managed account routes proxy every remote destination, including GitHub.
    // Keep only local IPC endpoints outside Mihomo instead of inheriting a
    // machine-wide NO_PROXY list that may unexpectedly bypass remote hosts.
    const bypass = 'localhost,127.0.0.1,::1,.localhost,0.0.0.0';
    const next = {
      ...environment,
      HTTP_PROXY: url, HTTPS_PROXY: url,
      http_proxy: url, https_proxy: url,
      ALL_PROXY: url, all_proxy: url,
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: bypass,
      no_proxy: bypass,
    };
    return next;
  }

  environment(accountId, environment = process.env) {
    const runtime = this.accountRuntimes.get(accountId);
    return this.environmentForRuntime(runtime, environment);
  }

  browserArgs(accountId) {
    const runtime = this.accountRuntimes.get(accountId);
    return runtime && processAlive(runtime.child)
      ? [
        `--proxy-server=http://127.0.0.1:${runtime.mixedPort}`,
        '--proxy-bypass-list=<local>;localhost;*.localhost;127.0.0.1;[::1]',
      ]
      : [];
  }

  isAccountRuntimeReady(accountId) {
    const runtime = this.accountRuntimes.get(accountId);
    return Boolean(runtime && processAlive(runtime.child));
  }

  shutdown() {
    this.stopInspector();
    this.stopTask();
    for (const accountId of this.accountRuntimes.keys()) this.stopAccount(accountId);
  }
}

module.exports = {
  AccountNetworkManager,
  classifyChatGptResponse,
  classifyOpenAiEndpoint,
  CORE_ARCHIVE_URL,
  CORE_ARCHIVE_SHA256,
  CORE_EXECUTABLE_SHA256,
  CORE_VERSION,
  freeProxyPort,
  PROXY_PORT_END,
  PROXY_PORT_START,
  parseProxyInput,
  probeChatGpt,
  probeOpenAiRoute,
  publicSource,
  selectTaskRoute,
  unsupportedRegionFromNodeName,
};

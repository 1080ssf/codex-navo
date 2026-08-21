const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function jwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    return part ? JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) : {};
  } catch {
    return {};
  }
}

function proxyUrl(value, scheme = 'http') {
  const input = String(value || '').trim();
  if (!input) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `${scheme}://${input}`;
}

function parseWindowsProxyServer(value) {
  const input = String(value || '').trim();
  if (!input) return {};
  if (!input.includes('=')) {
    const url = proxyUrl(input);
    return { HTTP_PROXY: url, HTTPS_PROXY: url };
  }
  const entries = Object.fromEntries(input.split(';').map((item) => item.trim().split(/=(.*)/s)).filter(([key, target]) => key && target));
  const http = proxyUrl(entries.http || entries.https || '');
  const https = proxyUrl(entries.https || entries.http || '');
  const socks = proxyUrl(entries.socks || '', 'socks5');
  return {
    ...(http ? { HTTP_PROXY: http } : {}),
    ...(https ? { HTTPS_PROXY: https } : {}),
    ...(!http && !https && socks ? { ALL_PROXY: socks } : {}),
  };
}

function readWindowsProxySettings() {
  if (process.platform !== 'win32') return {};
  const result = spawnSync('reg.exe', [
    'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
  ], { encoding: 'utf8', windowsHide: true, timeout: 3_000 });
  if (result.status !== 0 || !/ProxyEnable\s+REG_DWORD\s+0x1/i.test(result.stdout || '')) return {};
  const server = String(result.stdout || '').match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1]?.trim();
  return parseWindowsProxyServer(server);
}

function resolveProtocolProxyEnvironment(environment = process.env, windowsSettings = readWindowsProxySettings()) {
  const next = { ...environment };
  const existing = next.HTTPS_PROXY || next.https_proxy || next.HTTP_PROXY || next.http_proxy || next.ALL_PROXY || next.all_proxy;
  if (!existing) Object.assign(next, windowsSettings);
  if (next.HTTP_PROXY && !next.http_proxy) next.http_proxy = next.HTTP_PROXY;
  if (next.HTTPS_PROXY && !next.https_proxy) next.https_proxy = next.HTTPS_PROXY;
  if (next.ALL_PROXY && !next.all_proxy) next.all_proxy = next.ALL_PROXY;
  next.NODE_USE_ENV_PROXY = '1';
  next.NO_PROXY ||= 'localhost,127.0.0.1,::1';
  next.no_proxy ||= next.NO_PROXY;
  return next;
}

function readProtocolOauthExport(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const account = payload?.type === 'sub2api-data' ? payload.accounts?.[0] : payload?.accounts?.[0];
  const credentials = account?.credentials || {};
  const accessToken = String(credentials.access_token || '');
  const refreshToken = String(credentials.refresh_token || '');
  const idToken = String(credentials.id_token || '');
  const accessClaims = jwtPayload(accessToken);
  const idClaims = jwtPayload(idToken);
  const tokenAccountId = accessClaims?.['https://api.openai.com/auth']?.chatgpt_account_id
    || idClaims?.['https://api.openai.com/auth']?.chatgpt_account_id;
  const accountId = String(tokenAccountId || credentials.chatgpt_account_id || account?.extra?.account_id || '');
  if (!accessToken || !refreshToken || !idToken) {
    throw new Error('协议登录结果缺少完整的 Codex OAuth 凭证');
  }
  return {
    email: String(credentials.email || account?.extra?.email || ''),
    auth: {
      auth_mode: 'chatgpt',
      last_refresh: new Date().toISOString(),
      tokens: {
        access_token: accessToken,
        refresh_token: refreshToken,
        id_token: idToken,
        account_id: accountId,
      },
    },
  };
}

function readProtocolSession(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cookies = Array.isArray(payload?.cookies) ? payload.cookies : [];
  if (!cookies.some((cookie) => cookie?.name && typeof cookie.value === 'string')) {
    throw new Error('协议登录结果没有可写入 Chrome 的网页会话');
  }
  return { cookies };
}

function protocolPromptFromOutput(output) {
  const text = String(output || '');
  const prompts = [
    { pattern: /Email OTP \(r=resend, q=quit\):\s*$/i, kind: 'email_otp', label: '邮箱验证码', hint: '输入 6 位邮箱验证码；输入 r 可重发' },
    { pattern: /Password \(q=quit\):\s*$/i, kind: 'password', label: '账号密码', hint: '输入当前账号密码', secret: true },
    { pattern: /2FA OTP \(6 digits, q=quit\):\s*$/i, kind: 'totp', label: '两步验证码', hint: '输入身份验证器中的 6 位验证码', secret: true },
    { pattern: /Phone number, E\.164 format \(p=quit\):\s*$/i, kind: 'phone', label: '手机号验证', hint: '输入 E.164 格式手机号，例如 +8613800000000' },
    { pattern: /Phone OTP \(r=resend, p=change phone, q=quit\):\s*$/i, kind: 'phone_otp', label: '短信验证码', hint: '输入短信验证码；r 重发，p 更换手机号', secret: true },
  ];
  return prompts.find((item) => item.pattern.test(text)) || null;
}

function validateProtocolInput(kind, value) {
  const input = String(value || '').trim();
  if (!input || input.length > 256 || /[\r\n\0]/.test(input)) throw new Error('输入内容无效');
  if (kind === 'email_otp' && !/^(?:\d{6}|r|q)$/i.test(input)) throw new Error('请输入 6 位邮箱验证码，或输入 r/q');
  if (kind === 'totp' && !/^(?:\d{6}|q)$/i.test(input)) throw new Error('请输入 6 位两步验证码，或输入 q');
  if (kind === 'phone' && !/^(?:\+[1-9]\d{6,14}|p|q)$/i.test(input)) throw new Error('请输入 E.164 格式手机号，或输入 p/q');
  if (kind === 'phone_otp' && !/^(?:\d{4,8}|r|p|q)$/i.test(input)) throw new Error('请输入短信验证码，或输入 r/p/q');
  return input;
}

function normalizeChromeCookies(cookies) {
  return cookies
    .filter((cookie) => cookie?.name && typeof cookie.value === 'string')
    .map((cookie) => {
      const normalized = {
        name: String(cookie.name),
        value: String(cookie.value),
        domain: String(cookie.domain || '').replace(/^\./, ''),
        path: String(cookie.path || '/'),
        secure: Boolean(cookie.secure),
        httpOnly: Boolean(cookie.httpOnly),
      };
      if (Number.isFinite(Number(cookie.expires)) && Number(cookie.expires) > 0) {
        const expires = Number(cookie.expires);
        normalized.expires = expires > 10_000_000_000 ? expires / 1000 : expires;
      }
      const sameSite = String(cookie.sameSite || '').toLowerCase();
      if (sameSite === 'strict') normalized.sameSite = 'Strict';
      else if (sameSite === 'lax') normalized.sameSite = 'Lax';
      else if (sameSite === 'none') normalized.sameSite = 'None';
      if (!normalized.domain) {
        delete normalized.domain;
        normalized.url = 'https://chatgpt.com/';
      }
      return normalized;
    });
}

function webSessionAuthenticated(value) {
  try {
    const session = typeof value === 'string' ? JSON.parse(value) : value;
    if (!session || typeof session !== 'object') return false;
    if (typeof session.accessToken === 'string' && session.accessToken.trim()) return true;
    return Boolean(session.user && typeof session.user === 'object'
      && (session.user.id || session.user.email || session.user.name));
  } catch {
    return false;
  }
}

function cdpCommand(socket, method, params = {}, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 2_000_000_000) + 1;
    const timer = setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error(`Chrome 调试命令超时：${method}`));
    }, timeoutMs);
    const onMessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(message.error.message || `${method} 执行失败`));
      else resolve(message.result || {});
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function openWebSocket(url, WebSocketImpl = globalThis.WebSocket) {
  if (typeof WebSocketImpl !== 'function') throw new Error('当前运行环境不支持 Chrome 调试连接');
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url);
    const timer = setTimeout(() => reject(new Error('连接账号 Chrome 超时')), 8_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接账号 Chrome')); }, { once: true });
  });
}

async function navigateProtocolPage({
  port,
  url,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
}) {
  const destination = new URL(String(url || ''));
  if (destination.protocol !== 'https:' || !['chatgpt.com', 'auth.openai.com'].includes(destination.hostname)) {
    throw new Error('拒绝打开非官方登录地址');
  }
  const targetsResponse = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
  if (!targetsResponse.ok) throw new Error(`无法读取账号 Chrome 页面（HTTP ${targetsResponse.status}）`);
  const targets = await targetsResponse.json();
  const target = targets.find((item) => item.type === 'page' && /^https:\/\/chatgpt\.com\//i.test(item.url))
    || targets.find((item) => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('账号 Chrome 没有可用页面');
  const socket = await openWebSocket(target.webSocketDebuggerUrl, WebSocketImpl);
  try {
    await cdpCommand(socket, 'Page.navigate', { url: destination.href });
  } finally {
    try { socket.close(); } catch {}
  }
}

async function readProtocolSubscription({
  port,
  accessToken = '',
  accountId = '',
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  closeBrowser = false,
  attempts = 8,
}) {
  const targetsResponse = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
  if (!targetsResponse.ok) throw new Error(`无法读取账号 Chrome 页面（HTTP ${targetsResponse.status}）`);
  const targets = await targetsResponse.json();
  const target = targets.find((item) => item.type === 'page' && /^https:\/\/chatgpt\.com\//i.test(item.url))
    || targets.find((item) => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('账号 Chrome 没有可用页面');
  const socket = await openWebSocket(target.webSocketDebuggerUrl, WebSocketImpl);
  try {
    let value = null;
    const retries = Math.max(1, Math.min(12, Math.round(Number(attempts) || 1)));
    const suppliedAccessToken = String(accessToken || '');
    const suppliedAccountId = String(accountId || '');
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 750));
      const evaluation = await cdpCommand(socket, 'Runtime.evaluate', {
        expression: `(async()=>{
          let accessToken=${JSON.stringify(suppliedAccessToken)};
          let accountId=${JSON.stringify(suppliedAccountId)};
          let session=null;
          if(!accessToken||!accountId){
            const sessionResponse=await fetch('/api/auth/session',{credentials:'include',cache:'no-store'});
            if(!sessionResponse.ok)return {ok:false,status:sessionResponse.status};
            session=await sessionResponse.json();
            accessToken=session?.accessToken||'';
            accountId=session?.account?.id||'';
          }
          if(!accessToken||!accountId)return {ok:false,status:401};
          const response=await fetch('/backend-api/accounts/check/v4-2023-04-27',{
            credentials:'include',cache:'no-store',headers:{
              Authorization:'Bearer '+accessToken,
              'ChatGPT-Account-Id':accountId
            }
          });
          if(!response.ok)return {ok:false,status:response.status};
          const payload=await response.json();
          const record=payload?.accounts?.[accountId];
          const entitlement=record?.entitlement;
          return {ok:true,planType:record?.account?.plan_type||session?.account?.planType||null,
            active:entitlement?.has_active_subscription===true,
            expiresAt:entitlement?.expires_at||null,
            renewsAt:entitlement?.renews_at||null,
            billingPeriod:entitlement?.billing_period||null};
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      value = evaluation?.result?.value || null;
      if (value?.ok) break;
    }
    if (!value?.ok) throw new Error(`自动读取套餐到期时间失败（HTTP ${value?.status || '未知'}）`);
    const expiresAtMs = Date.parse(value.expiresAt || '');
    const renewsAtMs = Date.parse(value.renewsAt || '');
    return {
      planType: value.planType ? String(value.planType) : null,
      active: value.active === true,
      expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
      renewsAt: Number.isFinite(renewsAtMs) ? new Date(renewsAtMs).toISOString() : null,
      billingPeriod: value.billingPeriod ? String(value.billingPeriod) : null,
    };
  } finally {
    if (closeBrowser) await closeChromeAndWait(socket);
    try { socket.close(); } catch {}
  }
}

function closeChromeAndWait(socket, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.addEventListener('close', finish, { once: true });
    try {
      socket.send(JSON.stringify({
        id: Math.floor(Math.random() * 2_000_000_000) + 1,
        method: 'Browser.close',
      }));
    } catch {
      finish();
    }
  });
}

async function injectProtocolCookies({
  port,
  cookies,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  allowHeadlessBlocked = false,
  allowUnauthenticated = false,
  closeBrowser = false,
  verificationDelayMs = 1_500,
  verificationAttempts = 3,
  navigationUrl = 'https://chatgpt.com/',
}) {
  const targetsResponse = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
  if (!targetsResponse.ok) throw new Error(`无法读取账号 Chrome 页面（HTTP ${targetsResponse.status}）`);
  const targets = await targetsResponse.json();
  const target = targets.find((item) => item.type === 'page' && /^https:\/\/chatgpt\.com\//i.test(item.url))
    || targets.find((item) => item.type === 'page' && /^https:\/\/auth\.openai\.com\//i.test(item.url))
    || targets.find((item) => item.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('账号 Chrome 没有可用页面');
  const socket = await openWebSocket(target.webSocketDebuggerUrl, WebSocketImpl);
  try {
    await cdpCommand(socket, 'Network.enable');
    const result = await cdpCommand(socket, 'Network.setCookies', { cookies: normalizeChromeCookies(cookies) });
    if (result.success === false) throw new Error('Chrome 拒绝写入网页会话');
    if (navigationUrl) await cdpCommand(socket, 'Page.navigate', { url: navigationUrl });
    let value = {};
    const attempts = Math.max(1, Math.min(10, Math.round(Number(verificationAttempts) || 1)));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
      const verification = await cdpCommand(socket, 'Runtime.evaluate', {
        expression: "fetch('/api/auth/session',{credentials:'include',cache:'no-store'}).then(async r=>({ok:r.ok,status:r.status,text:await r.text()}))",
        awaitPromise: true,
        returnByValue: true,
      });
      value = verification?.result?.value || {};
      if (value.ok && webSessionAuthenticated(value.text)) break;
    }
    const verified = Boolean(value.ok && webSessionAuthenticated(value.text));
    const deferred = !verified && allowHeadlessBlocked && Number(value.status) === 403;
    if (!verified && !deferred && !allowUnauthenticated) {
      throw new Error(`Chrome 网页会话验证失败（HTTP ${value.status || '未知'}）`);
    }
    if (closeBrowser) {
      await closeChromeAndWait(socket);
    }
    let session = null;
    if (verified) {
      try { session = JSON.parse(String(value.text || '')); } catch {}
    }
    return { verified, deferred, status: Number(value.status) || 0, session };
  } finally {
    try { socket.close(); } catch {}
  }
}

async function readProtocolCookies({
  port,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  closeBrowser = false,
}) {
  const targetsResponse = await fetchImpl(`http://127.0.0.1:${port}/json/list`);
  if (!targetsResponse.ok) throw new Error(`无法读取账号 Chrome 页面（HTTP ${targetsResponse.status}）`);
  const targets = await targetsResponse.json();
  const target = targets.find((item) => item.type === 'page') || targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('账号 Chrome 没有可用页面');
  const socket = await openWebSocket(target.webSocketDebuggerUrl, WebSocketImpl);
  try {
    await cdpCommand(socket, 'Network.enable');
    const result = await cdpCommand(socket, 'Network.getAllCookies');
    const cookies = normalizeChromeCookies(Array.isArray(result.cookies) ? result.cookies : []);
    if (closeBrowser) await closeChromeAndWait(socket);
    return cookies;
  } finally {
    try { socket.close(); } catch {}
  }
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createProtocolRunner({ runnerFile, executable, scriptFile, email, outputFile, checkpointFile, statusFile, packaged }) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$Host.UI.RawUI.WindowTitle = 'Codex Navo - 实验性协议登录'",
    "Write-Host 'Codex Navo 实验性协议登录' -ForegroundColor Cyan",
    "Write-Host '请根据提示完成密码、邮箱验证码、两步验证或手机号验证。'",
    "Write-Host '输入内容只传给当前登录进程，不会写入 Codex Navo 配置。'",
    '',
  ];
  if (packaged) lines.push("$env:ELECTRON_RUN_AS_NODE = '1'");
  lines.push("$env:NODE_USE_ENV_PROXY = '1'");
  lines.push("$env:NODE_NO_WARNINGS = '1'");
  const args = [
    quotePowerShell(executable),
    quotePowerShell(scriptFile),
    '--email', quotePowerShell(email),
    '--output-mode', 'sub2api',
    '--sub2api-out', quotePowerShell(outputFile),
    '--checkpoint', quotePowerShell(checkpointFile),
  ].join(' ');
  lines.push(`& ${args}`);
  lines.push('$code = $LASTEXITCODE');
  lines.push(`$status = if ($code -eq 0 -and (Test-Path -LiteralPath ${quotePowerShell(outputFile)})) { 'complete' } else { 'failed' }`);
  lines.push(`@{ status = $status; exitCode = $code; finishedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath ${quotePowerShell(statusFile)} -Encoding Ascii`);
  lines.push("if ($status -eq 'complete') { Write-Host '登录完成，Codex Navo 将自动完成入池。' -ForegroundColor Green } else { Write-Host '登录没有完成，可以关闭窗口后重试。' -ForegroundColor Yellow }");
  lines.push("Read-Host '按 Enter 关闭此窗口'");
  fs.mkdirSync(path.dirname(runnerFile), { recursive: true });
  fs.writeFileSync(runnerFile, `\uFEFF${lines.join('\r\n')}\r\n`, { mode: 0o600 });
}

module.exports = {
  createProtocolRunner,
  injectProtocolCookies,
  navigateProtocolPage,
  normalizeChromeCookies,
  readProtocolCookies,
  readProtocolSubscription,
  parseWindowsProxyServer,
  protocolPromptFromOutput,
  readProtocolOauthExport,
  readProtocolSession,
  resolveProtocolProxyEnvironment,
  validateProtocolInput,
  webSessionAuthenticated,
};

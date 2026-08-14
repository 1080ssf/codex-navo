#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(value || '').slice(0, 200);
  }
}

function readArgs() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : '';
  };
  return {
    profile: get('--profile'),
    port: Number(get('--port')) || 0,
    email: get('--email'),
    url: get('--url'),
    submit: args.includes('--submit'),
    durationMs: Math.max(3_000, Math.min(60_000, Number(get('--duration-ms')) || 20_000)),
  };
}

async function main() {
  const options = readArgs();
  if (!options.port && !options.profile) throw new Error('Missing --profile or --port');
  const activePort = options.port || fs.readFileSync(path.join(options.profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/)[0];
  const targets = await fetch(`http://127.0.0.1:${activePort}/json/list`).then((response) => response.json());
  const target = targets.find((item) => item.type === 'page' && /^https:\/\/(?:auth\.openai\.com|chatgpt\.com)\//.test(item.url));
  if (!target?.webSocketDebuggerUrl) throw new Error('OpenAI login target not found');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  const requests = new Map();
  const findings = [];

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  socket.addEventListener('message', async (event) => {
    let message;
    try { message = JSON.parse(String(event.data || '')); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result || {});
      return;
    }
    if (message.method === 'Network.requestWillBeSent') {
      requests.set(message.params.requestId, {
        url: message.params.request?.url || '',
        method: message.params.request?.method || 'GET',
        type: message.params.type || '',
      });
      return;
    }
    if (message.method === 'Network.loadingFailed') {
      const request = requests.get(message.params.requestId) || {};
      if (/auth\.openai\.com|chatgpt\.com/.test(request.url || '')) {
        findings.push({
          event: 'loadingFailed',
          method: request.method,
          url: redactUrl(request.url),
          type: message.params.type || request.type,
          errorText: message.params.errorText,
          blockedReason: message.params.blockedReason || '',
        });
      }
      return;
    }
    if (message.method !== 'Network.responseReceived') return;
    const request = requests.get(message.params.requestId) || {};
    const response = message.params.response || {};
    const url = response.url || request.url || '';
    if (!/auth\.openai\.com|chatgpt\.com/.test(url)) return;
    const contentType = String(response.headers?.['content-type'] || response.headers?.['Content-Type'] || response.mimeType || '');
    const type = message.params.type || request.type || '';
    if (!/^(Fetch|XHR)$/i.test(type) && response.status < 400) return;
    const finding = {
      event: 'response',
      method: request.method,
      url: redactUrl(url),
      type,
      status: response.status,
      contentType,
      remoteIPAddress: response.remoteIPAddress || '',
      fromServiceWorker: Boolean(response.fromServiceWorker),
    };
    if (/html/i.test(contentType) || response.status >= 400) {
      try {
        const bodyResult = await send('Network.getResponseBody', { requestId: message.params.requestId });
        const body = bodyResult.base64Encoded
          ? Buffer.from(bodyResult.body || '', 'base64').toString('utf8')
          : String(bodyResult.body || '');
        finding.bodyPrefix = body.replace(/\s+/g, ' ').slice(0, 240);
      } catch (error) {
        finding.bodyReadError = error.message;
      }
    }
    findings.push(finding);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  await send('Network.enable');
  await send('Runtime.enable');
  if (options.url) {
    await send('Page.enable');
    await send('Page.navigate', { url: options.url });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
  }
  const initial = await send('Runtime.evaluate', {
    expression: `JSON.stringify({url:location.href,title:document.title,webdriver:navigator.webdriver,userAgent:navigator.userAgent,text:(document.body?.innerText||'').slice(0,500),inputs:[...document.querySelectorAll('input')].map(x=>({type:x.type,name:x.name,autocomplete:x.autocomplete,placeholder:x.placeholder})),buttons:[...document.querySelectorAll('button')].map(x=>(x.innerText||x.textContent||'').trim()).filter(Boolean).slice(0,20)})`,
    returnByValue: true,
  });
  const page = JSON.parse(initial.result?.value || '{}');
  console.log(JSON.stringify({ page: { ...page, url: redactUrl(page.url) } }, null, 2));

  if (options.submit) {
    if (!options.email) throw new Error('Missing --email for --submit');
    const expression = `(() => {
      const input = document.querySelector('input[type="email"], input[name="email"], input[autocomplete="email"], input');
      if (!input) return {ok:false,reason:'email input not found'};
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(options.email)});
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
      const button = [...document.querySelectorAll('button')].find((item) => /continue|继续|下一步|登录/.test((item.innerText||item.textContent||'').trim()));
      if (!button) return {ok:false,reason:'continue button not found'};
      button.click();
      return {ok:true,button:(button.innerText||button.textContent||'').trim()};
    })()`;
    const submitted = await send('Runtime.evaluate', { expression, returnByValue: true });
    console.log(JSON.stringify({ submitted: submitted.result?.value || null }, null, 2));
  }

  await new Promise((resolve) => setTimeout(resolve, options.durationMs));
  const finalState = await send('Runtime.evaluate', {
    expression: `JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,900)})`,
    returnByValue: true,
  });
  const finalPage = JSON.parse(finalState.result?.value || '{}');
  console.log(JSON.stringify({ finalPage: { ...finalPage, url: redactUrl(finalPage.url) }, findings }, null, 2));
  socket.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

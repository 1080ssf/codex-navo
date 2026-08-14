'use strict';

function upstreamMessage(status, contentType, text) {
  const fallback = `上游请求失败（HTTP ${status}）`;
  const source = String(text || '').slice(0, 4096);
  if (/^\s*</.test(source)) return `${fallback}：上游返回了 HTML 页面`;
  if (String(contentType || '').toLowerCase().includes('json') || /^\s*[{[]/.test(source)) {
    try {
      const payload = JSON.parse(source);
      const message = payload?.error?.message || payload?.message || payload?.detail
        || (typeof payload?.error === 'string' ? payload.error : '');
      if (message) return String(message).replace(/[\r\n]/g, ' ').slice(0, 500);
    } catch {}
  }
  const plain = source.trim();
  return plain && plain.length <= 500 ? plain.replace(/[\r\n]/g, ' ') : fallback;
}

function requestShape(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  let hasBreakpoint = false;
  for (const item of input) {
    if (item?.prompt_cache_breakpoint) hasBreakpoint = true;
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.prompt_cache_breakpoint) hasBreakpoint = true;
    }
  }
  return {
    stream: body?.stream === true,
    store: body?.store === true,
    inputItems: input.length,
    hasCacheKey: Boolean(body?.prompt_cache_key),
    hasBreakpoint,
  };
}

module.exports = { requestShape, upstreamMessage };

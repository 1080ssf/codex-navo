'use strict';

const CODEX_UPSTREAM_HEADERS = new Map([
  ['session-id', 'Session-Id'],
  ['thread-id', 'Thread-Id'],
  ['x-client-request-id', 'X-Client-Request-Id'],
  ['x-codex-beta-features', 'X-Codex-Beta-Features'],
  ['x-codex-turn-metadata', 'X-Codex-Turn-Metadata'],
  ['x-codex-window-id', 'X-Codex-Window-Id'],
  ['x-openai-internal-codex-responses-lite', 'X-OpenAI-Internal-Codex-Responses-Lite'],
  ['originator', 'Originator'],
  ['user-agent', 'User-Agent'],
]);

function codexUpstreamHeaders(headers = {}) {
  const forwarded = {};
  for (const [source, destination] of CODEX_UPSTREAM_HEADERS) {
    const raw = headers[source];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string' || !value || value.length > 16_384 || /[\r\n]/.test(value)) continue;
    forwarded[destination] = value;
  }
  return forwarded;
}

module.exports = { CODEX_UPSTREAM_HEADERS, codexUpstreamHeaders };

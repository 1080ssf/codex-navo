'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { codexUpstreamHeaders } = require('../lib/codex-upstream-headers');

test('forwards Codex session and cache-routing headers without forwarding credentials', () => {
  const headers = codexUpstreamHeaders({
    authorization: 'Bearer local-secret',
    host: '127.0.0.1:18300',
    'content-length': '123',
    'session-id': 'session-a',
    'thread-id': 'thread-a',
    'x-client-request-id': 'request-a',
    'x-codex-beta-features': 'responses_websocket',
    'x-codex-turn-metadata': 'turn-data',
    'x-codex-window-id': 'window-a',
    'x-openai-internal-codex-responses-lite': 'true',
    originator: 'codex_cli_rs',
    'user-agent': 'codex_cli_rs/test',
  });
  assert.deepEqual(headers, {
    'Session-Id': 'session-a',
    'Thread-Id': 'thread-a',
    'X-Client-Request-Id': 'request-a',
    'X-Codex-Beta-Features': 'responses_websocket',
    'X-Codex-Turn-Metadata': 'turn-data',
    'X-Codex-Window-Id': 'window-a',
    'X-OpenAI-Internal-Codex-Responses-Lite': 'true',
    Originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/test',
  });
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Host, undefined);
});

test('drops invalid or oversized forwarded header values', () => {
  assert.deepEqual(codexUpstreamHeaders({
    'session-id': 'bad\r\nheader',
    'thread-id': 'x'.repeat(16_385),
  }), {});
});

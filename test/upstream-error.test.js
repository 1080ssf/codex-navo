'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { requestShape, upstreamMessage } = require('../lib/upstream-error');

test('extracts useful upstream errors from common response shapes', () => {
  assert.equal(upstreamMessage(400, 'application/json', '{"error":{"message":"Invalid field"}}'), 'Invalid field');
  assert.equal(upstreamMessage(400, 'application/json', '{"detail":"Bad request shape"}'), 'Bad request shape');
  assert.equal(upstreamMessage(502, 'text/html', '<html>gateway</html>'), '上游请求失败（HTTP 502）：上游返回了 HTML 页面');
});

test('reports only request structure and never prompt content', () => {
  const body = {
    stream: true, store: false, prompt_cache_key: 'thread-key',
    input: [{ role: 'developer', content: [{ type: 'input_text', text: 'private prompt' }] }],
  };
  const shape = requestShape(body);
  assert.deepEqual(shape, { stream: true, store: false, inputItems: 1, hasCacheKey: true, hasBreakpoint: false });
  assert.equal(JSON.stringify(shape).includes('private prompt'), false);
});

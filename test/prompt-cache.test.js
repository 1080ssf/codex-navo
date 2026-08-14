'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { preparePromptCacheRequest } = require('../lib/prompt-cache');

test('GPT-5.6 requests keep the native Codex cache shape without injected fields', () => {
  const body = {
    model: 'gpt-5.6-sol',
    input: [
      { type: 'additional_tools', role: 'developer', tools: ['shell'] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'stable instructions' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first question' }] },
    ],
  };
  const prepared = preparePromptCacheRequest(body, { keyId: 'key-1' });
  assert.deepEqual(prepared, body);
  assert.equal(prepared.prompt_cache_key, undefined);
  assert.equal(prepared.input[1].content[0].prompt_cache_breakpoint, undefined);
  assert.equal(body.input[1].content[0].prompt_cache_breakpoint, undefined);
  assert.notEqual(prepared, body);
});

test('existing cache keys and unsupported request shapes remain intact', () => {
  const existing = { model: 'gpt-5.6-terra', prompt_cache_key: 'thread-key', input: [{ role: 'user', content: [] }] };
  assert.deepEqual(preparePromptCacheRequest(existing, { keyId: 'key-1' }), existing);
  const older = { model: 'gpt-5.5', input: [{ role: 'developer', content: [{ type: 'input_text', text: 'x' }] }] };
  assert.deepEqual(preparePromptCacheRequest(older, { keyId: 'key-1' }), older);
});

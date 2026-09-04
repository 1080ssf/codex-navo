const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isModelCompatibilityError,
  normalizeUsage,
  parseWakeJsonl,
  wakeFailureMessage,
} = require('../lib/wake-command');

test('Codex JSONL wake requires a completed turn, agent message, and output tokens', () => {
  const result = parseWakeJsonl([
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 110, cached_input_tokens: 90, output_tokens: 4, reasoning_output_tokens: 1 },
    }),
  ].join('\n'));
  assert.equal(result.verified, true);
  assert.equal(result.threadId, 'thread-test');
  assert.deepEqual(result.usage, {
    inputTokens: 110,
    cachedInputTokens: 90,
    outputTokens: 4,
    reasoningOutputTokens: 1,
    totalTokens: 114,
  });
});

test('exit success without a real completed response is not accepted as a wake', () => {
  const result = parseWakeJsonl(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
  assert.equal(result.verified, false);
  assert.match(wakeFailureMessage({ code: 0, parsed: result }), /校验失败/);
});

test('failed events and zero-token completions cannot produce false success', () => {
  const failed = parseWakeJsonl([
    JSON.stringify({ type: 'error', message: 'upstream unavailable' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'request failed' } }),
  ].join('\n'));
  assert.equal(failed.verified, false);
  assert.deepEqual(failed.errors, ['upstream unavailable', 'request failed']);

  const empty = parseWakeJsonl([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 0 } }),
  ].join('\n'));
  assert.equal(empty.verified, false);
});

test('usage field variants and account-model fallback detection are normalized safely', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 8, cachedInputTokens: 5, outputTokens: 2 }), {
    inputTokens: 8,
    cachedInputTokens: 5,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens: 10,
  });
  assert.equal(isModelCompatibilityError('The account does not have access to model gpt-test'), true);
  assert.equal(isModelCompatibilityError('network connection timed out'), false);
});

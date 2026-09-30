const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateCost } = require('../lib/codex-usage');
test('GPT-6 standard pricing handles cached input and cache writes', () => {
  const usage = { input: 100000, cachedInput: 50000, cacheWriteInput: 10000, output: 10000 };
  assert.equal(estimateCost('gpt-6-sol', usage), .215);
  assert.equal(estimateCost('gpt-6-luna', usage), .01075);
  assert.equal(estimateCost('gpt-6-unknown', usage), null);
});
test('GPT-6 long context prices apply above 272K', () => {
  const usage = { input: 300000, cachedInput: 0, cacheWriteInput: 0, output: 10000 };
  assert.equal(estimateCost('gpt-6-sol', usage), 1.35);
  assert.equal(estimateCost('gpt-6-luna', usage), .0675);
});

test('GPT-6.1 Sol uses its own 5% cache price and retains the older Sol rate', () => {
  const usage = { input: 100000, cachedInput: 50000, cacheWriteInput: 10000, output: 10000 };
  assert.equal(estimateCost('gpt-6.1-sol', usage), .21);
  assert.equal(estimateCost('gpt-6-sol', usage), .215);
  assert.equal(estimateCost('openai/gpt-6.1-sol', usage), .21);
  assert.equal(estimateCost('gpt-6.1-sol-2026-09-30', usage), .21);
  assert.equal(estimateCost('gpt-6.1-sol-unknown', usage), null);
  assert.equal(estimateCost('gpt-6.1-astra', usage), null);
  assert.equal(estimateCost('gpt-6.1-sol', { ...usage, input: 300000 }), 1.17);
});

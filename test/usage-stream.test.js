'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createUsageTap } = require('../lib/usage-stream');

test('stream usage tap records the completed Responses usage without changing SSE bytes', async () => {
  const source = 'data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3}}}\n\n';
  let usage;
  const output = [];
  await new Promise((resolve, reject) => Readable.from([source.slice(0, 47), source.slice(47)])
    .pipe(createUsageTap((value) => { usage = value; }))
    .on('data', (chunk) => output.push(chunk)).on('end', resolve).on('error', reject));
  assert.equal(Buffer.concat(output).toString(), source);
  assert.deepEqual(usage, { inputTokens: 12, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0 });
});

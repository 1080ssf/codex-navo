'use strict';

const { Transform } = require('node:stream');
const { extractUsage } = require('./api-service');

function createUsageTap(onUsage) {
  let pending = '';
  let recorded = false;
  const inspect = (block) => {
    if (recorded) return;
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const usage = extractUsage(JSON.parse(data));
        if (usage.inputTokens || usage.outputTokens || usage.cachedInputTokens || usage.reasoningOutputTokens) {
          recorded = true;
          onUsage(usage);
        }
      } catch {}
    }
  };
  return new Transform({
    transform(chunk, _encoding, callback) {
      const value = Buffer.from(chunk);
      pending += value.toString('utf8');
      const blocks = pending.split(/\r?\n\r?\n/);
      pending = blocks.pop() || '';
      for (const block of blocks) inspect(block);
      callback(null, value);
    },
    flush(callback) { inspect(pending); callback(); },
  });
}

module.exports = { createUsageTap };

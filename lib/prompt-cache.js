'use strict';

function isGpt56Model(model) {
  return /^gpt-5\.6(?:-|$)/i.test(String(model || '').trim());
}

function stableDeveloperPrefix(input) {
  if (!Array.isArray(input)) return [];
  const prefix = [];
  for (const item of input) {
    if (item?.type === 'additional_tools' || item?.role === 'developer' || item?.role === 'system') {
      prefix.push(item);
      continue;
    }
    break;
  }
  return prefix;
}

function lastInputText(prefix) {
  for (let itemIndex = prefix.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const content = prefix[itemIndex]?.content;
    if (!Array.isArray(content)) continue;
    for (let contentIndex = content.length - 1; contentIndex >= 0; contentIndex -= 1) {
      if (content[contentIndex]?.type === 'input_text') return content[contentIndex];
    }
  }
  return null;
}

function preparePromptCacheRequest(body, { keyId = '', model = '' } = {}) {
  // Compatibility helper kept for callers outside the gateway. The native
  // Codex request already carries its cache key; do not synthesize fields that
  // the ChatGPT Codex backend may reject.
  void keyId;
  void model;
  return structuredClone(body || {});
}

module.exports = { isGpt56Model, preparePromptCacheRequest, stableDeveloperPrefix };

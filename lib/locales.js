'use strict';

const CODEX_LOCALES = Object.freeze([
  ['en-US', 'English'],
  ['zh-CN', '简体中文'],
].map(([id, label]) => Object.freeze({ id, label })));

const SUPPORTED_LOCALES = new Set(CODEX_LOCALES.map((item) => item.id));

function resolveLocale(value, fallback = 'en-US') {
  const candidate = String(value || '').trim();
  if (SUPPORTED_LOCALES.has(candidate)) return candidate;
  return candidate.toLowerCase().startsWith('zh') ? 'zh-CN' : fallback;
}

module.exports = { CODEX_LOCALES, SUPPORTED_LOCALES, resolveLocale };

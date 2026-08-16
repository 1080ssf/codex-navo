'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CODEX_LOCALES, resolveLocale } = require('../lib/locales');

test('Navo and Codex language catalog exposes English and Simplified Chinese only', () => {
  assert.deepEqual(CODEX_LOCALES.map((item) => item.id), ['en-US', 'zh-CN']);
});

test('system locale resolution preserves known locales and maps language families', () => {
  assert.equal(resolveLocale('zh-SG'), 'zh-CN');
  assert.equal(resolveLocale('en-GB'), 'en-US');
  assert.equal(resolveLocale('pt-BR'), 'en-US');
  assert.equal(resolveLocale('zh-TW'), 'zh-CN');
});

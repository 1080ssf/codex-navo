'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CODEX_LOCALES, resolveLocale } = require('../lib/locales');

test('Codex locale catalog covers installed desktop translations', () => {
  assert.ok(CODEX_LOCALES.length >= 60);
  for (const locale of ['en-US', 'zh-CN', 'zh-HK', 'zh-TW', 'ja-JP', 'de-DE', 'fr-FR', 'es-ES']) {
    assert.ok(CODEX_LOCALES.some((item) => item.id === locale));
  }
});

test('system locale resolution preserves known locales and maps language families', () => {
  assert.equal(resolveLocale('zh-SG'), 'zh-CN');
  assert.equal(resolveLocale('en-GB'), 'en-US');
  assert.equal(resolveLocale('pt-BR'), 'pt-BR');
});

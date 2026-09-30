const test = require('node:test');
const assert = require('node:assert/strict');
const { configFunctions } = require('./helpers/codex-api-config');
const { chatgptConfig } = require('../lib/codex-launch-auth');

test('API launch enables the native image extension without changing API identity or destination', () => {
  const config = configFunctions(18300).build('', 'gpt-6-astra', 'fixture-launch-key');
  assert.match(config, /model_provider = "codex_navo"/);
  assert.match(config, /forced_login_method = "api"/);
  assert.match(config, /requires_openai_auth = false/);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:18300\/v1"/);
  assert.match(config, /http_headers = \{ "x-openai-actor-authorization" = "Bearer fixture-launch-key" \}/);
  assert.doesNotMatch(config, /name = "OpenAI"|api\.openai\.com/);
  assert.doesNotMatch(chatgptConfig(config), /actor-authorization|fixture-launch-key/);
});

test('API relaunch replaces stale provider header subtables and cleanup keeps unrelated config', () => {
  const { build, restore } = configFunctions();
  const original = [
    '[features]', 'custom_feature = true',
    '[model_providers.codex_navo] # prior launch', 'name = "old"',
    '[model_providers.codex_navo.http_headers]', '"x-openai-actor-authorization" = "Bearer stale"',
    '[model_providers.other]', 'name = "Other"', '[model_providers.other.http_headers]', '"x-custom" = "keep"',
  ].join('\n');
  const config = build(original, 'gpt-6-astra', 'new-fixture-key');
  assert.doesNotMatch(config, /stale|\[model_providers.codex_navo.http_headers\]/);
  assert.equal((config.match(/x-openai-actor-authorization/g) || []).length, 1);
  const second = build(config, 'gpt-6-astra', 'second-fixture-key');
  assert.doesNotMatch(second, /new-fixture-key/);
  assert.equal((second.match(/x-openai-actor-authorization/g) || []).length, 1);
  const restored = restore(second);
  assert.doesNotMatch(restored, /codex_navo|actor-authorization|second-fixture-key/);
  assert.match(restored, /custom_feature = true/);
  assert.match(restored, /\[model_providers.other.http_headers\]/);
  assert.match(restored, /"x-custom" = "keep"/);
});

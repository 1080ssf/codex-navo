'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readModelCatalog } = require('../lib/model-catalog');

test('stale Codex model cache keeps GPT-6 Astra and GPT-6.1 Sol in the Navo catalog', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-model-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.json');
  fs.writeFileSync(file, JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol' }] }));
  const models = readModelCatalog([file]);
  assert.ok(models.some((model) => model.slug === 'gpt-6-astra'));
  assert.equal(models.find((model) => model.slug === 'gpt-6.1-sol').defaultReasoningEffort, 'medium');
});

test('live cache capabilities win and explicitly hidden models are not resurrected by fallback', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-model-catalog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.json');
  fs.writeFileSync(file, JSON.stringify({ models: [
    { slug: 'gpt-6.1-sol', display_name: 'Sol', default_reasoning_level: 'high', supported_reasoning_levels: [{ effort: 'high' }] },
    { slug: 'gpt-6-astra', visibility: 'hide' },
    { slug: 'future-model', display_name: 'Future' },
  ] }));
  const models = readModelCatalog([file]);
  assert.equal(models.filter((model) => model.slug === 'gpt-6.1-sol').length, 1);
  assert.deepEqual(models.find((model) => model.slug === 'gpt-6.1-sol').reasoningEfforts, ['high']);
  assert.ok(!models.some((model) => model.slug === 'gpt-6-astra'));
  assert.ok(models.some((model) => model.slug === 'future-model'));
});

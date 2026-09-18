const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/floating.js'), 'utf8');
const fn = source.slice(source.indexOf('function floatingAccountBadge('), source.indexOf('\nfunction applyLocale('));
const context = vm.createContext({ t: key => key });
vm.runInContext(fn, context);
test('floating badge shows the returned subscription without guessing Pro multipliers', () => {
  const badge = planType => context.floatingAccountBadge({ type: 'account', planType });
  assert.equal(badge('free'), 'FREE');
  assert.equal(badge('plus'), 'Plus');
  assert.equal(badge('pro'), 'Pro');
  assert.equal(badge('ProX5'), 'Pro×5');
  assert.equal(badge('pro_x20'), 'Pro×20');
  assert.equal(badge('self_serve_business_prolite'), 'Business×5');
  assert.equal(badge('business'), 'Business');
  assert.equal(badge(null), 'account');
  assert.equal(badge('unknown'), 'account');
  assert.equal(context.floatingAccountBadge({ type: 'api', planType: 'plus' }), 'API CODEX');
  assert.equal(context.floatingAccountBadge({ type: 'external' }), 'external');
});

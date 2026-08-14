const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { I18N_LAYER_ID, desktopLocaleBootstrapScript } = require('../lib/codex-desktop-locale');

test('Chinese desktop locale enables the bundled Codex translation layer', () => {
  const script = desktopLocaleBootstrapScript('zh-CN');
  assert.match(script, new RegExp(I18N_LAYER_ID));
  assert.match(script, /key === 'enable_i18n'\) return true/);
  assert.match(script, /key === 'locale_source'\) return 'IDE'/);
  assert.match(script, /values_updated/);
});

test('English desktop locale keeps the Codex default feature evaluation', () => {
  assert.equal(desktopLocaleBootstrapScript('en-US'), 'void 0;');
});

test('Chinese locale bridge overrides only the Codex i18n layer', () => {
  const events = [];
  const client = {
    loadingStatus: 'Ready',
    getLayer(name) {
      return { get: (key, fallback) => `${name}:${key}:${fallback}` };
    },
    $emt(event) { events.push(event); },
  };
  const timers = [];
  vm.runInNewContext(desktopLocaleBootstrapScript('zh-CN'), {
    Symbol,
    globalThis: { __STATSIG__: { instances: { primary: client } } },
    clearInterval() {},
    setInterval(callback) { timers.push(callback); return 1; },
    setTimeout() { return 2; },
  });
  assert.equal(client.getLayer(I18N_LAYER_ID).get('enable_i18n', false), true);
  assert.equal(client.getLayer(I18N_LAYER_ID).get('locale_source', 'SYSTEM'), 'IDE');
  assert.equal(client.getLayer('another-layer').get('enable_i18n', false), 'another-layer:enable_i18n:false');
  assert.equal(events[0].name, 'values_updated');
});

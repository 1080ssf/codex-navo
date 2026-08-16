const test = require('node:test');
const assert = require('node:assert/strict');
const { readDebugPortFile, resolveChromeDebugPort } = require('../lib/browser-debug-session');

test('debug port reader accepts only a valid TCP port from the first line', () => {
  const fsImpl = { readFileSync: () => '24821\n/devtools/browser/example\n' };
  assert.equal(readDebugPortFile('DevToolsActivePort', fsImpl), 24821);
  assert.equal(readDebugPortFile('DevToolsActivePort', { readFileSync: () => 'invalid' }), 0);
});

test('account browser rebinds when Chrome replaces the original debug port', async () => {
  const browser = { port: 6166, debugUnavailableSince: 123 };
  const checked = [];
  const port = await resolveChromeDebugPort({
    browser,
    activePortFile: 'DevToolsActivePort',
    fsImpl: { readFileSync: () => '18432\n' },
    isPortReady: async (candidate) => {
      checked.push(candidate);
      return candidate === 18432;
    },
  });
  assert.equal(port, 18432);
  assert.equal(browser.port, 18432);
  assert.equal(browser.debugUnavailableSince, 0);
  assert.deepEqual(checked, [6166, 18432]);
});

test('temporary endpoint loss is timestamped without discarding the browser session', async () => {
  const browser = { port: 6166 };
  const port = await resolveChromeDebugPort({
    browser,
    activePortFile: 'DevToolsActivePort',
    fsImpl: { readFileSync: () => '6166\n' },
    isPortReady: async () => false,
    now: () => 50_000,
  });
  assert.equal(port, 0);
  assert.equal(browser.port, 6166);
  assert.equal(browser.debugUnavailableSince, 50_000);
});

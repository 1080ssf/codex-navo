const test = require('node:test');
const assert = require('node:assert/strict');
const { selectNewestCli } = require('../lib/codex-cli-selection');

test('CLI selection uses the newest working version rather than npm priority or file date', () => {
  const versions = { npm: [0, 144, 5], desktop: [0, 153, 4], old: [0, 99, 9] };
  assert.equal(selectNewestCli(['npm', 'desktop', 'old'], (file) => versions[file]), 'desktop');
  assert.equal(selectNewestCli(['desktop', 'npm'], (file) => file === 'npm' ? [1, 0, 0] : versions[file]), 'npm');
});

test('CLI selection skips broken binaries and reports when none work', () => {
  assert.equal(selectNewestCli(['broken', 'working'], (file) => {
    if (file === 'broken') throw new Error('blocked');
    return [0, 153, 4];
  }), 'working');
  assert.throws(() => selectNewestCli(['broken'], () => null), /No working stable/);
});

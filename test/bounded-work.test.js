const test = require('node:test');
const assert = require('node:assert/strict');
const { settledMap } = require('../lib/bounded-work');
test('background work is bounded, ordered and continues after one failure', async () => {
  let active = 0;
  let maximum = 0;
  const results = await settledMap([0, 1, 2, 3, 4], 2, async (value) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    if (value === 2) throw new Error('offline');
    return value;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(results.map((item) => item.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(results[4].value, 4);
  assert.deepEqual(await settledMap([], 2, () => {}), []);
});

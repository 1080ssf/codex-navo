const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('account cooldown handles absent, numeric and HTTP-date Retry-After', () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf('function coolDownAccountPoolEntry(');
  const end = source.indexOf('\nfunction accountPoolHealth(', start);
  const now = Date.parse('2026-09-26T00:00:00Z');
  const cooldowns = new Map();
  class Clock extends Date { static now() { return now; } }
  const fn = vm.runInNewContext(`(${source.slice(start, end)})`, { Date: Clock, accountPoolCooldowns: cooldowns });
  for (const [status, header, expected] of [
    [429, null, 60000], [429, '', 60000], [429, 'bad', 60000],
    [429, '120', 120000], [429, 'Sat, 26 Sep 2026 00:02:00 GMT', 120000],
    [503, null, 15000], [429, '99999', 300000],
  ]) {
    fn('fixture', { status, headers: new Headers(header == null ? {} : { 'retry-after': header }) });
    assert.equal(cooldowns.get('fixture') - now, expected);
  }
});

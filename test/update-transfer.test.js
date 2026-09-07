const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const start = source.indexOf('function formatUpdateTransfer(');
const end = source.indexOf('\nasync function refreshCodexUpdateState', start);
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);
test('transfer display provides ETA only with usable size and speed', () => {
  const format = context.formatUpdateTransfer;
  assert.match(format({ bytesDownloaded: 1048576, totalBytes: 3145728, bytesPerSecond: 1048576 }), /1.0 MB \/ 3.0 MB · 1.0 MB\/s · ETA 0:02/);
  assert.doesNotMatch(format({ bytesDownloaded: 1, bytesPerSecond: 2 }), /ETA/);
  assert.doesNotMatch(format({ bytesDownloaded: 1, totalBytes: 10, bytesPerSecond: Infinity }), /ETA|Infinity|NaN/);
  assert.equal(format({ bytesDownloaded: NaN }), '');
});

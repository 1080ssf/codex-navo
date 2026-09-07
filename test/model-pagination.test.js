const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function modelService(pages) {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => { child.killed = true; child.exitCode = 0; child.emit('exit', 0); };
  child.stdin = { write(line) {
    const request = JSON.parse(line);
    if (!request.id) return;
    const result = request.method === 'initialize' ? {} : pages[requests.push(request.params) - 1];
    queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: request.id, result })}\n`));
  } };
  const context = { module: { exports: {} }, process, setTimeout, clearTimeout,
    require: (name) => name === 'node:child_process' ? { spawn: () => child } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-quota.js'), 'utf8'), context);
  return { read: () => context.module.exports.readCodexModels('fake', 'fake', 1000), requests };
}

test('model detection includes later pages and deduplicates models', async () => {
  const service = modelService([
    { data: [{ id: 'gpt-5.6-sol' }], nextCursor: 'page-2' },
    { data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-6-astra' }], nextCursor: null },
  ]);
  assert.deepEqual(Array.from(await service.read(), (model) => model.id), ['gpt-5.6-sol', 'gpt-6-astra']);
  assert.equal(service.requests[1].cursor, 'page-2');
  assert.equal(service.requests[1].includeHidden, false);
});

test('model detection rejects repeated cursors instead of looping or returning a partial catalog', async () => {
  const service = modelService([
    { data: [{ id: 'gpt-5.6-sol' }], nextCursor: 'repeat' },
    { data: [], nextCursor: 'repeat' },
  ]);
  await assert.rejects(service.read(), /repeated pagination cursor/);
  assert.equal(service.requests.length, 2);
});

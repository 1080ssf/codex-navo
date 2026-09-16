const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const file = path.join(__dirname, '../lib/account-network.js');
const source = fs.readFileSync(file, 'utf8');
function runtime(name, port = 18302) {
  return { groupName: name, mixedPort: port,
    child: { killed: false, exitCode: null, kill() { this.killed = true; } } };
}

function harness() {
  const context = vm.createContext({ require: createRequire(file), module: { exports: {} }, process,
    probeFixture: async () => ({ ok: true, status: 'available', latencyMs: 10, connectLatencyMs: 5 }),
  });
  vm.runInContext(`${source}\nprobeChatGpt = (...args) => probeFixture(...args); probeChatGptWithRetry = (...args) => probeFixture(...args);`, context);
  const manager = Object.create(context.module.exports.AccountNetworkManager.prototype);
  manager.data = { sources: [{ id: 'sample', nodes: [
    { name: 'Tokyo', status: 'available', connectDelay: 10 },
    { name: 'Singapore', status: 'available', connectDelay: 20 },
  ] }], assignments: {} };
  manager.taskRuntime = Object.assign(runtime('background'), { sourceId: 'sample', nodeName: 'Tokyo' });
  manager.taskRuntimePromise = null;
  manager.taskRuntimeGeneration = 0;
  manager.accountRuntimes = new Map([['other-account', runtime('account', 18303)]]);
  manager.sourceTestProgress = new Map();
  manager.save = () => {};
  const tests = [];
  manager.startRuntime = async (name) => { const value = runtime(name, 18304 + tests.length); tests.push(value); return value; };
  manager.waitForProviderNodes = async () => manager.data.sources[0].nodes;
  manager.request = async () => ({});
  return { context, manager, tests };
}

test('single-node success and failure dispose only their own probe core', async () => {
  for (const fail of [false, true]) {
    const { context, manager, tests } = harness();
    const background = manager.taskRuntime;
    const pending = Promise.resolve(background);
    manager.taskRuntimePromise = pending;
    if (fail) context.probeFixture = async () => { throw new Error('mock node unavailable'); };
    const result = await manager.testNode('sample', 'Tokyo');
    assert.equal(result.ok, !fail);
    assert.equal(manager.taskRuntime, background);
    assert.equal(manager.taskRuntimePromise, pending);
    assert.equal(background.child.killed, false);
    assert.equal(manager.accountRuntimes.get('other-account').child.killed, false);
    assert.equal(tests.length, 1);
    assert.equal(tests[0].child.killed, true);
  }
});

test('batch checking statuses and completed measurements never tear down an active transfer route', async () => {
  const { context, manager, tests } = harness();
  const background = manager.taskRuntime;
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const start = new Promise((resolve) => { started = resolve; });
  context.probeFixture = async () => { started(); await gate; return { ok: true, status: 'available', latencyMs: 1, connectLatencyMs: 1 }; };
  const pending = manager.testSource('sample', 2);
  await start;
  assert.equal(manager.data.sources[0].nodes.every((node) => node.status === 'checking'), true);
  assert.equal(await manager.ensureTask(), background);
  assert.equal(background.child.killed, false);
  release();
  const summary = await pending;
  assert.equal(summary.available, 2);
  assert.equal(tests.every((item) => item.child.killed), true);
  // Force a different best node: latency observation alone must not switch a
  // proxy endpoint already held by a download or quota request.
  manager.data.sources[0].nodes[0].status = 'connection-failed';
  assert.equal(await manager.ensureTask(), background);
  assert.equal(background.child.killed, false);
  assert.equal(manager.accountRuntimes.get('other-account').child.killed, false);
  assert.equal(manager.sourceTestProgress.size, 0);
});

test('failed batch workers clean up independent runtimes without killing the shared route', async () => {
  const { manager, tests } = harness();
  const background = manager.taskRuntime;
  manager.waitForProviderNodes = async () => { throw new Error('mock provider failed'); };
  await assert.rejects(manager.testSource('sample', 2), /mock provider failed/);
  assert.equal(tests.length, 2);
  assert.equal(tests.every((item) => item.child.killed), true);
  assert.equal(background.child.killed, false);
  assert.equal(manager.taskRuntime, background);
  assert.equal(manager.sourceTestProgress.size, 0);
});

test('configuration invalidation cannot resurrect an old pending task core or erase a new flight', async () => {
  const { manager } = harness();
  manager.stopTask();
  let releaseOld;
  let releaseNew;
  const oldRuntime = runtime('old');
  const newRuntime = runtime('new');
  let starts = 0;
  manager.startRuntime = () => ++starts === 1
    ? new Promise((resolve) => { releaseOld = () => resolve(oldRuntime); })
    : new Promise((resolve) => { releaseNew = () => resolve(newRuntime); });
  const oldFlight = manager.ensureTask();
  manager.stopTask();
  const newFlight = manager.ensureTask();
  const storedNewFlight = manager.taskRuntimePromise;
  releaseOld();
  await assert.rejects(oldFlight, /配置已变化/);
  assert.equal(oldRuntime.child.killed, true);
  assert.equal(manager.taskRuntimePromise, storedNewFlight);
  releaseNew();
  assert.equal(await newFlight, newRuntime);
  assert.equal(newRuntime.child.killed, false);
  assert.equal(manager.taskRuntime, newRuntime);
  assert.equal(manager.taskRuntimePromise, null);
});

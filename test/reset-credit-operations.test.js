const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ResetCreditOperations } = require('../lib/reset-credit-operations');
const { normalizeResetCredits } = require('../lib/codex-quota');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function mockService(reply) {
  const requests = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.exitCode = null; child.signalCode = null;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
  child.stdin.write = (line) => {
    const request = JSON.parse(line); requests.push(request);
    if (!request.id) return;
    const result = request.id === 1 ? {} : reply;
    if (result !== undefined) queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: request.id, result })}\n`));
  };
  const context = { module: { exports: {} }, process, setTimeout, clearTimeout,
    require: (name) => name === 'node:child_process' ? { spawn: () => child } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/codex-quota.js'), 'utf8'), context);
  return { requests, consume: (options) => context.module.exports.consumeCodexResetCredit('fake', 'isolated-home', options) };
}

test('consume initializes once, pins credit and accepts idempotent outcome', async () => {
  const service = mockService({ outcome: 'alreadyRedeemed' });
  const result = await service.consume({ idempotencyKey: 'same-key', creditId: 'one' });
  assert.equal(result.outcome, 'alreadyRedeemed');
  const requests = service.requests.filter((item) => item.method === 'account/rateLimitResetCredit/consume');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.creditId, 'one');
  assert.equal(requests[0].params.idempotencyKey, 'same-key');
});

test('consume timeout is unknown and never retries automatically', async () => {
  const service = mockService(undefined);
  await assert.rejects(service.consume({ idempotencyKey: 'one', timeoutMs: 20 }), (error) => error.code === 'RESET_CREDIT_TIMEOUT' && error.outcomeUnknown);
  assert.equal(service.requests.filter((item) => item.id === 2).length, 1);
});

test('reset credit count is authoritative and absent details stay unknown', () => {
  assert.equal(normalizeResetCredits({ availableCount: 2, credits: null }).credits, null);
  assert.deepEqual(normalizeResetCredits({ availableCount: 0, credits: [] }).credits, []);
  const result = normalizeResetCredits({ availableCount: 3, credits: [{ id: 'one', expiresAt: 1784246400 }] });
  assert.equal(result.availableCount, 3);
  assert.equal(result.credits.length, 1);
  assert.equal(result.expiresAt, new Date(1784246400000).toISOString());
});

test('unknown result survives restart with same key and refuses another card', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const filename = path.join(dir, 'operations.json');
  const first = new ResetCreditOperations(filename);
  let key;
  await assert.rejects(first.run('a', 'card', async (params) => { key = params.idempotencyKey; throw new Error('timeout'); }), /timeout/);
  const restarted = new ResetCreditOperations(filename);
  await assert.rejects(restarted.run('a', 'other', async () => assert.fail()), /pending/);
  const result = await restarted.run('a', 'card', async (params) => {
    assert.equal(params.idempotencyKey, key);
    return { outcome: 'alreadyRedeemed' };
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.outcome, 'alreadyRedeemed');
});

test('same-account concurrent clicks send one request and corrupt journal fails closed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const filename = path.join(dir, 'operations.json');
  const operations = new ResetCreditOperations(filename);
  let count = 0;
  const consume = async () => { count++; return { outcome: 'reset' }; };
  await Promise.all([operations.run('a', null, consume), operations.run('a', null, consume)]);
  assert.equal(count, 1);
  fs.writeFileSync(filename, '{');
  await assert.rejects(operations.run('b', null, consume));
  assert.equal(count, 1);
});

test('completed HTTP response replay cannot consume another card, even after a newer operation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const filename = path.join(dir, 'operations.json');
  const firstId = '11111111-1111-4111-8111-111111111111';
  const secondId = '22222222-2222-4222-8222-222222222222';
  let calls = 0;
  const consume = async () => { calls++; return { outcome: 'reset' }; };
  await new ResetCreditOperations(filename).run('a', null, consume, firstId);
  await new ResetCreditOperations(filename).run('a', null, consume, firstId);
  assert.equal(calls, 1);
  const restarted = new ResetCreditOperations(filename);
  await assert.rejects(restarted.run('a', 'changed', consume, firstId), /selection/);
  await restarted.run('a', null, consume, secondId);
  assert.equal(restarted.get('a').clientOperationId, secondId);
  assert.equal(restarted.get('a', firstId).clientOperationId, firstId);
  await restarted.run('a', null, consume, firstId);
  assert.equal(calls, 2);
});

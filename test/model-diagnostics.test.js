const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { classifyFailure, inspectProbeResponse, ModelDiagnostics } = require('../lib/model-diagnostics');

const tick = () => new Promise((resolve) => setImmediate(resolve));
function sse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}
async function finished(manager, id) {
  for (let i = 0; i < 100; i += 1) {
    const job = manager.view(id);
    if (job.status !== 'running') return job;
    await tick();
  }
  assert.fail('Job failed to finish');
}

test('HTTP 200 SSE error is not available; status and retry headers classify failures', async () => {
  const result = await inspectProbeResponse(sse([{ type: 'response.failed', response: { error: { code: 'usage_limit_reached' } } }]));
  assert.equal(result.state, 'quota_exhausted');
  assert.equal(result.httpStatus, 429);
  assert.equal(classifyFailure(503).state, 'service_unavailable');
  assert.equal(classifyFailure(401).state, 'authentication_required');
  assert.equal(classifyFailure(0, { code: 'CERT_HAS_EXPIRED' }).state, 'tls_error');
  assert.equal(classifyFailure(0, { code: 'TimeoutError' }).state, 'timeout');
  const limited = await inspectProbeResponse(new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after': '12' } }));
  assert.equal(limited.state, 'rate_limited');
  assert.ok(Date.parse(limited.retryAt) > Date.now() + 10000);
});

test('only completed event confirms success; delta alone and incomplete remain incomplete', async () => {
  const usage = { input_tokens: 22, output_tokens: 1 };
  const recorded = [];
  const complete = await inspectProbeResponse(sse([
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.completed', response: { status: 'completed', usage } },
  ]), { onUsage: (value) => recorded.push(value) });
  assert.equal(complete.state, 'available');
  assert.equal(typeof complete.firstOutputMs, 'number');
  assert.deepEqual(recorded, [usage]);
  assert.equal((await inspectProbeResponse(sse([{ type: 'response.output_text.delta', delta: 'OK' }]))).state, 'incomplete');
  assert.equal((await inspectProbeResponse(sse([{ type: 'response.incomplete', response: { status: 'incomplete' } }]))).state, 'incomplete');
});

test('probe ledger retains earlier usage and records the actual returned model', async () => {
  const usage = { input_tokens: 25, output_tokens: 2 };
  const recorded = [];
  const result = await inspectProbeResponse(sse([
    { type: 'response.created', response: { model: 'actual-model', usage } },
    { type: 'response.output_text.delta', delta: 'OK' },
    { type: 'response.completed', response: { status: 'completed' } },
  ]), { expectedModel: 'requested-model', onUsage: (...args) => recorded.push(args) });
  assert.equal(result.state, 'model_mismatch');
  assert.deepEqual(recorded, [[usage, 'actual-model']]);
});

test('scheduler limits global concurrency to two and serializes overlapping account locks', async () => {
  let active = 0, maximum = 0;
  const locked = new Set();
  const checks = [];
  const manager = new ModelDiagnostics(async (item) => {
    active += 1; maximum = Math.max(maximum, active);
    for (const id of item.lockIds) { assert.equal(locked.has(id), false); locked.add(id); }
    checks.push(item.model);
    await tick();
    for (const id of item.lockIds) locked.delete(id);
    active -= 1;
    return { state: 'available' };
  });
  const job = manager.start([
    { targetId: 'key1', model: 'one', lockIds: ['a', 'b'] },
    { targetId: 'a', model: 'two', lockIds: ['a'] },
    { targetId: 'c', model: 'three', lockIds: ['c'] },
    { targetId: 'b', model: 'four', lockIds: ['b'] },
  ]);
  assert.throws(() => manager.start([]), /already running/);
  const result = await finished(manager, job.id);
  assert.equal(result.status, 'completed');
  assert.equal(maximum, 2);
  assert.equal(checks.length, 4);
  assert.ok(result.items.every((item) => item.state === 'available'));
  assert.equal(manager.locks.size, 0);
});

test('cancellation aborts active probes and never starts queued work', async () => {
  let calls = 0;
  const manager = new ModelDiagnostics(async (item, signal) => {
    calls += 1;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return { state: 'available' };
  });
  const job = manager.start(['one', 'two', 'three'].map((model) => ({ targetId: 'a', model })));
  manager.cancel(job.id);
  const result = await finished(manager, job.id);
  assert.equal(calls, 1);
  assert.equal(result.status, 'cancelled');
  assert.ok(result.items.every((item) => item.state === 'cancelled'));
  assert.equal(manager.locks.size, 0);
});

test('subsequent job observes model cooldown without sending a request', async () => {
  let calls = 0;
  const manager = new ModelDiagnostics(async () => { calls += 1; return { state: 'service_unavailable' }; });
  const item = { targetId: 'a', model: 'one' };
  await finished(manager, manager.start([item]).id);
  const second = await finished(manager, manager.start([item]).id);
  assert.equal(calls, 1);
  assert.equal(second.items[0].state, 'cooldown');
  assert.ok(Date.parse(second.items[0].retryAt) > Date.now());
});

test('empty completed response is not green; silent model fallback is reported', async () => {
  const completed = { type: 'response.completed', response: { status: 'completed', model: 'actual', output: [] } };
  assert.equal((await inspectProbeResponse(sse([completed]))).state, 'incomplete');
  completed.response.output = [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }];
  const result = await inspectProbeResponse(sse([completed]), { expectedModel: 'requested' });
  assert.equal(result.state, 'model_mismatch');
  assert.equal(result.actualModel, 'actual');
  assert.equal((await inspectProbeResponse(sse([completed]), { expectedModel: 'actual' })).state, 'available');
});

test('SSE rate-limit and overload codes infer status and failed usage is retained', async () => {
  for (const [code, status, state] of [['rate_limit_exceeded', 429, 'rate_limited'], ['server_is_overloaded', 503, 'service_unavailable']]) {
    const result = await inspectProbeResponse(sse([{ type: 'error', error: { code } }]));
    assert.equal(result.httpStatus, status);
    assert.equal(result.state, state);
  }
  const records = [];
  const usage = { input_tokens: 12, output_tokens: 2 };
  const result = await inspectProbeResponse(sse([{ type: 'response.incomplete', response: { status: 'incomplete', usage } }]), { onUsage: (entry) => records.push(entry) });
  assert.equal(result.state, 'incomplete');
  assert.deepEqual(records, [usage]);
});

test('actual server start route requires consent, validates models and fixes lock/request identity', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const start = source.indexOf("    if (request.method === 'POST' && url.pathname === '/api/model-diagnostics/start')");
  const end = source.indexOf('    const diagnosticJobMatch', start);
  assert.ok(start >= 0 && end > start);
  let calls = 0;
  const context = {
    readBody: async (request) => request.body,
    sendJson: (_response, status, body) => ({ status, body }),
    sendError: (_response, status, error) => ({ status, error }),
    diagnosticTarget: (id) => { if (id !== 'a') throw new Error('Account does not exist'); return { members: [{ id: 'real-a' }] }; },
    crypto: { randomUUID: () => 'server-generated' },
    modelDiagnostics: { start: (items) => { calls += 1; return items; } },
  };
  const route = vm.runInNewContext(`(async function(request, response, url) { ${source.slice(start, end)} })`, context);
  const run = (body) => route({ method: 'POST', body }, {}, { pathname: '/api/model-diagnostics/start' });
  assert.equal((await run({ items: [{ targetId: 'a', model: 'sol' }] })).status, 400);
  assert.equal((await run({ confirmed: true, items: [] })).status, 400);
  await assert.rejects(run({ confirmed: true, items: [{ targetId: 'a', model: 'bad model' }] }), /Invalid model/);
  await assert.rejects(run({ confirmed: true, items: [{ targetId: 'a', model: 'sol' }, { targetId: 'a', model: 'sol' }] }), /Duplicate/);
  const result = await run({ confirmed: true, items: [{ targetId: 'a', model: 'sol', lockIds: ['wrong'], requestId: 'client-secret' }] });
  assert.equal(result.status, 200);
  assert.equal(result.body.data[0].lockIds[0], 'real-a');
  assert.equal(result.body.data[0].requestId, 'server-generated');
  assert.equal(result.body.data[0].allowBusy, false);
  assert.equal(calls, 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { inspectResponsesStream } = require('../lib/openai-compat');

function fixture(responses) {
  const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const calls = [];
  const candidates = [{ id: 'a' }, { id: 'b' }];
  const context = {
    inspectResponsesStream,
    accountPoolCandidates: () => candidates,
    accountPoolDispatcher: async () => null,
    readAccountAuth: account => ({ id: account.id, tokens: { access_token: 'fixture-token' } }),
    accessTokenNeedsRefresh: () => false,
    accountIdFromAuth: auth => auth.id,
    CHATGPT_CODEX_RESPONSES_URL: 'https://fixture.invalid/responses', APP_VERSION: 'fixture',
    fetch: async (_url, options) => { calls.push(options); return responses.shift(); },
    accountPoolCooldowns: new Map(), accountPoolLastUsed: new Map(), audit() {},
    saveAccounts() {}, accounts: candidates,
  };
  const start = source.indexOf('async function retryableAccountPoolResponse(');
  const end = source.indexOf('\napiServiceManager.poolForwarder', start);
  vm.runInNewContext(source.slice(start, end), context);
  return { context, calls };
}

test('429 switches to next account without changing context, and cancels failed body', async () => {
  let cancelled = false;
  const first = { status: 429, headers: new Headers(), body: { async cancel() { cancelled = true; } } };
  const success = new Response('fixture');
  const { context, calls } = fixture([first, success]);
  const body = { input: [{ role: 'user', content: 'fixture' }], tools: [], prompt_cache_key: 'fixture-cache' };
  const result = await context.forwardAccountPoolResponses({ keyRecord: { id: 'key' }, model: 'model', body });
  assert.equal(result.accountId, 'b');
  assert.equal(cancelled, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['ChatGPT-Account-ID'], 'a');
  assert.equal(calls[1].headers['ChatGPT-Account-ID'], 'b');
  assert.ok(context.accountPoolCooldowns.get('a') > Date.now() + 50000);
});

test('ordinary invalid-request 400 does not burn through every account', async () => {
  const invalid = new Response('{"error":{"message":"invalid input"}}', { status: 400 });
  const { context, calls } = fixture([invalid]);
  const result = await context.forwardAccountPoolResponses({ keyRecord: { id: 'key' }, model: 'model', body: {} });
  assert.equal(result.upstream.status, 400);
  assert.equal(calls.length, 1);
});

test('image-tool capability 400 retries the next account', async () => {
  const unsupported = new Response('{"error":{"message":"image_generation tool unsupported"}}', { status: 400 });
  const success = new Response('fixture');
  const { context, calls } = fixture([unsupported, success]);
  const body = { input: [{ role: 'user', content: 'fixture' }], tools: [{ type: 'image_generation' }] };
  const result = await context.forwardAccountPoolResponses({ keyRecord: { id: 'key' }, model: 'gpt-5.6-luna', body });
  assert.equal(result.accountId, 'b');
  assert.equal(calls.length, 2);
});

test('model-capacity 400 retries the next account and reports a capacity pool error when exhausted', async () => {
  const overloaded = new Response('{"error":{"code":"server_is_overloaded","message":"Selected model is at capacity"}}', { status: 400 });
  const success = new Response('fixture');
  const { context, calls } = fixture([overloaded, success]);
  const body = { input: [{ role: 'user', content: 'fixture' }], tools: [], stream: true };
  const result = await context.forwardAccountPoolResponses({ keyRecord: { id: 'key' }, model: 'gpt-5.6-sol', body });
  assert.equal(result.accountId, 'b');
  assert.equal(calls.length, 2);

  const exhausted = fixture([
    new Response('{"error":{"code":"server_is_overloaded","message":"Selected model is at capacity"}}', { status: 400 }),
    new Response('{"error":{"code":"server_is_overloaded","message":"Selected model is at capacity"}}', { status: 400 }),
  ]);
  await assert.rejects(
    exhausted.context.forwardAccountPoolResponses({ keyRecord: { id: 'key' }, model: 'gpt-5.6-sol', body }),
    error => error.errorCode === 'account_pool_model_capacity' && error.statusCode === 503,
  );
});

test('a 200 response.failed capacity envelope retries image requests before returning', async () => {
  const overloaded = new Response('data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_is_overloaded","message":"Selected model is at capacity"}}}\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  const success = new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' },
  });
  const { context, calls } = fixture([overloaded, success]);
  const body = { input: [{ role: 'user', content: 'fixture' }], tools: [{ type: 'image_generation', model: 'gpt-image-2.5' }], stream: true };
  const result = await context.forwardAccountPoolResponses({ keyRecord: { id: 'key' }, model: 'gpt-5.6-sol', body });
  assert.equal(result.accountId, 'b');
  assert.equal(calls.length, 2);
});

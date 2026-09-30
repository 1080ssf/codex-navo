const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ACCOUNT_POOL_PROVIDER_ID, ApiServiceManager, extractUsage, resolveImageToolModel, usageForLocalDate } = require('../lib/api-service');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-api-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function manager(t, options = {}) {
  return new ApiServiceManager({
    runtimeRoot: temporaryDirectory(t),
    readJson,
    writeJsonAtomic,
    ...options,
  });
}

test('catalog refresh adds GPT-6.1 Sol without replacing defaults or widening a restricted key', (t) => {
  const service = manager(t);
  service.ensureAccountPool(['gpt-6-sol']);
  service.createKey({ accountIds: ['account-a'], modelAllowlist: ['gpt-6-sol'] });
  const updated = service.ensureAccountPool(['gpt-6.1-sol', 'gpt-6-sol']);
  assert.equal(updated.defaultModel, 'gpt-6-sol');
  assert.equal(service.resolveModel('gpt-6.1-sol').model, 'gpt-6.1-sol');
  service.ensureAccountPool(['gpt-6.1-sol']);
  assert.deepEqual(service.keys[0].modelAllowlist, ['gpt-6-sol']);
});

test('creates hashed Navo keys and never persists the complete secret', (t) => {
  const service = manager(t);
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ name: 'Team key', accountIds: ['account-a'] });
  assert.match(created.secret, /^sk-navo-/);
  assert.equal(service.authenticate(`Bearer ${created.secret}`).id, created.key.id);
  assert.equal(service.authenticate('Bearer sk-navo-wrong'), null);
  assert.equal(fs.readFileSync(service.keysFile, 'utf8').includes(created.secret), false);
  assert.equal(service.publicState().keys[0].hash, undefined);
});

test('issues a separate temporary desktop launch secret without exposing it in public state', (t) => {
  const service = manager(t);
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ name: 'Desktop', accountIds: ['account-a'], showInAccounts: true });
  const launched = service.issueLaunchSecret(created.key.id);
  assert.match(launched.secret, /^sk-navo-launch-/);
  assert.equal(service.authenticate(`Bearer ${launched.secret}`).id, created.key.id);
  assert.deepEqual(service.publicState().keys[0].accountIds, ['account-a']);
  assert.equal(service.publicState().keys[0].showInAccounts, true);
  assert.equal(JSON.stringify(service.publicState()).includes(launched.secret), false);
  assert.equal(service.publicState().keys[0].launchHash, undefined);
  service.recordUsage(launched.record, { inputTokens: 10, outputTokens: 2 }, 'gpt-5.6-sol');
  service.ensureAccountPool(['gpt-5.6-sol', 'gpt-5.6-terra']);
  service.updateKey(created.key.id, { accountIds: ['account-a', 'account-b'] });
  assert.equal(service.authenticate(`Bearer ${launched.secret}`).id, created.key.id, 'launch secret must survive usage, model refresh, and account failover updates');
});

test('exposes only the built-in account pool and migrates old key scopes', (t) => {
  const root = temporaryDirectory(t);
  writeJsonAtomic(path.join(root, 'api-service', 'providers.json'), [{ id: 'legacy-deepseek', apiKey: 'secret' }]);
  writeJsonAtomic(path.join(root, 'api-service', 'keys.json'), [{
    id: 'legacy-key', name: 'Legacy', prefix: 'sk-navo-old', salt: 'salt', hash: 'hash',
    providerIds: ['legacy-deepseek'], modelAllowlist: ['deepseek-chat', 'gpt-5.6-sol'],
  }]);
  const service = new ApiServiceManager({ runtimeRoot: root, readJson, writeJsonAtomic });
  const provider = service.ensureAccountPool(['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.equal(provider.id, ACCOUNT_POOL_PROVIDER_ID);
  assert.deepEqual(service.publicState().providers.map((item) => item.id), [ACCOUNT_POOL_PROVIDER_ID]);
  assert.deepEqual(service.keys[0].providerIds, [ACCOUNT_POOL_PROVIDER_ID]);
  assert.deepEqual(service.keys[0].modelAllowlist, ['deepseek-chat', 'gpt-5.6-sol']);
  assert.equal(JSON.stringify(service.publicState()).includes('legacy-deepseek'), false);
});

test('routes Responses requests through the account-pool forwarder with ordered account scope without changing tools', async (t) => {
  let forwarded = null;
  const service = manager(t, {
    poolForwarder: async (request) => {
      forwarded = request;
      return { upstream: new Response(JSON.stringify({ id: 'resp_pool', usage: { input_tokens: 12, output_tokens: 3 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }) };
    },
  });
  service.ensureAccountPool(['gpt-test']);
  const created = service.createKey({ name: 'Pool Key', modelAllowlist: ['gpt-test'], accountIds: ['account-b', 'account-a', 'account-b'] });
  const record = service.authenticate(`Bearer ${created.secret}`);
  const tools = [{ type: 'function', name: 'echo', parameters: { type: 'object' } }];
  const upstreamHeaders = { 'Session-Id': 'session-test', 'Thread-Id': 'thread-test' };
  const result = await service.forwardResponses({ keyRecord: record, body: { model: 'gpt-test', input: 'hi', tools }, upstreamHeaders });
  const payload = await result.upstream.json();
  service.recordUsage(record, extractUsage(payload));
  assert.equal(forwarded.model, 'gpt-test');
  assert.deepEqual(forwarded.keyRecord.accountIds, ['account-b', 'account-a']);
  assert.deepEqual(forwarded.body.tools, tools);
  assert.deepEqual(forwarded.upstreamHeaders, upstreamHeaders);
  assert.equal(record.usage.requests, 1);
  assert.equal(record.usage.inputTokens, 12);
  assert.equal(record.usage.outputTokens, 3);
});

test('routes virtual image models through a real Codex driver model', async (t) => {
  let forwarded = null;
  const service = manager(t, {
    poolForwarder: async (request) => {
      forwarded = request;
      return { upstream: new Response('data: {"type":"response.completed","response":{"output":[]}}\n\n', {
        status: 200, headers: { 'content-type': 'text/event-stream' },
      }) };
    },
  });
  service.ensureAccountPool(['gpt-5.6-luna', 'gpt-6-astra']);
  const created = service.createKey({ name: 'Image key', accountIds: ['account-a'] });
  const result = await service.forwardImageGeneration({
    keyRecord: service.authenticate(`Bearer ${created.secret}`),
    requestedModel: 'gpt-image-1',
    body: { model: 'gpt-image-1', stream: true, tools: [{ type: 'image_generation' }] },
  });
  assert.equal(result.requestedModel, 'gpt-image-1');
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(forwarded.model, 'gpt-5.6-luna');
  assert.equal(forwarded.body.model, 'gpt-5.6-luna');
});

test('accepts current image compatibility names and separates the tool model from the text driver', async (t) => {
  let forwarded = null;
  const service = manager(t, {
    poolForwarder: async (request) => {
      forwarded = request;
      return { upstream: new Response('{}', { status: 200 }) };
    },
  });
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ accountIds: ['account-a'] });
  const record = service.authenticate(`Bearer ${created.secret}`);
  assert.equal(resolveImageToolModel('gpt-image-1'), 'gpt-image-2.5');
  assert.equal(resolveImageToolModel('gpt-image-2.5-sunburst'), 'gpt-image-2.5-sunburst');
  assert.ok(service.modelsForKey(record).some(item => item.id === 'gpt-image-2.5'));
  await service.forwardImageGeneration({
    keyRecord: record,
    requestedModel: 'gpt-image-2.5-sunburst',
    body: { model: 'gpt-5.6-sol', tools: [{ type: 'image_generation', model: 'gpt-image-2.5-sunburst', action: 'generate' }] },
  });
  assert.equal(forwarded.model, 'gpt-5.6-sol');
});

test('keeps a virtual image model out of the ordinary account-pool default', (t) => {
  const service = manager(t);
  service.ensureAccountPool(['gpt-5.6-luna', 'gpt-image-1']);
  assert.equal(service.providers[0].defaultModel, 'gpt-5.6-luna');
  service.providers[0].defaultModel = 'gpt-image-1';
  service.ensureAccountPool(['gpt-5.6-luna', 'gpt-image-1']);
  assert.equal(service.providers[0].defaultModel, 'gpt-5.6-luna');
});

test('does not allow Responses to send a virtual image model upstream', async (t) => {
  let called = false;
  const service = manager(t, { poolForwarder: async () => { called = true; return {}; } });
  service.ensureAccountPool(['gpt-5.6-luna']);
  const created = service.createKey({ accountIds: ['account-a'] });
  await assert.rejects(
    service.forwardResponses({ keyRecord: service.authenticate(`Bearer ${created.secret}`), body: { model: 'gpt-image-1' } }),
    (error) => error.errorCode === 'image_model_requires_images_endpoint' && error.statusCode === 400,
  );
  assert.equal(called, false);
});

test('explicit image model allowlists are enforced separately from the driver model', async (t) => {
  const service = manager(t, { poolForwarder: async () => ({ upstream: new Response('{}') }) });
  service.ensureAccountPool(['gpt-5.6-luna']);
  const created = service.createKey({ modelAllowlist: ['gpt-5.6-luna'], accountIds: ['account-a'] });
  await assert.rejects(
    service.forwardImageGeneration({ keyRecord: service.authenticate(`Bearer ${created.secret}`), requestedModel: 'gpt-image-1', body: {} }),
    (error) => error.statusCode === 403 && /模型权限/.test(error.message),
  );
});

test('forwards native Codex cache fields without adding an explicit cache breakpoint', async (t) => {
  let forwarded = null;
  const service = manager(t, { poolForwarder: async (request) => {
    forwarded = request;
    return { upstream: new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) };
  } });
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ modelAllowlist: ['gpt-5.6-sol'], accountIds: ['account-a'] });
  const body = {
    model: 'gpt-5.6-sol', prompt_cache_key: 'native-thread-key', stream: true,
    input: [{ role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] }],
  };
  await service.forwardResponses({ keyRecord: service.authenticate(`Bearer ${created.secret}`), body });
  assert.equal(forwarded.body.prompt_cache_key, 'native-thread-key');
  assert.equal(forwarded.body.input[0].content[0].prompt_cache_breakpoint, undefined);
  assert.deepEqual(body.input, forwarded.body.input);
});

test('enforces model, request, token and expiry restrictions', (t) => {
  const service = manager(t);
  const provider = service.ensureAccountPool(['allowed', 'other']);
  const created = service.createKey({ modelAllowlist: ['allowed'], requestLimit: 1, accountIds: ['account-a'] });
  const record = service.authenticate(`Bearer ${created.secret}`);
  service.authorizeKey(record, provider, 'allowed');
  assert.throws(() => service.authorizeKey(record, provider, 'other'), /模型权限/);
  service.recordUsage(record);
  assert.throws(() => service.authorizeKey(record, provider, 'allowed'), /请求额度/);
});

test('normalizes current Codex short model aliases before pool authorization', (t) => {
  const service = manager(t);
  const provider = service.ensureAccountPool(['gpt-6-astra', 'gpt-5.6-sol']);
  assert.equal(service.resolveModel('gpt-6').model, 'gpt-6-astra');
  assert.equal(service.resolveModel('gpt-5.6').model, 'gpt-5.6-sol');
  assert.equal(service.resolveModel(`${provider.id}/gpt-6`).model, 'gpt-6-astra');
});

test('prices new API usage without guessing historical model from current allowlist', (t) => {
  const root = temporaryDirectory(t);
  writeJsonAtomic(path.join(root, 'api-service', 'keys.json'), [{
    id: 'existing-key', name: 'Existing', salt: 'salt', hash: 'hash', modelAllowlist: ['gpt-5.6-sol'],
    usage: { requests: 2, inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 },
  }]);
  const service = new ApiServiceManager({ runtimeRoot: root, readJson, writeJsonAtomic });
  service.ensureAccountPool(['gpt-5.6-sol']);
  const record = service.keys[0];
  assert.equal(record.usage.pricedRequests, 0);
  assert.equal(record.usage.unpricedRequests, 2);
  assert.equal(record.usage.estimatedCostUsd, 0);
  assert.equal(record.usage.estimatedCostApproximate, false);
  assert.equal(record.usage.costVersion, 2);
  const historicalEstimate = record.usage.estimatedCostUsd;
  service.recordUsage(record, { inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 250, outputTokens: 100 }, 'gpt-5.6-sol');
  assert.equal(record.usage.pricedRequests, 1);
  assert.equal(record.usage.cacheWriteInputTokens, 250);
  assert.ok(record.usage.estimatedCostUsd > historicalEstimate);
});

test('durable ledger deduplicates request IDs and safely reconciles only complete buckets', (t) => {
  const service = manager(t);
  const { key } = service.createKey({ accountIds: ['account-a'] });
  const record = service.keys.find((item) => item.id === key.id);
  const usage = { inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100 };
  service.recordUsage(record, usage, 'gpt-5.6-sol', new Date(), { requestId: 'request-1', secret: 'never-save' });
  assert.equal(service.recordUsage(record, usage, 'gpt-5.6-sol', new Date(), { requestId: 'request-1' }), false);
  assert.equal(record.usage.requests, 1);
  assert.equal(service.publicState().keys[0].usageLedger, undefined);
  assert.equal(fs.readFileSync(service.keysFile, 'utf8').includes('never-save'), false);
  const expected = record.usage.estimatedCostUsd;
  record.usage.estimatedCostUsd = 0;
  record.dailyUsage[0].usage.estimatedCostUsd = 0;
  assert.deepEqual(service.reconcileHistoricalCosts(), { repaired: 2, unavailable: 0 });
  assert.equal(record.usage.estimatedCostUsd, expected);
  assert.ok(fs.existsSync(`${service.keysFile}.before-ledger-repricing.bak`));
  record.usage.requests += 1;
  record.usage.estimatedCostUsd = 0;
  assert.deepEqual(service.reconcileHistoricalCosts(), { repaired: 0, unavailable: 1 });
  assert.equal(record.usage.estimatedCostUsd, 0);
  const restarted = new ApiServiceManager({ runtimeRoot: path.dirname(service.directory), readJson, writeJsonAtomic });
  assert.equal(restarted.keys[0].usageLedger.length, 1);
  assert.equal(restarted.recordUsage(restarted.keys[0], usage, 'gpt-5.6-sol', new Date(), { requestId: 'request-1' }), false);
});

test('stores API key usage in separate local-day buckets while keeping lifetime limits cumulative', (t) => {
  const service = manager(t);
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ name: 'Daily usage', accountIds: ['account-a'] });
  const record = service.authenticate(`Bearer ${created.secret}`);
  service.recordUsage(record, { inputTokens: 100, cachedInputTokens: 60, outputTokens: 10 }, 'gpt-5.6-sol', new Date(2026, 7, 14, 23, 55));
  service.recordUsage(record, { inputTokens: 20, cachedInputTokens: 5, outputTokens: 2 }, 'gpt-5.6-sol', new Date(2026, 7, 15, 0, 5));
  assert.equal(record.usage.requests, 2);
  assert.equal(record.usage.inputTokens, 120);
  assert.deepEqual(record.dailyUsage.map((item) => item.date), ['2026-08-14', '2026-08-15']);
  assert.equal(record.dailyUsage[0].usage.inputTokens, 100);
  assert.equal(record.dailyUsage[1].usage.inputTokens, 20);
  assert.equal(record.dailyUsage[1].usage.cachedInputTokens, 5);
  assert.equal(usageForLocalDate(record, new Date(2026, 7, 14, 12)).inputTokens, 100);
  assert.equal(usageForLocalDate(record, new Date(2026, 7, 16, 12)).inputTokens, 0);
});

test('keeps legacy cumulative API usage out of daily totals', (t) => {
  const root = temporaryDirectory(t);
  writeJsonAtomic(path.join(root, 'api-service', 'keys.json'), [{
    id: 'legacy-daily-key', name: 'Legacy daily', salt: 'salt', hash: 'hash',
    usage: { requests: 4, inputTokens: 400, outputTokens: 40, lastUsedAt: '2026-08-14T12:00:00.000Z' },
  }]);
  const service = new ApiServiceManager({ runtimeRoot: root, readJson, writeJsonAtomic });
  assert.equal(service.keys[0].dailyUsageVersion, 2);
  assert.deepEqual(service.keys[0].dailyUsage, []);
  assert.equal(service.keys[0].usage.inputTokens, 400);
  const persisted = readJson(service.keysFile, []);
  assert.equal(persisted[0].dailyUsageVersion, 2);
  assert.deepEqual(persisted[0].dailyUsage, []);
});

test('extracts cache reads and cache writes from Responses usage', () => {
  assert.deepEqual(extractUsage({ usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 200 },
    output_tokens: 50,
  } }), {
    inputTokens: 1000,
    cachedInputTokens: 600,
    cacheWriteInputTokens: 200,
    outputTokens: 50,
    reasoningOutputTokens: 0,
  });
});

test('lists only account-pool models permitted by a key', (t) => {
  const service = manager(t);
  service.ensureAccountPool(['gpt-a', 'gpt-b']);
  const created = service.createKey({ modelAllowlist: ['gpt-b'], accountIds: ['account-a'] });
  const models = service.modelsForKey(service.authenticate(`Bearer ${created.secret}`));
  assert.deepEqual(models.map((item) => item.id), ['gpt-b']);
  assert.ok(models.every((item) => item.provider_id === ACCOUNT_POOL_PROVIDER_ID));
});

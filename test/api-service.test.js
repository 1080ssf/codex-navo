const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ACCOUNT_POOL_PROVIDER_ID, ApiServiceManager, extractUsage, usageForLocalDate } = require('../lib/api-service');

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

test('creates hashed Navo keys and never persists the complete secret', (t) => {
  const service = manager(t);
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ name: 'Team key' });
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
  assert.deepEqual(service.keys[0].modelAllowlist, ['gpt-5.6-sol']);
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

test('forwards native Codex cache fields without adding an explicit cache breakpoint', async (t) => {
  let forwarded = null;
  const service = manager(t, { poolForwarder: async (request) => {
    forwarded = request;
    return { upstream: new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }) };
  } });
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ modelAllowlist: ['gpt-5.6-sol'] });
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
  const created = service.createKey({ modelAllowlist: ['allowed'], requestLimit: 1 });
  const record = service.authenticate(`Bearer ${created.secret}`);
  service.authorizeKey(record, provider, 'allowed');
  assert.throws(() => service.authorizeKey(record, provider, 'other'), /模型权限/);
  service.recordUsage(record);
  assert.throws(() => service.authorizeKey(record, provider, 'allowed'), /请求额度/);
});

test('estimates new and historical API token usage', (t) => {
  const root = temporaryDirectory(t);
  writeJsonAtomic(path.join(root, 'api-service', 'keys.json'), [{
    id: 'existing-key', name: 'Existing', salt: 'salt', hash: 'hash', modelAllowlist: ['gpt-5.6-sol'],
    usage: { requests: 2, inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 },
  }]);
  const service = new ApiServiceManager({ runtimeRoot: root, readJson, writeJsonAtomic });
  service.ensureAccountPool(['gpt-5.6-sol']);
  const record = service.keys[0];
  assert.equal(record.usage.pricedRequests, 2);
  assert.equal(record.usage.unpricedRequests, 0);
  assert.equal(record.usage.estimatedCostUsd, 5.75);
  assert.equal(record.usage.estimatedCostApproximate, true);
  assert.equal(record.usage.costVersion, 2);
  const historicalEstimate = record.usage.estimatedCostUsd;
  service.recordUsage(record, { inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 250, outputTokens: 100 }, 'gpt-5.6-sol');
  assert.equal(record.usage.pricedRequests, 3);
  assert.equal(record.usage.cacheWriteInputTokens, 250);
  assert.ok(record.usage.estimatedCostUsd > historicalEstimate);
});

test('stores API key usage in separate local-day buckets while keeping lifetime limits cumulative', (t) => {
  const service = manager(t);
  service.ensureAccountPool(['gpt-5.6-sol']);
  const created = service.createKey({ name: 'Daily usage' });
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
  const created = service.createKey({ modelAllowlist: ['gpt-b'] });
  const models = service.modelsForKey(service.authenticate(`Bearer ${created.secret}`));
  assert.deepEqual(models.map((item) => item.id), ['gpt-b']);
  assert.ok(models.every((item) => item.provider_id === ACCOUNT_POOL_PROVIDER_ID));
});

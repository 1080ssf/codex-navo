const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readSubscriptionInPage, subscriptionReadError } = require('../lib/subscription-read');
const { readProtocolSubscription } = require('../lib/protocol-login');

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const entitlement = { has_active_subscription: true, expires_at: '2026-10-18T13:31:46+00:00', renews_at: '2026-10-18T07:31:46+00:00', billing_period: 'monthly' };
const payload = { accounts: { workspace: { account: { plan_type: 'self_serve_business_prolite' }, entitlement }, personal: { account: { plan_type: 'free' } } } };

test('subscription reader selects the exact workspace and keeps expiry separate from renewal', async () => {
  const calls = [];
  const result = await readSubscriptionInPage({ accountId: 'workspace', accessToken: 'codex-token' }, async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? json({ accessToken: 'web-token', account: { id: 'personal', planType: 'free' } }) : json(payload);
  });
  assert.equal(result.planType, 'self_serve_business_prolite');
  assert.equal(result.expiresAt, entitlement.expires_at);
  assert.equal(result.renewsAt, entitlement.renews_at);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer web-token');
  assert.equal(calls[1].options.headers['ChatGPT-Account-Id'], 'workspace');
  assert.doesNotMatch(JSON.stringify(result), /token|personal/);
});

test('subscription reader does not substitute a default workspace or its dates', async () => {
  let n = 0;
  const result = await readSubscriptionInPage({ accountId: 'missing' }, async () => ++n === 1 ? json({ accessToken: 'web-token' }) : json(payload));
  assert.equal(result.code, 'account_not_found');
  assert.equal(result.stage, 'subscription');
  assert.equal(result.expiresAt, undefined);
});

test('Cloudflare validation is distinguished from credential denial and stops at the failing stage', async () => {
  for (const challengeAt of [1, 2]) {
    let calls = 0;
    const result = await readSubscriptionInPage({ accountId: 'workspace' }, async () => ++calls === challengeAt
      ? new Response('<html>Just a moment challenge-platform</html>', { status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' } })
      : json({ accessToken: 'web-token' }));
    assert.equal(result.code, 'verification_required');
    assert.equal(result.stage, challengeAt === 1 ? 'web_session' : 'subscription');
    assert.equal(calls, challengeAt);
    const error = subscriptionReadError(result);
    assert.equal(error.status, 403);
    assert.doesNotMatch(error.message, /challenge-platform/);
  }
});

test('permission, login, malformed data, and network failures retain distinct codes without response secrets', async () => {
  const cases = [
    [() => json({ error: 'secret-message' }, 403), 'permission_denied'],
    [() => json({}, 401), 'session_required'],
    [() => json({}, 429), 'rate_limited'],
    [() => new Response('not-json'), 'invalid_response'],
    [() => { throw new Error('secret-token'); }, 'network_error'],
  ];
  for (const [fetchImpl, code] of cases) {
    const result = await readSubscriptionInPage({ accountId: 'workspace' }, fetchImpl);
    assert.equal(result.code, code);
    assert.doesNotMatch(JSON.stringify(result) + subscriptionReadError(result).message, /secret/);
  }
});

test('missing dates are left absent; renewal never becomes an expiry', async () => {
  let n = 0;
  const result = await readSubscriptionInPage({ accountId: 'workspace', accessToken: 'codex-token' }, async () => ++n === 1 ? json({}) : json({ accounts: { workspace: { account: { plan_type: 'business' }, entitlement: { renews_at: entitlement.renews_at } } } }));
  assert.equal(result.expiresAt, null);
  assert.equal(result.renewsAt, entitlement.renews_at);
});

test('missing session with no OAuth fallback does not query subscription', async () => {
  let n = 0;
  const result = await readSubscriptionInPage({ accountId: 'workspace' }, async () => { n++; return json({}); });
  assert.equal(result.code, 'session_required');
  assert.equal(n, 1);
});

function chromeHarness(fetchPage, url = 'https://chatgpt.com/') {
  const counts = { evaluations: 0, browserCloses: 0, socketsClosed: 0 };
  class Socket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    async send(raw) {
      const message = JSON.parse(raw);
      if (message.method === 'Browser.close') { counts.browserCloses++; this.dispatchEvent(new Event('close')); return; }
      counts.evaluations++;
      const value = await vm.runInNewContext(message.params.expression, { fetch: fetchPage, AbortSignal });
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: message.id, result: { result: { value } } }) }));
    }
    close() { counts.socketsClosed++; }
  }
  return { counts, options: { port: 1234, accountId: 'workspace', WebSocketImpl: Socket, fetchImpl: async () => json([{ type: 'page', url, webSocketDebuggerUrl: 'ws://127.0.0.1/mock' }]) } };
}

test('real serialized browser reader returns normalized dates and never closes the user browser', async () => {
  let n = 0;
  const { counts, options } = chromeHarness(async () => ++n % 2 ? json({ accessToken: 'web' }) : json(payload));
  const result = await readProtocolSubscription(options);
  assert.equal(result.expiresAt, '2026-10-18T13:31:46.000Z');
  assert.equal(result.renewsAt, '2026-10-18T07:31:46.000Z');
  assert.equal(result.planType, 'self_serve_business_prolite');
  assert.equal(counts.browserCloses, 0);
  assert.equal(counts.socketsClosed, 1);
});

test('browser verification failures are not retried even when callers request many attempts', async () => {
  const { counts, options } = chromeHarness(async () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }));
  await assert.rejects(readProtocolSubscription({ ...options, attempts: 8, closeBrowser: true }), { code: 'verification_required', stage: 'web_session', status: 403 });
  assert.equal(counts.evaluations, 1);
  assert.equal(counts.browserCloses, 1);
});

test('subscription credentials are never evaluated on an unrelated browser page', async () => {
  const { counts, options } = chromeHarness(async () => json({}), 'https://example.org/');
  await assert.rejects(readProtocolSubscription(options), /没有可用页面/);
  assert.equal(counts.evaluations, 0);
});

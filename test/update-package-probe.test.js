const test = require('node:test');
const assert = require('node:assert/strict');
const { probeUpdatePackage } = require('../lib/update-package-probe');

const PACKAGE = 'https://update.example.test/package.msix';
function response(status, headers = {}, url = PACKAGE) {
  let cancellations = 0;
  return {
    status, ok: status >= 200 && status < 300, url, headers: new Headers(headers),
    body: { cancel: () => { cancellations += 1; }, getReader: () => { throw new Error('The probe must never consume package bytes'); } },
    cancellations: () => cancellations,
    arrayBuffer: () => { throw new Error('The probe must never buffer a package'); },
  };
}

test('a supported HEAD succeeds without a GET and disposes its request', async () => {
  const head = response(200);
  const calls = [];
  const result = await probeUpdatePackage(async (url, options) => { calls.push(options); return head; }, PACKAGE);
  assert.equal(result.ok, true);
  assert.equal(result.headStatus, 200);
  assert.deepEqual(calls.map((call) => call.method), ['HEAD']);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(head.cancellations(), 1);
});

for (const status of [403, 404, 410, 429, 500, 503]) test(`HEAD ${status} is not treated as an unsupported method or a downloadable package`, async () => {
  const calls = [];
  const result = await probeUpdatePackage(async (_url, options) => { calls.push(options); return response(status); }, PACKAGE);
  assert.equal(result.ok, false);
  assert.equal(result.status, status);
  assert.equal(result.headStatus, status);
  assert.deepEqual(calls.map((call) => call.method), ['HEAD']);
});

for (const headStatus of [405, 501]) test(`HEAD ${headStatus} falls back to only bytes 0-0 and closes the response at its headers`, async () => {
  const calls = [];
  const partial = response(206, { 'content-range': 'bytes 0-0/900000000', 'content-length': '1' });
  const result = await probeUpdatePackage(async (_url, options) => {
    calls.push(options);
    return options.method === 'HEAD' ? response(headStatus) : partial;
  }, PACKAGE);
  assert.equal(result.ok, true);
  assert.equal(result.headStatus, headStatus);
  assert.equal(result.status, 206);
  assert.equal(result.probeMethod, 'GET-range');
  assert.equal(calls[1].headers.Range, 'bytes=0-0');
  assert.equal(calls[1].redirect, 'manual');
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(partial.cancellations(), 1);
});

test('a server ignoring Range never causes a whole-package read or waits for body cancellation', async () => {
  const full = response(200, { 'content-length': '900000000' });
  let cancelled = 0, getSignal;
  full.body.cancel = () => { cancelled++; return new Promise(() => {}); };
  const result = await probeUpdatePackage(async (_url, options) => {
    if (options.method === 'HEAD') return response(405);
    getSignal = options.signal;
    return full;
  }, PACKAGE, { timeoutMs: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(cancelled, 1);
  assert.equal(getSignal.aborted, true);
});

test('a missing fallback GET stays missing rather than claiming a package is ready', async () => {
  const result = await probeUpdatePackage(async (_url, options) => response(options.method === 'HEAD' ? 405 : 404), PACKAGE);
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.headStatus, 405);
});

for (const headers of [{}, { 'content-range': 'bytes 0-99/100' }, { 'content-range': 'bytes 0-0/100', 'content-length': '100' }]) {
  test(`invalid partial-content metadata is rejected: ${JSON.stringify(headers)}`, async () => {
    const result = await probeUpdatePackage(async (_url, options) => options.method === 'HEAD' ? response(405) : response(206, headers), PACKAGE);
    assert.equal(result.ok, false);
    assert.match(result.probeError, /invalid partial-content range/);
  });
}

test('bounded HTTPS redirects preserve the one-byte Range and cancel intermediate bodies', async () => {
  const calls = [], redirect = response(302, { location: '/download.msix' });
  const result = await probeUpdatePackage(async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'HEAD') return response(405);
    if (url === PACKAGE) return redirect;
    return response(206, { 'content-range': 'bytes 0-0/100', 'content-length': '1' }, url);
  }, PACKAGE);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers.Range, 'bytes=0-0');
  assert.equal(redirect.cancellations(), 1);
  assert.ok(calls.every((call) => call.signal.aborted));
});

test('redirect loops and non-HTTPS locations are stopped without consuming response bodies', async () => {
  for (const location of ['/loop', 'http://update.example.test/package.msix']) {
    let calls = 0;
    const result = await probeUpdatePackage(async () => { calls++; return response(302, { location }); }, PACKAGE, { maxRedirects: 2 });
    assert.equal(result.ok, false);
    assert.ok(calls <= 3);
    assert.match(result.probeError, /redirect/);
  }
});

test('a stalled fetch times out and a late response is still cancelled', async () => {
  let release, requestSignal;
  const pending = probeUpdatePackage((_url, options) => {
    requestSignal = options.signal;
    return new Promise((resolve) => { release = resolve; });
  }, PACKAGE, { timeoutMs: 10 });
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.probeError, /timed out/);
  assert.equal(requestSignal.aborted, true);
  const late = response(200);
  release(late);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late.cancellations(), 1);
});

test('external cancellation before or during fallback never starts another package request', async () => {
  const before = new AbortController();
  before.abort(new Error('fixture cancellation'));
  await assert.rejects(probeUpdatePackage(() => { throw new Error('must not fetch'); }, PACKAGE, { signal: before.signal }), /fixture cancellation/);
  const during = new AbortController();
  const calls = [];
  await assert.rejects(probeUpdatePackage(async (_url, options) => {
    calls.push(options);
    if (options.method === 'HEAD') return response(405);
    during.abort(new Error('cancel fallback'));
    return response(200, { 'content-length': '900000000' });
  }, PACKAGE, { signal: during.signal }), /cancel fallback/);
  assert.deepEqual(calls.map((call) => call.method), ['HEAD', 'GET']);
  assert.ok(calls.every((call) => call.signal.aborted));
});

test('cancellation while a fetch is queued prevents invoking the transport at all', async () => {
  const controller = new AbortController();
  let requests = 0;
  const pending = probeUpdatePackage(async () => { requests++; return response(200); }, PACKAGE, { signal: controller.signal });
  controller.abort(new Error('cancel before transport'));
  await assert.rejects(pending, /cancel before transport/);
  assert.equal(requests, 0);
});

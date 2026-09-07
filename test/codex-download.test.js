const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { reusablePackage } = require('../lib/update-cache');
const { writeUpdateSnapshot, progressReporter } = require('../lib/update-operation');

function downloader(t, fetch, timer = setTimeout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-download-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const source = fs.readFileSync(path.join(__dirname, '../desktop-src/main.js'), 'utf8');
  const start = source.indexOf('async function downloadCodexPackage(');
  const end = source.indexOf('\nasync function readCodexPackageMetadata', start);
  assert.ok(start >= 0 && end > start);
  const context = { fs, path, crypto, process, Buffer, URL, AbortController, setTimeout: timer, clearTimeout,
    USER_DATA_ROOT: root, reusablePackage, writeUpdateSnapshot, progressReporter,
    codexUpdateSession: () => ({ fetch }), publishCodexUpdateState: () => {} };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { run: () => context.downloadCodexPackage({ latestVersion: '1.2.3', packageUrl: 'https://example.test/package' }),
    cancel: () => context.codexDownloadController.abort(new Error('CODEX_DOWNLOAD_CANCELLED')), root };
}

test('user cancellation retains resumable data and retry completes from the saved offset', async (t) => {
  let calls = 0;
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const download = downloader(t, async (_url, { signal, headers }) => {
    if (++calls === 1) return { ok: true, status: 200, headers: new Headers({ etag: '"v1"', 'content-length': '12' }),
      body: (async function* () {
        yield Buffer.from('pack');
        ready();
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      })() };
    assert.equal(headers.Range, 'bytes=4-');
    return new Response('age-data', { status: 206,
      headers: { etag: '"v1"', 'content-range': 'bytes 4-11/12', 'content-length': '8' } });
  });
  const pending = download.run();
  await started;
  download.cancel();
  await assert.rejects(pending, /CODEX_DOWNLOAD_CANCELLED/);
  assert.equal(fs.readFileSync((await download.run()).path, 'utf8'), 'package-data');
});

test('download aborts when response headers never arrive', async (t) => {
  const download = downloader(t, (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), (callback) => setTimeout(callback, 20));
  await assert.rejects(download.run(), /no data for 30 seconds/);
});

test('download aborts when response body stops producing data', async (t) => {
  const download = downloader(t, async (_url, { signal }) => ({ ok: true, status: 200,
    url: 'https://example.test/package', headers: new Headers({ 'content-length': '12' }),
    body: (async function* () {
      yield Buffer.from('part');
      await new Promise((_resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    })(),
  }), (callback) => setTimeout(callback, 20));
  await assert.rejects(download.run(), /no data for 30 seconds/);
  assert.deepEqual(fs.readdirSync(path.join(download.root, 'updates/codex')), []);
});

test('actual download function saves exact bytes and reuses a complete verified cache', async (t) => {
  let requests = 0;
  const download = downloader(t, async () => {
    requests++;
    return new Response(Buffer.from('package-data'), { headers: { 'content-length': '12' } });
  });
  const result = await download.run();
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'package-data');
  assert.equal(result.bytes, 12);
  assert.equal((await download.run()).sha256, result.sha256);
  assert.equal(requests, 1);
});

test('actual download function rejects interrupted streams and never creates a completed package', async (t) => {
  const download = downloader(t, async () => ({ ok: true, status: 200,
    url: 'https://example.test/package', headers: new Headers({ 'content-length': '12' }),
    body: (async function* () { yield Buffer.from('part'); throw new Error('connection lost'); })() }));
  await assert.rejects(download.run(), /connection lost/);
  const directory = path.join(download.root, 'updates/codex');
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('interrupted download resumes only with matching ETag and exact Content-Range', async (t) => {
  let calls = 0;
  const download = downloader(t, async (_url, options) => {
    if (++calls === 1) return { ok: true, status: 200, headers: new Headers({ etag: '"v1"', 'content-length': '12' }),
      body: (async function* () { yield Buffer.from('pack'); throw new Error('offline'); })() };
    assert.equal(options.headers.Range, 'bytes=4-');
    assert.equal(options.headers['If-Range'], '"v1"');
    return new Response(Buffer.from('age-data'), { status: 206,
      headers: { etag: '"v1"', 'content-length': '8', 'content-range': 'bytes 4-11/12' } });
  });
  await assert.rejects(download.run(), /offline/);
  const result = await download.run();
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'package-data');
  assert.equal(result.sha256, crypto.createHash('sha256').update('package-data').digest('hex'));
});

test('server ignoring Range replaces partial bytes instead of appending them', async (t) => {
  let calls = 0;
  const download = downloader(t, async () => {
    if (++calls === 1) return { ok: true, status: 200, headers: new Headers({ etag: '"old"' }),
      body: (async function* () { yield Buffer.from('old'); throw new Error('offline'); })() };
    return new Response('new-package', { headers: { etag: '"new"', 'content-length': '11' } });
  });
  await assert.rejects(download.run(), /offline/);
  assert.equal(fs.readFileSync((await download.run()).path, 'utf8'), 'new-package');
});

for (const headers of [
  { etag: '"v1"', 'content-range': 'bytes 3-11/12', 'content-length': '9' },
  { etag: '"changed"', 'content-range': 'bytes 4-11/12', 'content-length': '8' },
]) {
  test(`unsafe resumed response is rejected: ${JSON.stringify(headers)}`, async (t) => {
    let calls = 0;
    const download = downloader(t, async () => {
      if (++calls === 1) return { ok: true, status: 200,
        headers: new Headers({ etag: '"v1"', 'content-length': '12' }),
        body: (async function* () { yield Buffer.from('pack'); throw new Error('offline'); })() };
      return new Response('age-data', { status: 206, headers });
    });
    await assert.rejects(download.run(), /offline/);
    await assert.rejects(download.run(), /Invalid resumed/);
    const files = fs.readdirSync(path.join(download.root, 'updates/codex'));
    assert.equal(files.some((name) => name.endsWith('.msix')), false);
    assert.equal(files.some((name) => name.endsWith('.json')), false);
  });
}

test('HTTP 416 invalidates the resume marker so the next retry is a full request', async (t) => {
  let calls = 0;
  const download = downloader(t, async (_url, options) => {
    calls++;
    if (calls === 1) return { ok: true, status: 200, headers: new Headers({ etag: '"old"' }),
      body: (async function* () { yield Buffer.from('part'); throw new Error('offline'); })() };
    if (calls === 2) return new Response(null, { status: 416 });
    assert.equal(options.headers.Range, undefined);
    return new Response('complete', { headers: { 'content-length': '8' } });
  });
  await assert.rejects(download.run(), /offline/);
  await assert.rejects(download.run(), /range is no longer available/);
  assert.equal(fs.readFileSync((await download.run()).path, 'utf8'), 'complete');
});

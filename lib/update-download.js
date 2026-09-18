'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { reusablePackage, hashFile } = require('./update-cache');
const { writeUpdateSnapshot, progressReporter } = require('./update-operation');

function retryableDownload(error) {
  const status = Number(error?.status || error?.statusCode || /(?:HTTP|status)\s+(\d{3})\b/i.exec(String(error?.message || ''))?.[1]);
  if (status) return [408, 429, 500, 502, 503, 504].includes(status);
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ERR_(?:CONNECTION|NETWORK|INTERNET|TIMED_OUT)|fetch failed|network|socket|connection|no data|incomplete|range is no longer|Invalid resumed/i.test(String(error?.message || error));
}

function waitForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

async function retryDownload(operation, { signal, attempts = 3, onRetry = () => {}, wait = waitForRetry } = {}) {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(attempt); }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (attempt >= attempts || !retryableDownload(error)) throw error;
      await onRetry(attempt + 1, error);
      await wait(Math.min(5000, 1000 * 2 ** (attempt - 1)), signal);
    }
  }
}

class RangeUnavailable extends Error {}

// Limited parallelism on the original HTTPS source only. No mirrors, no
// credentials, and no acceptance of changed validators or overlapping ranges.
async function downloadInRanges({ url, destination, fetch, signal, onProgress = () => {},
  minSize = 32 * 1024 * 1024, chunkSize = 8 * 1024 * 1024, concurrency = 4,
  idleMs = 30_000, wait = waitForRetry }) {
  if (new URL(url).protocol !== 'https:') throw new Error('Update downloads require HTTPS.');
  const cached = await reusablePackage(destination, url);
  signal?.throwIfAborted();
  if (cached) return cached;
  const operation = new AbortController();
  const combined = signal ? AbortSignal.any([signal, operation.signal]) : operation.signal;
  const partRequest = async (start, end, etag = '', progress = () => {}) => {
    const request = new AbortController();
    const requestSignal = AbortSignal.any([combined, request.signal]);
    let timer;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => request.abort(new Error('Update download received no data for 30 seconds.')), idleMs); };
    reset();
    let response;
    try {
      response = await fetch(url, { cache: 'no-store', signal: requestSignal,
        headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity', ...(etag ? { 'If-Range': etag } : {}) } });
      if (new URL(response.url || url).protocol !== 'https:') throw new Error('Update redirected to an insecure URL.');
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) throw Object.assign(new Error(`Package HTTP ${response.status}`), { status: response.status });
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      const tag = response.headers.get('etag') || '';
      if (response.status !== 206 || !match || Number(match[1]) !== start || Number(match[2]) !== end
        || !Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= end
        || !/^"[^"\r\n]+"$/.test(tag) || (etag && tag !== etag)
        || (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
        throw new RangeUnavailable('The source does not support validated byte ranges.');
      }
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        reset(); bytes += chunk.length;
        if (bytes > end - start + 1) throw new RangeUnavailable('Unexpected package range length.');
        chunks.push(Buffer.from(chunk)); progress(bytes, chunk.length);
      }
      requestSignal.throwIfAborted();
      if (bytes !== end - start + 1) throw new Error('Incomplete package range.');
      return { data: Buffer.concat(chunks), total: Number(match[3]), etag: tag };
    } catch (error) {
      if (requestSignal.aborted) throw requestSignal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      request.abort();
      try { await response?.body?.cancel(); } catch {}
    }
  };
  let probe;
  try { probe = await retryDownload(() => partRequest(0, 0), { signal: combined, wait }); }
  catch (error) { if (error instanceof RangeUnavailable) return null; throw error; }
  if (probe.total < minSize) return null;
  const count = Math.ceil(probe.total / chunkSize);
  const identity = crypto.createHash('sha256').update(`${url}\n${probe.etag}\n${probe.total}\n${chunkSize}`).digest('hex').slice(0, 24);
  const partPath = i => `${destination}.${identity}.${i}.part`;
  let next = 0, completedBytes = 0, downloadedBytes = 0;
  const inFlight = new Map();
  const started = Date.now();
  const report = progressReporter(onProgress);
  const publish = force => report({ bytesDownloaded: completedBytes + [...inFlight.values()].reduce((a, b) => a + b, 0), totalBytes: probe.total,
    bytesPerSecond: Math.round(downloadedBytes / Math.max(.001, (Date.now() - started) / 1000)), connections: concurrency }, force);
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      combined.throwIfAborted();
      const index = next++, start = index * chunkSize, end = Math.min(probe.total, start + chunkSize) - 1;
      const file = partPath(index);
      let valid = false;
      try {
        const record = JSON.parse(await fs.promises.readFile(`${file}.json`, 'utf8'));
        valid = (await fs.promises.stat(file)).size === end - start + 1 && record.sha256 === await hashFile(file);
      } catch {}
      if (!valid) {
        const result = await retryDownload(() => {
          inFlight.set(index, 0);
          return partRequest(start, end, probe.etag, (bytes, delta) => {
            inFlight.set(index, bytes); downloadedBytes += delta; publish(false);
          });
        }, { signal: combined, wait });
        if (result.total !== probe.total) throw new RangeUnavailable('Package size changed.');
        combined.throwIfAborted();
        await fs.promises.writeFile(file, result.data);
        writeUpdateSnapshot(`${file}.json`, { sha256: crypto.createHash('sha256').update(result.data).digest('hex') });
      }
      inFlight.delete(index); completedBytes += end - start + 1; publish(false);
    }
  });
  try { await Promise.all(workers); }
  catch (error) {
    operation.abort(error); await Promise.allSettled(workers);
    if (signal?.aborted) throw signal.reason;
    if (error instanceof RangeUnavailable) return null;
    throw error;
  }
  combined.throwIfAborted(); publish(true);
  const temporary = `${destination}.assembling`;
  const handle = await fs.promises.open(temporary, 'w');
  const hash = crypto.createHash('sha256');
  try {
    for (let index = 0; index < count; index++) {
      combined.throwIfAborted();
      const data = await fs.promises.readFile(partPath(index));
      let written = 0;
      while (written < data.length) {
        const result = await handle.write(data, written, data.length - written);
        if (!result.bytesWritten) throw new Error('Failed to write update package.');
        written += result.bytesWritten;
      }
      hash.update(data);
    }
  } catch (error) { await handle.close(); await fs.promises.rm(temporary, { force: true }); throw error; }
  await handle.close(); combined.throwIfAborted();
  await fs.promises.rename(temporary, destination);
  const result = { path: destination, bytes: completedBytes, sha256: hash.digest('hex') };
  writeUpdateSnapshot(`${destination}.json`, { url, bytes: result.bytes, sha256: result.sha256 });
  for (let index = 0; index < count; index++) {
    await fs.promises.rm(partPath(index), { force: true });
    await fs.promises.rm(`${partPath(index)}.json`, { force: true });
  }
  return result;
}

// A small sample selects a route per source, not per application session.
// Both responses are cancelled at the cap (even if Range is ignored).
async function selectDownloadRoute(candidates, url, { timeoutMs = 8000, sampleBytes = 128 * 1024, signal } = {}) {
  const results = await Promise.all(candidates.map(async candidate => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now(); let response, bytes = 0;
    try {
      response = await candidate.fetch(url, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, cache: 'no-store',
        headers: { Range: `bytes=0-${sampleBytes - 1}`, 'Accept-Encoding': 'identity' } });
      if (!response.ok || new URL(response.url || url).protocol !== 'https:') return null;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes >= sampleBytes) break; }
      if (!bytes) return null;
      return { ...candidate, speed: bytes / Math.max(1, Date.now() - started) };
    } catch { return null; }
    finally { clearTimeout(timer); controller.abort(); try { await response?.body?.cancel(); } catch {} }
  }));
  signal?.throwIfAborted();
  return results.filter(Boolean).sort((a, b) => b.speed - a.speed)[0] || null;
}

module.exports = { retryableDownload, retryDownload, downloadInRanges, selectDownloadRoute };

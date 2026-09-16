'use strict';

const METHOD_UNSUPPORTED = new Set([405, 501]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function stopBody(response) {
  // A server may ignore Range and offer the whole installer. Never consume or
  // buffer that body; cancellation itself must not hold the readiness check.
  try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
}

async function probeUpdatePackage(fetchPackage, packageUrl, { timeoutMs = 15_000, signal, maxRedirects = 3 } = {}) {
  const operation = new AbortController();
  const deadline = setTimeout(() => operation.abort(new Error('The official package probe timed out.')), timeoutMs);
  const cancel = () => operation.abort(signal.reason || new Error('The package probe was cancelled.'));
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let headStatus = 0;
  let probeMethod = 'HEAD';

  const requestHeaders = async (url, method) => {
    if (operation.signal.aborted) throw operation.signal.reason;
    const request = new AbortController();
    const requestSignal = AbortSignal.any([operation.signal, request.signal]);
    let response;
    let rejectOnAbort;
    const abort = new Promise((_resolve, reject) => {
      rejectOnAbort = () => reject(requestSignal.reason);
      requestSignal.addEventListener('abort', rejectOnAbort, { once: true });
    });
    try {
      const fetching = Promise.resolve().then(() => {
        if (requestSignal.aborted) throw requestSignal.reason;
        return fetchPackage(url, {
          method, cache: 'no-store', redirect: 'manual', signal: requestSignal,
          ...(method === 'GET' ? { headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' } } : {}),
        });
      }).then((result) => {
        if (requestSignal.aborted) {
          stopBody(result);
          throw requestSignal.reason;
        }
        return result;
      });
      response = await Promise.race([fetching, abort]);
      const effectiveUrl = new URL(response.url || url);
      if (effectiveUrl.protocol !== 'https:') throw new Error('The official package probe redirected to a non-HTTPS URL.');
      return {
        status: Number(response.status) || 0,
        location: response.headers?.get('location') || '',
        contentRange: response.headers?.get('content-range') || '',
        contentLength: response.headers?.get('content-length') || '',
      };
    } finally {
      requestSignal.removeEventListener('abort', rejectOnAbort);
      stopBody(response);
      // Abort immediately after headers, including 200 responses that ignored
      // Range, redirects, and errors. No installer bytes are read by this code.
      request.abort(new Error('Package header probe complete.'));
    }
  };

  const probe = async (method) => {
    let url = new URL(packageUrl);
    if (url.protocol !== 'https:') throw new Error('The package probe requires an HTTPS URL.');
    for (let redirects = 0; ; redirects += 1) {
      const response = await requestHeaders(url.toString(), method);
      if (!REDIRECTS.has(response.status)) return response;
      if (!response.location || redirects >= maxRedirects) throw new Error('The official package probe exceeded its redirect limit or returned no location.');
      url = new URL(response.location, url);
      if (url.protocol !== 'https:') throw new Error('The official package probe redirected to a non-HTTPS URL.');
    }
  };

  try {
    let response = await probe('HEAD');
    headStatus = response.status;
    if (METHOD_UNSUPPORTED.has(headStatus)) {
      probeMethod = 'GET-range';
      response = await probe('GET');
      if (response.status === 206) {
        const range = /^bytes 0-0\/(\d+)$/i.exec(response.contentRange);
        if (!range || Number(range[1]) < 1 || (response.contentLength && Number(response.contentLength) !== 1)) {
          return { ok: false, status: response.status, headStatus, probeMethod,
            probeError: 'The official package probe returned an invalid partial-content range.' };
        }
      } else if (response.status >= 200 && response.status < 300 && response.status !== 200) {
        return { ok: false, status: response.status, headStatus, probeMethod,
          probeError: 'The official package probe did not return package content.' };
      }
    }
    return { ok: response.status >= 200 && response.status < 300, status: response.status, headStatus, probeMethod };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    return { ok: false, status: 0, headStatus, probeMethod, probeError: String(error?.message || error) };
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
  }
}

module.exports = { probeUpdatePackage };

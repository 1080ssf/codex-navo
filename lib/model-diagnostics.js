const crypto = require('node:crypto');

function classifyFailure(status, error = {}, retryAfter = null) {
  const code = String(error.code || error.type || '');
  const message = String(error.message || '');
  if (!status && /usage_limit|quota|rate_limit|slow_down|credit_balance|connection_limit/i.test(code)) status = 429;
  if (!status && /server_is_overloaded|service_unavailable/i.test(code)) status = 503;
  let state = 'unknown_error';
  if (status === 401) state = 'authentication_required';
  else if (status === 403) state = /region|country/i.test(code + message) ? 'region_restricted' : 'access_denied';
  else if (status === 404) state = /model/i.test(code + message) ? 'model_not_found' : 'endpoint_not_found';
  else if (status === 429) state = /quota|usage_limit|credit_balance/i.test(code + message) ? 'quota_exhausted' : 'rate_limited';
  else if (status >= 500) state = 'service_unavailable';
  else if (status === 400) state = 'request_rejected';
  else if (/timeout|timedout/i.test(code + message)) state = 'timeout';
  else if (/tls|cert|ssl/i.test(code + message)) state = 'tls_error';
  else if (!status) state = 'network_error';
  const seconds = retryAfter == null ? NaN : Number(retryAfter);
  const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter || '');
  return { state, httpStatus: status || null,
    errorCode: /^[a-zA-Z0-9_.-]{1,100}$/.test(code) ? code : null,
    retryAt: Number.isFinite(retryAt) ? new Date(retryAt).toISOString() : null };
}

async function inspectProbeResponse(response, { signal, startedAt = Date.now(), expectedModel = '', onUsage = () => {} } = {}) {
  if (!response.ok) {
    let error = {};
    try { const payload = await response.json(); error = payload.error || {}; } catch {}
    return classifyFailure(response.status, error, response.headers.get('retry-after'));
  }
  let buffer = '', firstOutputMs = null, completed = false, failure = null, usage = null, actualModel = '';
  const processEvent = (data) => {
    if (!data || data === '[DONE]') return;
    let event; try { event = JSON.parse(data); } catch { return; }
    if (event.response?.model) actualModel = event.response.model;
    if (event.response?.usage) usage = event.response.usage;
    if (event.type === 'response.output_text.delta' && event.delta && firstOutputMs == null) firstOutputMs = Date.now() - startedAt;
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      const error = event.error || event.response?.error || {};
      failure = classifyFailure(Number(event.status || error.status) || (error.code === 'usage_limit_reached' ? 429 : 0), error);
      if (event.type === 'response.incomplete') failure.state = 'incomplete';
    }
    if (event.type === 'response.completed') {
      completed = event.response?.status === 'completed';
      usage = event.response?.usage || usage;
      const outputText = (event.response?.output || []).flatMap((item) => item.content || []).some((part) => part.type === 'output_text' && part.text);
      if (outputText && firstOutputMs == null) firstOutputMs = Date.now() - startedAt;
      if (event.response?.error) failure = classifyFailure(0, event.response.error);
    }
  };
  try {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      if (signal?.aborted) throw signal.reason;
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
      if (buffer.length > 1024 * 1024) throw new Error('Probe response exceeded limit');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        processEvent(frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n'));
      }
      if (completed || failure) break;
    }
  } finally { if (usage) await onUsage(usage, actualModel || expectedModel); }
  return failure || { state: expectedModel && actualModel && actualModel !== expectedModel ? 'model_mismatch' : completed && firstOutputMs != null ? 'available' : 'incomplete', actualModel,
    httpStatus: response.status, firstOutputMs, durationMs: Date.now() - startedAt };
}

class ModelDiagnostics {
  constructor(probe) { this.probe = probe; this.jobs = new Map(); this.running = 0; this.locks = new Set(); this.cooldowns = new Map(); }
  start(items) {
    if ([...this.jobs.values()].some((job) => job.status === 'running')) throw new Error('A model check is already running');
    const job = { id: crypto.randomUUID(), status: 'running', createdAt: new Date().toISOString(),
      items: items.map((item) => ({ ...item, state: 'queued' })), controller: new AbortController() };
    this.jobs.set(job.id, job);
    while (this.jobs.size > 10) this.jobs.delete(this.jobs.keys().next().value);
    void this.run(job);
    return this.view(job.id);
  }
  view(id) { const job = this.jobs.get(id); if (!job) return null; const { controller, ...view } = job; return view; }
  cancel(id) { const job = this.jobs.get(id); if (job?.status === 'running') job.controller.abort(new Error('cancelled')); return this.view(id); }
  async run(job) {
    await Promise.all(Array.from({ length: 2 }, async () => {
      while (!job.controller.signal.aborted) {
        const item = job.items.find((row) => row.state === 'queued' && !(row.lockIds || [row.targetId]).some((id) => this.locks.has(id)));
        if (!item) break;
        const lockIds = item.lockIds || [item.targetId];
        for (const id of lockIds) this.locks.add(id); item.state = 'checking';
        const key = `${item.targetId}:${item.model}`;
        try {
          if ((this.cooldowns.get(key) || 0) > Date.now()) Object.assign(item, { state: 'cooldown', retryAt: new Date(this.cooldowns.get(key)).toISOString() });
          else {
            const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(30_000)]);
            Object.assign(item, await this.probe(item, signal));
            if (item.retryAt) this.cooldowns.set(key, Date.parse(item.retryAt));
            else if (['rate_limited', 'service_unavailable'].includes(item.state)) this.cooldowns.set(key, Date.now() + 60_000);
          }
        } catch (error) {
          Object.assign(item, job.controller.signal.aborted ? { state: 'cancelled' } : classifyFailure(error.statusCode || 0, { code: error.code || error.name, message: error.message }));
        } finally { item.checkedAt = new Date().toISOString(); for (const id of lockIds) this.locks.delete(id); }
      }
    }));
    for (const item of job.items) if (item.state === 'queued') item.state = 'cancelled';
    job.status = job.controller.signal.aborted ? 'cancelled' : 'completed';
  }
}
module.exports = { classifyFailure, inspectProbeResponse, ModelDiagnostics };

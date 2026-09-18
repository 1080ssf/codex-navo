const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Deliberately allow-list fields: error messages and URLs can contain proxy
// credentials, local paths or tokens and must never enter this timing log.
function createUpdateDiagnostics(file, { clock = Date.now, maxBytes = 512 * 1024, onError = () => {} } = {}) {
  const previous = new Map();
  let queue = Promise.resolve();
  const record = (target, state) => {
    if (!['navo', 'codex'].includes(target)) return;
    const now = clock();
    const phase = String(state.phase || state.status || 'idle');
    if (!/^[a-z-]{1,40}$/.test(phase)) return;
    const prior = previous.get(target);
    const changed = !prior || prior.phase !== phase;
    if (!changed && now - prior.loggedAt < 10_000) return;
    const operationId = !prior || (phase === 'checking' && changed) ? crypto.randomUUID() : prior.operationId;
    const stageStartedAt = changed ? now : prior.stageStartedAt;
    const event = { at: new Date(now).toISOString(), target, operationId, phase,
      elapsedMs: prior ? Math.max(0, now - prior.stageStartedAt) : 0 };
    if (changed && prior) event.previousPhase = prior.phase;
    for (const key of ['percent', 'bytesDownloaded', 'totalBytes', 'bytesPerSecond', 'directPackageStatus', 'retryAttempt', 'connections']) {
      if (typeof state[key] === 'number' && Number.isFinite(state[key]) && state[key] >= 0) event[key] = state[key];
    }
    event.failed = state.status === 'error';
    event.cancelled = state.cancelled === true;
    previous.set(target, { operationId, phase, stageStartedAt, loggedAt: now });
    queue = queue.then(async () => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const size = await fs.promises.stat(file).then((stat) => stat.size, (error) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      if (size >= maxBytes) {
        await fs.promises.rm(`${file}.1`, { force: true });
        await fs.promises.rename(file, `${file}.1`);
      }
      await fs.promises.appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }).catch(() => { onError(); });
  };
  record.flush = () => queue;
  return record;
}

module.exports = { createUpdateDiagnostics };

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function writeUpdateSnapshot(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function singleFlight(operation) {
  let pending = null;
  return (...args) => {
    if (pending) return pending;
    pending = Promise.resolve().then(() => operation(...args)).finally(() => { pending = null; });
    return pending;
  };
}

function updateErrorState(error) {
  const message = String(error?.message || error || '');
  return { status: 'error', error: message, errorCode:
    error?.code === 'UPDATE_PROXY_REQUIRED' ? 'UPDATE_PROXY_REQUIRED' :
    /latest\.yml/i.test(message) && /404|not found/i.test(message)
      ? 'UPDATE_MANIFEST_MISSING' : 'UPDATE_FAILED' };
}

function reusableUpdateCheck(state, now = Date.now()) {
  const checked = Date.parse(state?.checkedAt || '');
  return state?.status === 'available' && state.updateAvailable === true
    && state.packageReady === true && Boolean(state.latestVersion && state.packageUrl)
    && Number.isFinite(checked) && checked <= now && now - checked < 60_000;
}

function progressReporter(publish, intervalMs = 250, clock = Date.now) {
  let last = -Infinity;
  return (value, force = false) => {
    const now = clock();
    if (!force && now - last < intervalMs) return false;
    last = now;
    publish(value);
    return true;
  };
}

function packageAvailability(updateAvailable, response, store) {
  if (!updateAvailable) return { status: 'current', error: '' };
  if (response.ok || (store.ok && store.hasUpdate)) return { status: 'available', error: '' };
  // Only an explicit missing package plus a successful Store check establishes
  // that the newer manifest has no installable package yet.
  if ([404, 410].includes(response.status) && store.ok && !store.hasUpdate) {
    return { status: 'propagating', error: '' };
  }
  return { status: 'error', error: [
    response.probeError || `Official package check returned HTTP ${response.status || 0}.`,
    store.error || '',
  ].filter(Boolean).join(' ') };
}

module.exports = { singleFlight, updateErrorState, writeUpdateSnapshot, reusableUpdateCheck, progressReporter, packageAvailability };

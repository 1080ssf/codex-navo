const fs = require('node:fs');

function readDebugPortFile(file, fsImpl = fs) {
  try {
    const [value] = fsImpl.readFileSync(file, 'utf8').split(/\r?\n/);
    const port = Number.parseInt(value, 10);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
  } catch {
    return 0;
  }
}

async function resolveChromeDebugPort({ browser, activePortFile, isPortReady, fsImpl = fs, now = Date.now }) {
  if (!browser || typeof isPortReady !== 'function') return 0;
  const candidates = [...new Set([
    Number(browser.port) || 0,
    readDebugPortFile(activePortFile, fsImpl),
  ].filter(Boolean))];
  for (const candidate of candidates) {
    if (!await isPortReady(candidate)) continue;
    browser.port = candidate;
    browser.debugUnavailableSince = 0;
    return candidate;
  }
  browser.debugUnavailableSince ||= now();
  return 0;
}

module.exports = { readDebugPortFile, resolveChromeDebugPort };

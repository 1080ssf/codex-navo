const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const versions = new Map();

function readVersion(executable) {
  const stat = fs.statSync(executable);
  const fingerprint = `${stat.size}:${stat.mtimeMs}`;
  const cached = versions.get(executable);
  if (cached?.fingerprint === fingerprint) return cached.version;
  const result = spawnSync(executable, ['--version'], {
    windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
  });
  const match = result.status === 0 && result.stdout?.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)(?![\w.-])/);
  const version = match ? match.slice(1).map(Number) : null;
  if (version) versions.set(executable, { fingerprint, version });
  return version;
}

function selectNewestCli(candidates, getVersion = readVersion) {
  let selected = null;
  let newest = null;
  for (const executable of [...new Set(candidates)]) {
    let version;
    try { version = getVersion(executable); } catch { continue; }
    if (!version) continue;
    const difference = newest ? version.map((part, index) => part - newest[index]).find(Boolean) || 0 : 1;
    if (difference > 0) { selected = executable; newest = version; }
  }
  if (!selected) throw new Error('No working stable Codex CLI was found; check the installed CLI or configure its path.');
  return selected;
}

module.exports = { selectNewestCli };

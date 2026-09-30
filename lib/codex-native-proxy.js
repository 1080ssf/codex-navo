const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'];
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Codex arg0 loads CODEX_HOME/.env before constructing its native HTTP clients.
// Persist the rollback record BEFORE changing that file: Windows app activation
// can drop the launcher's environment, and Navo can exit before Codex does.
function stageNativeProxy(launchView, codexHome, environment, persist) {
  if (launchView.nativeProxy) throw new Error('Codex native proxy is already staged');
  const file = path.join(codexHome, '.env');
  const backup = path.join(launchView.backupDir, 'native-proxy.env.backup');
  const hadFile = fs.existsSync(file);
  const original = hadFile ? fs.readFileSync(file) : Buffer.alloc(0);
  const values = KEYS.map(key => {
    const value = String(environment[key] ?? environment[key.toUpperCase()] ?? environment[key.toLowerCase()] ?? '');
    if (/[\r\n'\x00]/.test(value)) throw new Error('Invalid Codex proxy environment value');
    return `${key}='${value}'`;
  });
  const marker = crypto.randomBytes(12).toString('hex');
  const block = `\n# Navo native proxy ${marker}\n${values.join('\n')}\n# End Navo native proxy ${marker}\n`;
  const installed = Buffer.concat([original, Buffer.from(block)]);
  fs.mkdirSync(launchView.backupDir, { recursive: true });
  fs.writeFileSync(backup, original, { mode: 0o600 });
  launchView.nativeProxy = { file, backup, hadFile, originalHash: hash(original), installedHash: hash(installed), block, marker };
  persist();
  fs.writeFileSync(file, installed, { mode: 0o600 });
}

function restoreNativeProxy(record) {
  if (!record) return;
  if (!fs.existsSync(record.file)) return; // Respect an explicit user deletion.
  const current = fs.readFileSync(record.file);
  if (hash(current) === record.originalHash) return; // Staging never applied, or already restored.
  if (hash(current) === record.installedHash) {
    if (record.hadFile) {
      const original = fs.readFileSync(record.backup);
      if (hash(original) !== record.originalHash) throw new Error('Codex proxy backup mismatch');
      fs.writeFileSync(record.file, original, { mode: 0o600 });
    } else fs.unlinkSync(record.file);
    return;
  }
  const text = current.toString('utf8');
  const position = text.indexOf(record.block);
  if (position < 0) {
    if (!text.includes(record.marker)) return; // Already removed; preserve subsequent edits.
    throw new Error('Codex proxy settings changed during use; backup retained');
  }
  // Preserve unrelated edits made while Codex was running.
  fs.writeFileSync(record.file, text.slice(0, position) + text.slice(position + record.block.length), { mode: 0o600 });
}

module.exports = { stageNativeProxy, restoreNativeProxy };

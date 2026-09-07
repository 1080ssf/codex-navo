const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('js-yaml');

function verifyUpdateArtifacts(directory, version) {
  const manifest = yaml.load(fs.readFileSync(path.join(directory, 'latest.yml'), 'utf8'));
  const name = `Codex-Navo-Setup-${version}-windows-x64.exe`;
  if (String(manifest.version) !== version || manifest.path !== name) throw new Error('Update manifest version or installer path mismatch');
  const entry = manifest.files?.find((file) => file.url === name);
  if (!entry) throw new Error('Installer is missing from update manifest');
  const bytes = fs.readFileSync(path.join(directory, name));
  const digest = crypto.createHash('sha512').update(bytes).digest('base64');
  if (entry.size !== bytes.length || entry.sha512 !== digest || manifest.sha512 !== digest) {
    throw new Error('Installer size or SHA-512 does not match update manifest');
  }
  if (!fs.statSync(path.join(directory, `${name}.blockmap`)).size) throw new Error('Empty blockmap');
  return { installer: name, bytes: bytes.length };
}

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const result = verifyUpdateArtifacts(path.join(root, 'release', 'auto-update'), require('../package.json').version);
  process.stdout.write(`Verified update artifacts: ${result.installer} (${result.bytes} bytes)\n`);
}
module.exports = { verifyUpdateArtifacts };

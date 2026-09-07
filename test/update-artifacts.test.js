const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyUpdateArtifacts } = require('../scripts/verify-update-artifacts');

test('update artifact validation rejects mismatched versions, corrupt installers and missing blockmaps', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const name = 'Codex-Navo-Setup-1.2.3-windows-x64.exe';
  const bytes = Buffer.from('installer fixture');
  const digest = crypto.createHash('sha512').update(bytes).digest('base64');
  const manifest = { version: '1.2.3', path: name, sha512: digest,
    files: [{ url: name, size: bytes.length, sha512: digest }] };
  fs.writeFileSync(path.join(root, 'latest.yml'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(root, name), bytes);
  fs.writeFileSync(path.join(root, `${name}.blockmap`), 'fixture');
  assert.equal(verifyUpdateArtifacts(root, '1.2.3').bytes, bytes.length);
  assert.throws(() => verifyUpdateArtifacts(root, '1.2.4'), /version or installer path/);
  fs.writeFileSync(path.join(root, name), 'corrupt');
  assert.throws(() => verifyUpdateArtifacts(root, '1.2.3'), /size or SHA-512/);
  fs.writeFileSync(path.join(root, name), bytes);
  fs.unlinkSync(path.join(root, `${name}.blockmap`));
  assert.throws(() => verifyUpdateArtifacts(root, '1.2.3'), /ENOENT/);
});

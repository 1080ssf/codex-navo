const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildCodexPackageUrl,
  comparePackageVersions,
  parseCodexChangelog,
  parseCodexUpdateLog,
  readLatestCodexUpdateSignal,
  validateCodexPackageMetadata,
  validateCodexUpdateManifest,
} = require('../lib/codex-update-state');

test('Windows package versions compare by numeric component', () => {
  assert.equal(comparePackageVersions('26.810.7004.0', '26.803.10989.0'), 1);
  assert.equal(comparePackageVersions('26.803.10989.0', '26.803.10989'), 0);
  assert.equal(comparePackageVersions('26.803.9000.0', '26.803.10989.0'), -1);
});

test('official Codex manifest resolves the direct OpenAI MSIX package', () => {
  const manifest = validateCodexUpdateManifest({
    schemaVersion: 1,
    buildVersion: '26.810.7004.0',
    storeProductId: '9PLM9XGG6VKS',
    packageIdentity: 'OpenAI.Codex',
  });
  assert.equal(manifest.buildVersion, '26.810.7004.0');
  assert.equal(
    buildCodexPackageUrl(manifest.buildVersion, 'x64'),
    'https://persistent.oaistatic.com/codex-app-prod/releases/26.810.7004.0/ChatGPT-x64.msix',
  );
});

test('downloaded Codex package metadata must match OpenAI identity and target build', () => {
  const metadata = validateCodexPackageMetadata({
    Name: 'OpenAI.Codex',
    Publisher: 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B',
    Version: '26.810.7004.0',
    Architecture: 'x64',
  }, '26.810.7004.0', 'x64');
  assert.equal(metadata.name, 'OpenAI.Codex');
  assert.throws(() => validateCodexPackageMetadata({ ...metadata, publisher: 'CN=fixture' }, '26.810.7004.0', 'x64'), /publisher/);
});

test('official Codex changelog entries retain English and localized Chinese copy', () => {
  const html = '<li id="codex-2026-08-13-app" data-codex-topics="codex-app"><time>2026-08-13</time><h3><span>Computer History</span></h3><article><p>Official body.</p></article></li>';
  const entries = parseCodexChangelog(html);
  assert.equal(entries[0].en.title, 'Computer History');
  assert.equal(entries[0].en.body, 'Official body.');
  assert.equal(entries[0].zh.title, '电脑历史记录');
});

test('Codex updater logs expose the official manifest version independently of winget', () => {
  const parsed = parseCodexUpdateLog([
    'info [windows-store-updater] Checking Windows Store for package updates buildVersion=26.803.10989.0 manifestBuildVersion=26.810.6296.0 packageIdentity=OpenAI.Codex',
    'info [windows-store-updater] Checking Windows Store for package updates buildVersion=26.803.10989.0 manifestBuildVersion=26.810.7004.0 packageIdentity=OpenAI.Codex',
  ].join('\n'));
  assert.deepEqual(parsed, { installedVersion: '26.803.10989.0', manifestVersion: '26.810.7004.0' });
});

test('latest Codex update signal is read from the packaged app log location', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-update-state-'));
  const family = 'OpenAI.Codex_fixture';
  const logRoot = path.join(root, 'Packages', family, 'LocalCache', 'Local', 'Codex', 'Logs', '2026', '08', '16');
  try {
    fs.mkdirSync(logRoot, { recursive: true });
    fs.writeFileSync(path.join(logRoot, 'codex-desktop-fixture.log'),
      'Checking Windows Store for package updates buildVersion=26.803.10989.0 manifestBuildVersion=26.810.7004.0 packageIdentity=OpenAI.Codex\n');
    const signal = readLatestCodexUpdateSignal({ localAppData: root, packageFamilyName: family });
    assert.equal(signal.installedVersion, '26.803.10989.0');
    assert.equal(signal.manifestVersion, '26.810.7004.0');
    assert.match(signal.detectedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

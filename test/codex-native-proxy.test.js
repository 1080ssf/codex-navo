const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stageNativeProxy, restoreNativeProxy } = require('../lib/codex-native-proxy');

function fixture(t, original) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-native-proxy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.env');
  if (original !== undefined) fs.writeFileSync(file, original);
  return { home, file, view: { backupDir: path.join(home, 'backup') } };
}

test('native proxy journal precedes mutation and restores original bytes', t => {
  const original = '# keep\r\nOTHER=hello\r\nHTTPS_PROXY=http://old.invalid:80\r\n';
  const { home, file, view } = fixture(t, original);
  stageNativeProxy(view, home, { HTTPS_PROXY: 'http://127.0.0.1:18301', OPENAI_API_KEY: 'never-copy' }, () => {
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.ok(view.nativeProxy.backup);
  });
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.endsWith(view.nativeProxy.block));
  assert.match(content, /HTTPS_PROXY='http:\/\/127.0.0.1:18301'/);
  assert.match(content, /https_proxy='http:\/\/127.0.0.1:18301'/);
  assert.ok(!content.includes('never-copy'));
  restoreNativeProxy(view.nativeProxy);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  restoreNativeProxy(view.nativeProxy);
});

test('native proxy restores absent file and preserves unrelated live edits', t => {
  const { home, file, view } = fixture(t);
  stageNativeProxy(view, home, {}, () => {});
  restoreNativeProxy(view.nativeProxy);
  assert.equal(fs.existsSync(file), false);
  const next = { backupDir: view.backupDir };
  stageNativeProxy(next, home, {}, () => {});
  fs.appendFileSync(file, 'USER_ADDED=value\n');
  restoreNativeProxy(next.nativeProxy);
  assert.equal(fs.readFileSync(file, 'utf8'), 'USER_ADDED=value\n');
  restoreNativeProxy(next.nativeProxy);
  assert.equal(fs.readFileSync(file, 'utf8'), 'USER_ADDED=value\n');
});

test('failed journal persistence leaves original untouched', t => {
  const { home, file, view } = fixture(t, 'KEEP=value\n');
  assert.throws(() => stageNativeProxy(view, home, {}, () => { throw new Error('write failed'); }), /write failed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'KEEP=value\n');
});

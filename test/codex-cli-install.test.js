const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { CliInstaller, stableAsset, RELEASE_URL } = require('../lib/codex-cli-install');
const { probeCliProtocol } = require('../lib/codex-cli-probe');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-cli-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executableName = 'codex-x86_64-pc-windows-msvc.exe';
  const bytes = Buffer.from('mock executable, never launched');
  const header = Buffer.alloc(512);
  header.write(executableName); header.write(bytes.length.toString(8).padStart(11, '0'), 124); header[156] = 48;
  const archive = zlib.gzipSync(Buffer.concat([header, bytes, Buffer.alloc(512 - bytes.length), Buffer.alloc(1024)]));
  const asset = { name: `${executableName}.tar.gz`, size: archive.length, digest: `sha256:${crypto.createHash('sha256').update(archive).digest('hex')}`,
    browser_download_url: `https://github.com/openai/codex/releases/download/rust-v1.2.3/${executableName}.tar.gz` };
  const release = { tag_name: 'rust-v1.2.3', prerelease: false, draft: false, assets: [asset] };
  const calls = [], activated = [];
  const installer = new CliInstaller({ root, platform: 'win32', arch: 'x64',
    network: async () => ({ fetch: async (url, init) => {
      calls.push({ url, signal: init.signal });
      return url === RELEASE_URL ? new Response(JSON.stringify(release)) : new Response(archive);
    } }),
    run: async executable => { assert.deepEqual(fs.readFileSync(executable), bytes); return { exitCode: 0, stdout: 'codex-cli 1.2.3' }; },
    probe: async () => ({ ok: true }), activate: async executable => { activated.push(executable); }, ...options });
  return { root, installer, calls, release, archive, activated };
}

test('official stable asset selection rejects preview, missing checksum, unsupported arch and wrong URL', () => {
  const release = { tag_name:'rust-v1.2.3', prerelease:false, assets:[] };
  for (const invalid of [release, { ...release, tag_name:'rust-v1.2.3-alpha.1' }, { ...release, prerelease:true }]) {
    assert.throws(() => stableAsset(invalid, 'x64'), /release_invalid/);
  }
  assert.throws(() => stableAsset(release, 'ia32'), /unsupported_platform/);
});

test('stable installer downloads, checks, extracts and validates before atomically activating', async t => {
  const f = fixture(t);
  f.installer.start(); f.installer.start();
  await f.installer.pending;
  assert.equal(f.installer.snapshot().status, 'complete');
  assert.equal(f.installer.snapshot().progress, 100);
  assert.equal(f.calls.length, 2, 'duplicate starts share one install');
  assert.equal(f.activated.length, 1);
  assert.match(f.activated[0], /stable-1\.2\.3-/);
  assert.deepEqual(fs.readdirSync(f.root), [path.basename(path.dirname(f.activated[0]))]);
  assert.equal(fs.existsSync(path.join(path.dirname(f.activated[0]), 'cli.tar.gz')), false);
});

test('checksum mismatch never executes or activates downloaded bytes and removes staging', async t => {
  let probes = 0;
  const f = fixture(t, { run: async () => { probes++; } });
  f.release.assets[0].digest = 'sha256:' + '0'.repeat(64);
  f.installer.start(); await f.installer.pending;
  assert.equal(f.installer.snapshot().errorCode, 'integrity_failed');
  assert.equal(probes, 0); assert.equal(f.activated.length, 0); assert.deepEqual(fs.readdirSync(f.root), []);
});

test('handshake or stable version failure preserves the previous CLI and configuration', async t => {
  for (const options of [{ probe: async () => ({ ok:false, code:'protocol_failed' }) },
    { run: async () => ({exitCode:0, stdout:'codex-cli 1.2.3-alpha.1'}) }]) {
    const f = fixture(t, options);
    fs.mkdirSync(path.join(f.root, 'stable-1.0.0-previous'));
    fs.writeFileSync(path.join(f.root, 'stable-1.0.0-previous', 'codex.exe'), 'previous');
    f.installer.start(); await f.installer.pending;
    assert.equal(f.installer.snapshot().status, 'error'); assert.equal(f.activated.length, 0);
    assert.deepEqual(fs.readdirSync(f.root), ['stable-1.0.0-previous']);
  }
});

test('cancellation ends stalled network preparation; retry can succeed', async t => {
  let release, closed = false;
  const f = fixture(t, { network: () => new Promise(resolve => { release = resolve; }) });
  f.installer.start(); await new Promise(resolve => setImmediate(resolve)); f.installer.cancel(); await f.installer.pending;
  assert.equal(f.installer.snapshot().status, 'cancelled'); assert.equal(f.installer.snapshot().busy, false);
  release({ close: () => { closed = true; } }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, true);
});

test('download HTTP failures retain a specific status code without exposing raw output', async t => {
  const f = fixture(t, { network: async () => ({ fetch: async () => new Response('private server detail', { status: 403 }) }) });
  f.installer.start(); await f.installer.pending;
  assert.equal(f.installer.snapshot().errorCode, 'http_error'); assert.equal(f.installer.snapshot().httpStatus, 403);
  assert.doesNotMatch(JSON.stringify(f.installer.snapshot()), /private server detail/);
});

test('handshake probe uses an empty isolated home and only sends initialize/initialized', async () => {
  let temporary;
  const result = await probeCliProtocol('mock.exe', 3000, { spawnProcess: (_exe, args, options) => {
    assert.deepEqual(args, ['app-server']); assert.equal(options.windowsHide, true);
    temporary = options.env.CODEX_HOME;
    assert.equal(options.cwd, temporary); assert.deepEqual(fs.readdirSync(temporary), []);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    return spawn(process.execPath, ['-e', `process.stdin.on('data',data=>{for(const line of data.toString().trim().split('\\n')){const m=JSON.parse(line);if(m.method==='initialize')process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'fixture'}})+'\\n');else if(m.method!=='initialized')process.exit(4)}});`], options);
  } });
  assert.equal(result.ok, true); assert.equal(fs.existsSync(temporary), false);
});

test('handshake timeout and malformed response fail promptly and clean up', async () => {
  for (const script of ['setInterval(()=>{},1000)', `process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:'navo-cli-probe',result:{}})+'\\n'));`]) {
    let temporary;
    const result = await probeCliProtocol('mock.exe', 100, { spawnProcess: (_exe, _args, options) => {
      temporary = options.env.CODEX_HOME;
      return spawn(process.execPath, ['-e', script], options);
    } });
    assert.equal(result.ok, false); assert.ok(['protocol_timeout','protocol_failed'].includes(result.code));
    assert.equal(fs.existsSync(temporary), false);
  }
});

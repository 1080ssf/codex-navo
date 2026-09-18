const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform, addAbortSignal } = require('node:stream');
const { parseCliVersion, runHidden } = require('./codex-cli-selection');
const { probeCliProtocol } = require('./codex-cli-probe');

const RELEASE_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const MAX_BYTES = 512 * 1024 * 1024;
const fail = (code, status) => Object.assign(new Error(code), { code, status });

function stableAsset(release, arch) {
  const target = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!target) throw fail('unsupported_platform');
  const version = /^rust-v(\d+\.\d+\.\d+)$/.exec(release?.tag_name || '')?.[1];
  if (!version || release.prerelease !== false || release.draft === true) throw fail('release_invalid');
  const executableName = `codex-${target}-pc-windows-msvc.exe`;
  const name = `${executableName}.tar.gz`;
  const asset = release.assets?.find(item => item.name === name);
  const expectedUrl = `https://github.com/openai/codex/releases/download/rust-v${version}/${name}`;
  if (!asset || asset.browser_download_url !== expectedUrl || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES) throw fail('release_invalid');
  return { ...asset, version, executableName, sha256: asset.digest.slice(7) };
}

// Extract only the exact expected regular file. No archive path becomes a destination path.
async function extractCli(archive, destination, executableName, signal) {
  const input = fs.createReadStream(archive);
  const gzip = zlib.createGunzip();
  input.on('error', error => gzip.destroy(error));
  const stream = addAbortSignal(signal, input.pipe(gzip));
  let buffer = Buffer.alloc(0), remaining = 0, padding = 0, write = false, found = false, ended = false, expanded = 0;
  const output = await fs.promises.open(destination, 'wx');
  try {
    for await (const chunk of stream) {
      expanded += chunk.length;
      if (expanded > MAX_BYTES) throw fail('archive_invalid');
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (remaining) {
          const size = Math.min(buffer.length, remaining);
          if (write) {
            let offset = 0;
            while (offset < size) offset += (await output.write(buffer, offset, size - offset)).bytesWritten;
          }
          buffer = buffer.subarray(size); remaining -= size;
        } else if (padding) {
          const size = Math.min(buffer.length, padding); buffer = buffer.subarray(size); padding -= size;
        } else {
          if (buffer.length < 512) break;
          const header = buffer.subarray(0, 512); buffer = buffer.subarray(512);
          if (header.every(byte => byte === 0)) { ended = true; continue; }
          if (ended) throw fail('archive_invalid');
          const name = header.subarray(0, 100).toString('utf8').split('\0')[0];
          const size = header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim();
          if (!/^[0-7]+$/.test(size)) throw fail('archive_invalid');
          remaining = parseInt(size, 8);
          if (remaining > MAX_BYTES) throw fail('archive_invalid');
          padding = (512 - remaining % 512) % 512;
          write = name === executableName || name === `./${executableName}`;
          if (write) {
            if (found || ![0, 48].includes(header[156]) || remaining === 0) throw fail('archive_invalid');
            found = true;
          }
        }
      }
    }
    if (!found || remaining || padding || !ended) throw fail('archive_invalid');
  } finally { input.destroy(); gzip.destroy(); await output.close(); }
}

class CliInstaller {
  constructor({ root, platform = process.platform, arch = process.arch, network = async () => ({ fetch: globalThis.fetch }),
    run = runHidden, probe = probeCliProtocol, activate = async () => {}, timeoutMs = 10 * 60_000 } = {}) {
    Object.assign(this, { root: path.resolve(root), platform, arch, network, run, probe, activate, timeoutMs });
    this.state = { status: 'idle', busy: false, progress: 0 };
    this.pending = null;
  }
  snapshot() { return { ...this.state }; }
  update(patch) { this.state = { ...this.state, ...patch }; }
  start() {
    if (this.pending) return this.snapshot();
    this.controller = new AbortController();
    this.state = { status: 'checking', busy: true, progress: 0, receivedBytes: 0, totalBytes: 0, version: '', errorCode: '' };
    this.pending = this.install(this.controller.signal).catch(error => {
      this.update({ status: this.controller.signal.aborted && this.controller.signal.reason?.code === 'cancelled' ? 'cancelled' : 'error',
        errorCode: this.controller.signal.reason?.code || error.code || 'network_failed', httpStatus: Number(error.status) || 0,
        errorOperation: error.syscall || '' });
    }).finally(() => { this.update({ busy: false }); this.pending = null; });
    return this.snapshot();
  }
  cancel() {
    if (this.state.busy && ['checking', 'downloading'].includes(this.state.status)) this.controller.abort(fail('cancelled'));
    return this.snapshot();
  }
  async install(signal) {
    let connection, staging, destination, verified = false;
    const deadline = setTimeout(() => this.controller.abort(fail('download_timeout')), this.timeoutMs);
    const check = () => { if (signal.aborted) throw signal.reason; };
    const request = async (url, options = {}) => {
      check();
      const response = await connection.fetch(url, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        headers: { 'User-Agent': 'Codex-Navo-CLI-Installer', Accept: 'application/vnd.github+json' } });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw fail('http_error', response.status); }
      if (response.url && new URL(response.url).protocol !== 'https:') throw fail('release_invalid');
      return response;
    };
    try {
      if (this.platform !== 'win32') throw fail('unsupported_platform');
      // Let cancellation end a stalled proxy preparation without altering the proxy itself.
      connection = await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve().then(() => this.network()).then(value => {
          if (signal.aborted) { void value.close?.(); reject(signal.reason); } else resolve(value);
        }, reject).finally(() => signal.removeEventListener('abort', abort));
      });
      const metadata = await request(RELEASE_URL);
      const releaseText = await metadata.text();
      if (releaseText.length > 2 * 1024 * 1024) throw fail('release_invalid');
      const asset = stableAsset(JSON.parse(releaseText), this.arch);
      this.update({ version: asset.version, totalBytes: asset.size });
      await fs.promises.mkdir(this.root, { recursive: true });
      staging = await fs.promises.mkdtemp(path.join(this.root, '.install-'));
      const archive = path.join(staging, 'cli.tar.gz');
      this.update({ status: 'downloading', progress: 1 });
      check();
      // A body download has a total deadline plus an inactivity watchdog, not a 30s total cap.
      let response;
      const headersDeadline = setTimeout(() => this.controller.abort(fail('download_timeout')), 30_000);
      try { response = await connection.fetch(asset.browser_download_url, { signal, headers: { 'User-Agent': 'Codex-Navo-CLI-Installer' } }); }
      finally { clearTimeout(headersDeadline); }
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw fail('http_error', response.status); }
      if (response.url && new URL(response.url).protocol !== 'https:') throw fail('release_invalid');
      let received = 0, idleTimer;
      const heartbeat = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => this.controller.abort(fail('download_timeout')), 30_000); };
      const hash = crypto.createHash('sha256');
      const counter = new Transform({ transform: (chunk, _encoding, callback) => {
        heartbeat(); received += chunk.length;
        if (received > asset.size) { callback(fail('integrity_failed')); return; }
        hash.update(chunk); this.update({ receivedBytes: received, progress: 1 + Math.floor(received / asset.size * 79) });
        callback(null, chunk);
      } });
      heartbeat();
      try { await pipeline(response.body, counter, fs.createWriteStream(archive, { flags: 'wx' }), { signal }); }
      finally { clearTimeout(idleTimer); }
      this.update({ status: 'verifying', progress: 82 });
      if (received !== asset.size || hash.digest('hex') !== asset.sha256) throw fail('integrity_failed');
      check();
      this.update({ status: 'extracting', progress: 86 });
      destination = path.join(this.root, `stable-${asset.version}-${crypto.randomUUID()}`);
      await fs.promises.mkdir(destination);
      const executable = path.join(destination, 'codex.exe');
      await extractCli(archive, executable, asset.executableName, signal);
      this.update({ status: 'validating', progress: 92 });
      const output = await this.run(executable, ['--version'], 8000);
      const version = parseCliVersion(output.stdout, output.stderr);
      if (output.code || output.exitCode !== 0 || !version?.stable || version.version !== asset.version) throw fail('version_failed');
      const protocol = await this.probe(executable, 12000);
      if (!protocol.ok) throw fail(protocol.code || 'protocol_failed');
      check();
      // Do not rename a directory after executing its binary on Windows. Publish
      // a marker only after validation; discovery ignores all unfinished installs.
      await fs.promises.writeFile(path.join(destination, 'ready.json'), JSON.stringify({ version: asset.version, sha256: asset.sha256 }), { flag: 'wx' });
      verified = true;
      this.update({ status: 'activating', progress: 98 });
      const installedPath = path.join(destination, 'codex.exe');
      await this.activate(installedPath);
      this.update({ status: 'complete', progress: 100, installedPath });
    } finally {
      clearTimeout(deadline);
      if (staging && path.dirname(staging) === this.root && path.basename(staging).startsWith('.install-')) {
        await fs.promises.rm(staging, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      }
      if (destination && !verified && path.dirname(destination) === this.root && /^stable-\d+\.\d+\.\d+-[\w-]+$/.test(path.basename(destination))) {
        await fs.promises.rm(destination, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      }
      void connection?.close?.();
    }
  }
}

module.exports = { CliInstaller, stableAsset, extractCli, RELEASE_URL };

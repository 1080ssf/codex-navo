const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { CancellationToken } = require('builder-util-runtime');

test('desktop cancellation imports the constructor from its real runtime export', () => {
  const source = fs.readFileSync(path.join(__dirname, '../desktop-src/main.js'), 'utf8');
  const declaration = source.match(/const \{ CancellationToken \} = require\('([^']+)'\);/);
  assert.ok(declaration, 'cancellation token has an explicit runtime import');
  const RuntimeToken = require(declaration[1]).CancellationToken;
  const token = new RuntimeToken();
  assert.equal(token.cancelled, false);
  token.cancel();
  assert.equal(token.cancelled, true);
});
const updateOperation = require('../lib/update-operation');
const { probeUpdatePackage } = require('../lib/update-package-probe');
const codexPackage = require('../lib/codex-update-state');

const source = fs.readFileSync(path.join(__dirname, '../desktop-src/main.js'), 'utf8');
function section(start, end) {
  const left = source.indexOf(start);
  const right = source.indexOf(end, left);
  assert.ok(left >= 0 && right > left, `Missing desktop source section: ${start}`);
  return source.slice(left, right);
}

// Load the actual state/IPC functions, but never Electron startup, real network,
// filesystem writes, process queries, or installers.
function harness() {
  const handlers = new Map();
  const snapshots = [];
  const autoUpdater = new EventEmitter();
  const context = vm.createContext({
    ...updateOperation, ...codexPackage, probeUpdatePackage, CancellationToken, URL, AbortSignal, path,
    app: { isPackaged: true, getVersion: () => '1.2.146' },
    autoUpdater, mainWindow: null, updaterConfigured: false, updateTimer: null,
    navoDownloadToken: null, codexDownloadController: null, isQuitting: false,
    codexInstallInProgress: false,
    USER_DATA_ROOT: 'mock-user-data', UPDATE_START_DELAY_MS: 1, UPDATE_INTERVAL_MS: 1,
    setTimeout: () => 1, setInterval: () => 1, setImmediate: (fn) => fn(),
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    writeUpdateSnapshot: (_file, value) => snapshots.push({ ...value }),
    recordUpdateDiagnostic: () => {},
    configureUpdaterNetwork: async () => ({ nodeName: 'Mock route' }),
    codexUpdateSession: () => ({ fetch: async () => { throw new Error('Network must be mocked'); } }),
    readInstalledCodexPackageState: async () => ({ installed: true, version: '26.1.0.0' }),
    runCodexStoreHelper: async () => { throw new Error('Store must be mocked'); },
  });
  vm.runInContext([
    section('let updateState =', 'function showMainWindow'),
    section('function normalizeReleaseNotes', 'async function readInstalledCodexPackageState'),
    section('function publishCodexUpdateState', 'function codexStoreHelperPath'),
    section('async function fetchOfficialCodexUpdateState', 'async function codexDesktopProcessIds'),
    section('async function installCodexWindowsUpdate', 'async function createWindow'),
    'registerUpdaterIpc(); configureAutoUpdater();',
  ].join('\n'), context);
  return { context, handlers, snapshots, autoUpdater,
    run: (code) => vm.runInContext(code, context),
    invoke: (name, ...args) => handlers.get(name)(null, ...args),
  };
}

function mockManifest(h, { version = '26.2.0.0', installed = version, packageStatus = 200,
  fallbackStatus = packageStatus, store = { ok: true, hasUpdate: false } } = {}) {
  const calls = [];
  h.context.codexUpdateSession = () => ({ fetch: async (url, options) => {
    calls.push(options.method || 'GET');
    if (url === codexPackage.CODEX_UPDATE_MANIFEST_URL) return {
      ok: true, url, json: async () => ({ schemaVersion: 1, buildVersion: version, storeProductId: '9PLM9XGG6VKS', packageIdentity: 'OpenAI.Codex' }),
    };
    const status = options.method === 'HEAD' ? packageStatus : fallbackStatus;
    return { ok: status >= 200 && status < 300, status, url,
      headers: new Headers(status === 206 ? { 'content-range': 'bytes 0-0/1000', 'content-length': '1' } : {}) };
  } });
  h.context.readInstalledCodexPackageState = async () => ({ installed: true, version: installed });
  h.context.runCodexStoreHelper = async () => { calls.push('STORE'); return store; };
  return calls;
}

test('Codex state reads are synchronous cache reads; explicit checks share the same flight', async () => {
  const h = harness();
  assert.equal(h.invoke('codex-updates:get-state').status, 'idle');
  assert.equal(h.snapshots.length, 0);
  const calls = mockManifest(h);
  let release;
  h.context.configureUpdaterNetwork = () => new Promise((resolve) => { release = resolve; });
  const first = h.invoke('codex-updates:check');
  const second = h.invoke('codex-updates:check');
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(h.invoke('codex-updates:get-state').status, 'checking');
  release({});
  const result = await first;
  assert.equal(result.status, 'current');
  assert.deepEqual(calls, ['GET']);
  const writes = h.snapshots.length;
  assert.equal(h.invoke('codex-updates:get-state'), result);
  assert.equal(h.snapshots.length, writes);
});

test('equal or newer installed versions skip all direct-package and Store probes', async () => {
  for (const installed of ['26.2.0.0', '26.3.0.0']) {
    const h = harness();
    const calls = mockManifest(h, { installed, packageStatus: 503 });
    const state = await h.invoke('codex-updates:check');
    assert.equal(state.status, 'current');
    assert.equal(state.updateAvailable, false);
    assert.equal(state.storeCheckStatus, 'not-needed');
    assert.deepEqual(calls, ['GET']);
    assert.ok(state.checkedAt);
    assert.ok(state.stageTimings.manifest >= 0);
  }
});

test('failed manifest or package probes retain the last successful snapshot and check time', async () => {
  const h = harness();
  mockManifest(h, { installed: '26.1.0.0' });
  const known = await h.invoke('codex-updates:check');
  assert.equal(known.status, 'available');
  for (const failure of ['manifest', 'package']) {
    mockManifest(h, { version: '26.4.0.0', installed: '26.1.0.0', packageStatus: 405, store: { ok: false, error: 'Store unavailable' } });
    if (failure === 'manifest') h.context.codexUpdateSession = () => ({ fetch: async () => { throw new Error('Offline'); } });
    const state = await h.invoke('codex-updates:check');
    assert.equal(state.status, 'error');
    assert.equal(state.latestVersion, known.latestVersion);
    assert.equal(state.version, known.version);
    assert.equal(state.packageUrl, known.packageUrl);
    assert.equal(state.checkedAt, known.checkedAt);
    assert.equal(state.stale, true);
    assert.ok(state.checkFailedAt);
    assert.ok(state.checkAttemptedAt);
  }
});

test('missing direct package is propagation only with a confirmed successful Store check', async () => {
  const h = harness();
  mockManifest(h, { installed: '26.1.0.0', packageStatus: 404 });
  assert.equal((await h.invoke('codex-updates:check')).status, 'propagating');
  mockManifest(h, { installed: '26.1.0.0', packageStatus: 404, store: { ok: false, error: 'timeout' } });
  assert.equal((await h.invoke('codex-updates:check')).status, 'error');
});

test('method-unsupported HEAD uses a bounded GET probe and preserves both statuses without a Store check', async () => {
  const h = harness();
  const calls = mockManifest(h, { installed: '26.1.0.0', packageStatus: 405, fallbackStatus: 206,
    store: { ok: false, error: 'Store should not be called' } });
  const state = await h.invoke('codex-updates:check');
  assert.equal(state.status, 'available');
  assert.equal(state.updateSource, 'msix');
  assert.equal(state.directPackageStatus, 206);
  assert.equal(state.directPackageHeadStatus, 405);
  assert.equal(state.directPackageProbeMethod, 'GET-range');
  assert.deepEqual(calls, ['GET', 'HEAD', 'GET']);
});

test('Codex install completion still requires actual installed version readback', async () => {
  const h = harness();
  mockManifest(h, { installed: '26.1.0.0' });
  await h.invoke('codex-updates:check');
  let installs = 0;
  h.context.downloadCodexPackage = async () => ({ path: 'mock.msix', sha256: 'mock' });
  h.context.readCodexPackageMetadata = async () => ({
    Name: 'OpenAI.Codex', Publisher: codexPackage.CODEX_PACKAGE_PUBLISHER,
    Version: '26.2.0.0', Architecture: process.arch,
  });
  h.context.codexDesktopIsRunning = async () => false;
  h.context.installCodexPackage = async () => { installs++; };
  h.context.waitForInstalledCodexVersion = async () => ({ installed: true, version: '26.1.0.0' });
  const state = await h.invoke('codex-updates:install');
  assert.equal(installs, 1);
  assert.equal(state.status, 'error');
  assert.match(state.error, /still v26.1.0.0/);
  assert.ok(h.snapshots.some((state) => state.phase === 'verifying-install'));
  assert.equal(h.snapshots.some((state) => state.status === 'completed'), false);
});

test('a failed Store install can recheck a HEAD-unsupported direct package before verified deployment', async () => {
  const h = harness();
  mockManifest(h, { installed: '26.1.0.0', packageStatus: 404, store: { ok: true, hasUpdate: true } });
  assert.equal((await h.invoke('codex-updates:check')).updateSource, 'store');
  const packageCalls = [];
  h.context.codexUpdateSession = () => ({ fetch: async (url, options) => {
    packageCalls.push(options.method);
    return { url, status: options.method === 'HEAD' ? 405 : 206,
      headers: new Headers(options.method === 'HEAD' ? {} : { 'content-range': 'bytes 0-0/1000', 'content-length': '1' }) };
  } });
  h.context.runCodexStoreHelper = async () => ({ ok: false, overallState: 'Failed' });
  let versionReads = 0, installs = 0;
  h.context.waitForInstalledCodexVersion = async () => ({ installed: true, version: ++versionReads === 1 ? '26.1.0.0' : '26.2.0.0' });
  h.context.codexDesktopIsRunning = async () => false;
  h.context.downloadCodexPackage = async () => ({ path: 'never-created-fixture.msix', sha256: 'fixture' });
  h.context.readCodexPackageMetadata = async () => ({ Name: 'OpenAI.Codex', Publisher: codexPackage.CODEX_PACKAGE_PUBLISHER,
    Version: '26.2.0.0', Architecture: process.arch });
  h.context.installCodexPackage = async () => { installs++; };
  h.context.fs = { rmSync() {} };
  const state = await h.invoke('codex-updates:install');
  assert.deepEqual(packageCalls, ['HEAD', 'GET']);
  assert.equal(state.directPackageHeadStatus, 405);
  assert.equal(state.directPackageStatus, 206);
  assert.equal(state.status, 'completed');
  assert.equal(state.version, '26.2.0.0');
  assert.equal(installs, 1);
  assert.equal(versionReads, 2);
});

test('Navo cancellation before network preparation finishes never starts a download', async () => {
  const h = harness();
  h.autoUpdater.emit('update-available', { version: '1.2.147' });
  let release;
  let downloads = 0;
  h.context.configureUpdaterNetwork = () => new Promise((resolve) => { release = resolve; });
  h.autoUpdater.downloadUpdate = async () => { downloads++; };
  const pending = h.invoke('updates:download');
  assert.equal(h.invoke('updates:download'), pending);
  await Promise.resolve();
  assert.equal(h.invoke('updates:cancel-download'), true);
  assert.equal(h.invoke('updates:get-state').status, 'cancelling');
  release({});
  const result = await pending;
  assert.equal(downloads, 0);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error, '');
  assert.equal(result.cancelled, true);
  assert.equal(h.invoke('updates:install'), false);
});

test('manual checks cannot reconfigure the network during Codex install preparation', async () => {
  const h = harness();
  const calls = mockManifest(h, { installed: '26.1.0.0' });
  await h.invoke('codex-updates:check');
  let release;
  h.context.readInstalledCodexPackageState = () => new Promise((resolve) => { release = resolve; });
  const pending = h.invoke('codex-updates:install');
  await Promise.resolve();
  const before = calls.length;
  assert.equal(h.invoke('codex-updates:check'), h.invoke('codex-updates:get-state'));
  release({ installed: true, version: '26.2.0.0' });
  assert.equal((await pending).status, 'current');
  assert.equal(calls.length, before);
});

test('preload exposes explicit checks and cancellation while preserving the CLI selector bridge', async () => {
  const exposed = {};
  const calls = [];
  const bridge = { contextBridge: { exposeInMainWorld: (key, value) => { exposed[key] = value; } },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../desktop-src/preload.js'), 'utf8'), { require: () => bridge });
  await exposed.codexUpdater.getCodexState();
  await exposed.codexUpdater.checkCodex();
  await exposed.codexUpdater.cancelDownload();
  await exposed.codexRuntime.selectCli('zh-CN');
  assert.deepEqual(calls, [['codex-updates:get-state'], ['codex-updates:check'], ['updates:cancel-download'], ['runtime:select-cli', 'zh-CN']]);
});

test('Navo download cancellation reaches the library token and can be retried', async () => {
  const h = harness();
  h.autoUpdater.emit('update-available', { version: '1.2.147' });
  let started;
  const start = new Promise((resolve) => { started = resolve; });
  h.autoUpdater.downloadUpdate = (token) => token.createPromise((_resolve, reject) => {
    token.onCancel(() => { h.autoUpdater.emit('error', new Error('cancelled transport')); reject(new Error('cancelled')); });
    started();
  });
  const pending = h.invoke('updates:download');
  await start;
  assert.equal(h.invoke('updates:cancel-download'), true);
  h.autoUpdater.emit('download-progress', { percent: 30, transferred: 30, total: 100 });
  h.autoUpdater.emit('update-downloaded', { version: '1.2.147' });
  assert.equal((await pending).status, 'cancelled');
  h.autoUpdater.downloadUpdate = async () => h.autoUpdater.emit('update-downloaded', { version: '1.2.147' });
  assert.equal((await h.invoke('updates:download')).status, 'downloaded');
  assert.equal(h.invoke('updates:cancel-download'), false);
});

test('Navo progress snapshots are throttled; transmission, verification and explicit install remain distinct', async () => {
  const h = harness();
  assert.equal(h.autoUpdater.autoInstallOnAppQuit, false);
  h.autoUpdater.emit('update-available', { version: '1.2.147' });
  h.autoUpdater.downloadUpdate = async () => {
    const before = h.snapshots.length;
    for (let index = 1; index < 100; index++) h.autoUpdater.emit('download-progress', { transferred: index, total: 100, percent: index });
    assert.ok(h.snapshots.length - before <= 2);
    h.autoUpdater.emit('download-progress', { transferred: 100, total: 100, percent: 100 });
    assert.equal(h.invoke('updates:get-state').status, 'verifying');
    assert.equal(h.invoke('updates:cancel-download'), false);
    assert.equal(h.invoke('updates:install'), false);
    h.autoUpdater.emit('update-downloaded', { version: '1.2.147' });
  };
  await h.invoke('updates:download');
  assert.equal(h.invoke('updates:get-state').status, 'downloaded');
  let installs = 0;
  h.autoUpdater.quitAndInstall = () => { installs++; };
  assert.equal(h.invoke('updates:install'), true);
  assert.equal(installs, 1);
  assert.equal(h.invoke('updates:get-state').status, 'installing');
  assert.equal(h.invoke('updates:install'), false);
});

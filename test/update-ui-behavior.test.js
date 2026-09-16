const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing production UI section: ${start}`);
  return source.slice(first, last);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

function element() {
  const classes = new Set(), attributes = new Map(), children = new Map();
  return {
    textContent: '', hidden: false, disabled: false, className: '', dataset: {}, style: {},
    setAttribute: (name, value) => attributes.set(name, value), getAttribute: name => attributes.get(name),
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
    querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
  };
}

// Load actual render/actions without bootstrapping accounts or Electron. Every
// updater call below is a fixture and cannot check/download/install anything.
function harness(options = {}) {
  const elementMap = new Map(), calls = [], listeners = new Map(), toasts = [];
  const elements = new Proxy({}, { get(_target, key) { if (!elementMap.has(key)) elementMap.set(key, element()); return elementMap.get(key); } });
  const updater = {};
  for (const name of ['getState', 'check', 'download', 'cancelDownload', 'install', 'getCodexState', 'checkCodex', 'installCodexUpdate', 'cancelCodexDownload']) {
    updater[name] = async (...args) => {
      calls.push({ name, args });
      if (options[name]) return options[name](...args);
      return name.toLowerCase().includes('codex') ? { status: 'idle', installed: true, version: '26.1.0.0' } : { status: 'idle', currentVersion: '1.2.146' };
    };
  }
  updater.onState = callback => listeners.set('navo', callback);
  updater.onCodexState = callback => listeners.set('codex', callback);
  const context = vm.createContext({
    elements, window: { codexUpdater: updater },
    state: { appLocale: options.chinese === false ? 'en' : 'zh-CN' },
    navoUsesChinese: () => options.chinese !== false,
    showAppPage() {}, loadLanguageSettings() {}, showToast: (...args) => toasts.push(args),
  });
  vm.runInContext([
    section('function tr(zh, en)', 'function formatLaunchSize'),
    section('let applicationUpdate =', 'async function initializeFloatingWindow'),
    section('async function openApplicationSettings()', 'elements.updateChip.addEventListener'),
  ].join('\n'), context);
  return {
    elements, calls, toasts,
    run: code => vm.runInContext(code, context),
    setNavo(info) { context.nextInfo = info; vm.runInContext('applicationUpdate = nextInfo; renderApplicationUpdate();', context); },
    setCodex(info) { context.nextInfo = info; vm.runInContext('codexDesktopUpdate = nextInfo; renderCodexDesktopUpdate();', context); },
    emit: (channel, info) => listeners.get(channel)?.(info),
  };
}

test('opening application settings reads cached updater states without network checks', async () => {
  const h = harness();
  await h.run('openApplicationSettings()');
  await tick();
  assert.deepEqual(h.calls.map(call => call.name).sort(), ['getCodexState', 'getState']);
  assert.match(h.elements.codexCurrentVersion.textContent, /26\.1\.0\.0/);
  assert.match(h.elements.navoCurrentVersion.textContent, /1\.2\.146/);
});

test('explicit Codex checks render checking immediately and re-enable actions after errors', async () => {
  const result = deferred();
  const h = harness({ checkCodex: () => result.promise });
  const work = h.run('refreshCodexUpdateState(true)');
  assert.equal(h.elements.codexUpdateAction.disabled, true);
  assert.match(h.elements.codexUpdateCopy.textContent, /正在检查/);
  assert.deepEqual(h.calls.map(call => call.name), ['checkCodex']);
  result.reject(new Error('Mock service unavailable'));
  await work;
  assert.match(h.elements.codexUpdateCopy.textContent, /Mock service unavailable/);
  assert.equal(h.elements.codexUpdateAction.disabled, false);
});

test('a late cached Codex read cannot overwrite a newer explicit check', async () => {
  const cache = deferred();
  const h = harness({ getCodexState: () => cache.promise, checkCodex: async () => ({ status: 'current', installed: true, version: '26.2.0.0' }) });
  const oldRead = h.run('refreshCodexUpdateState()');
  await h.run('refreshCodexUpdateState(true)');
  cache.resolve({ status: 'idle', installed: true, version: '26.1.0.0' });
  await oldRead;
  assert.match(h.elements.codexCurrentVersion.textContent, /26\.2\.0\.0/);
  assert.equal(h.run('codexDesktopUpdate.status'), 'current');
});

test('Codex checking, verification and installation do not present an old transfer percent as progress', () => {
  const h = harness();
  for (const status of ['checking', 'closing', 'verifying', 'installing']) {
    h.setCodex({ status, percent: 100, installed: true, version: '26.1.0.0', latestVersion: '26.2.0.0' });
    assert.equal(h.elements.codexUpdateProgress.hidden, false);
    assert.equal(h.elements.codexUpdateProgress.classList.contains('indeterminate'), true, status);
    assert.doesNotMatch(h.elements.codexUpdateProgressLabel.textContent, /100%/, status);
    assert.equal(h.elements.codexUpdateAction.disabled, true, status);
  }
});

test('Codex cancellation failures are shown in the UI instead of escaping the action handler', async () => {
  const h = harness({ cancelCodexDownload: async () => { throw new Error('Mock cancellation failure'); } });
  h.setCodex({ status: 'downloading', percent: 40, installed: true, version: '26.1.0.0' });
  await assert.doesNotReject(h.run('installCodexUpdate()'));
  assert.deepEqual(h.toasts, [['Mock cancellation failure', true]]);
  assert.equal(h.run('codexDesktopUpdate.status'), 'downloading', 'A rejected cancellation does not prove the download stopped');
  assert.equal(h.elements.codexUpdateAction.disabled, false);
});

test('Codex installation forwards the chosen application locale and reports failures', async () => {
  const h = harness({ chinese: false, installCodexUpdate: async () => { throw new Error('Mock installation failure'); } });
  h.setCodex({ status: 'available', installed: true, version: '26.1.0.0', latestVersion: '26.2.0.0', updateAvailable: true, packageReady: true });
  await h.run('installCodexUpdate()');
  assert.equal(h.calls[0].name, 'installCodexUpdate');
  assert.equal(h.calls[0].args[0].locale, 'en');
  assert.match(h.elements.codexUpdateCopy.textContent, /Codex update failed: Mock installation failure/);
  assert.equal(h.elements.codexUpdateAction.disabled, false);
});

test('Navo transfer 100%, verifying and downloaded states do not auto-install', () => {
  const h = harness({ chinese: false });
  const base = { currentVersion: '1.2.146', availableVersion: '1.2.147', percent: 100 };
  h.setNavo({ ...base, status: 'downloading', cancellable: true });
  assert.equal(h.elements.updatePrimaryAction.dataset.action, 'cancel');
  assert.doesNotMatch(h.elements.updateDialogCopy.textContent, /installed successfully|up to date/i);
  h.setNavo({ ...base, status: 'verifying' });
  assert.equal(h.elements.updatePrimaryAction.disabled, true);
  assert.equal(h.elements.updateProgress.classList.contains('indeterminate'), true);
  assert.equal(h.elements.updateProgressLabel.textContent, 'Verifying');
  assert.match(h.elements.updateDialogCopy.textContent, /installation has not started/);
  h.setNavo({ ...base, status: 'downloaded' });
  assert.equal(h.elements.updatePrimaryAction.dataset.action, 'install');
  assert.match(h.elements.updateDialogCopy.textContent, /quitting alone does not/);
  assert.equal(h.calls.length, 0);
});

test('Navo cancel actions use cancellation, then offer an explicit retry without installing', async () => {
  const h = harness({ cancelDownload: async () => ({ status: 'cancelled', currentVersion: '1.2.146', availableVersion: '1.2.147' }) });
  h.setNavo({ status: 'downloading', currentVersion: '1.2.146', availableVersion: '1.2.147', cancellable: true, percent: 30 });
  await h.run('performApplicationUpdateAction()');
  assert.deepEqual(h.calls.map(call => call.name), ['cancelDownload']);
  assert.equal(h.elements.updatePrimaryAction.dataset.action, 'download');
  assert.equal(h.elements.navoSettingsUpdateAction.dataset.action, 'download');
  assert.equal(h.elements.updatePrimaryAction.disabled, false);
  assert.match(h.elements.updateDialogCopy.textContent, /没有进行安装/);
});

test('Navo action exceptions become visible errors and restore both action controls', async () => {
  const h = harness({ download: async () => { throw new Error('Mock download failure'); } });
  h.setNavo({ status: 'available', currentVersion: '1.2.146', availableVersion: '1.2.147' });
  await h.run('performApplicationUpdateAction(elements.navoSettingsUpdateAction)');
  assert.match(h.elements.updateDialogCopy.textContent, /Mock download failure/);
  assert.equal(h.elements.updatePrimaryAction.disabled, false);
  assert.equal(h.elements.navoSettingsUpdateAction.disabled, false);
  assert.equal(h.elements.updatePrimaryAction.dataset.action, 'download');
});

test('the English update card localizes empty-version and accessible action labels', () => {
  const h = harness({ chinese: false });
  h.setNavo({ status: 'idle', currentVersion: '' });
  assert.doesNotMatch(h.elements.navoCurrentVersion.textContent, /[\u3400-\u9fff]/);
  assert.doesNotMatch(h.elements.navoSettingsVersion.textContent, /[\u3400-\u9fff]/);
  assert.doesNotMatch(h.elements.updateChip.getAttribute('aria-label'), /[\u3400-\u9fff]/);
});

test('Navo subscribes before the initial cached read and preserves an event arriving during that read', async () => {
  const cached = deferred();
  const h = harness({ getState: () => cached.promise });
  const startup = h.run('initializeApplicationUpdater()');
  h.emit('navo', { status: 'downloading', currentVersion: '1.2.146', availableVersion: '1.2.147', percent: 70, cancellable: true });
  assert.equal(h.run('applicationUpdate.status'), 'downloading');
  cached.resolve({ status: 'idle', currentVersion: '1.2.146' });
  await startup;
  assert.equal(h.run('applicationUpdate.status'), 'downloading');
  assert.equal(h.elements.updateProgressLabel.textContent, '70%');
});

test('late cached-read failures do not hide fresh updater events or surface stale errors', async () => {
  const cached = deferred();
  const h = harness({ getState: () => cached.promise });
  const startup = h.run('initializeApplicationUpdater()');
  h.emit('navo', { status: 'downloaded', currentVersion: '1.2.146', availableVersion: '1.2.147' });
  cached.reject(new Error('stale state read failed'));
  await startup;
  assert.equal(h.run('applicationUpdate.status'), 'downloaded');
  assert.equal(h.elements.updateChip.hidden, false);
  assert.deepEqual(h.toasts, []);
});

test('Codex subscription events supersede pending cached reads', async () => {
  const cached = deferred();
  const h = harness({ getCodexState: () => cached.promise });
  await h.run('initializeApplicationUpdater()');
  const work = h.run('refreshCodexUpdateState()');
  h.emit('codex', { status: 'installing', percent: 100, installed: true, version: '26.1.0.0', latestVersion: '26.2.0.0' });
  cached.resolve({ status: 'current', installed: true, version: '26.1.0.0' });
  await work;
  assert.equal(h.run('codexDesktopUpdate.status'), 'installing');
  assert.equal(h.elements.codexUpdateAction.disabled, true);
  assert.equal(h.elements.codexUpdateProgress.classList.contains('indeterminate'), true);
});

test('Navo action replies cannot roll back a newer final subscription event', async () => {
  const downloaded = deferred();
  const h = harness({ download: () => downloaded.promise });
  await h.run('initializeApplicationUpdater()');
  h.setNavo({ status: 'available', currentVersion: '1.2.146', availableVersion: '1.2.147' });
  const work = h.run('performApplicationUpdateAction()');
  h.emit('navo', { status: 'downloaded', currentVersion: '1.2.146', availableVersion: '1.2.147', percent: 100 });
  downloaded.resolve({ status: 'downloading', currentVersion: '1.2.146', availableVersion: '1.2.147', percent: 25 });
  await work;
  assert.equal(h.run('applicationUpdate.status'), 'downloaded');
  assert.equal(h.elements.updatePrimaryAction.dataset.action, 'install');
});

test('Codex installation replies cannot roll back a newer completion event', async () => {
  const installed = deferred();
  const h = harness({ installCodexUpdate: () => installed.promise });
  await h.run('initializeApplicationUpdater()');
  h.setCodex({ status: 'available', installed: true, version: '26.1.0.0', latestVersion: '26.2.0.0', updateAvailable: true, packageReady: true });
  const work = h.run('installCodexUpdate()');
  h.emit('codex', { status: 'completed', installed: true, version: '26.2.0.0', percent: 100 });
  installed.resolve({ status: 'installing', installed: true, version: '26.1.0.0', percent: 100 });
  await work;
  assert.equal(h.run('codexDesktopUpdate.status'), 'completed');
  assert.match(h.elements.codexCurrentVersion.textContent, /26\.2\.0\.0/);
  assert.equal(h.elements.codexUpdateProgress.hidden, true);
});

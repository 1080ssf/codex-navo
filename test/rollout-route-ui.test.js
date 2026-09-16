const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute actual route/UI code with memory-only dependencies. This file does
// not import the running server, read user sessions, or restore any real file.
const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const routeStart = serverSource.indexOf("    if (request.method === 'GET' && url.pathname === '/api/codex-rollout-backups') {");
const routeEnd = serverSource.indexOf("    if (request.method === 'GET' && url.pathname === '/api/codex-launch-progress') {", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart);

function routeHarness(overrides = {}) {
  const calls = [];
  const context = vm.createContext({
    ROLLOUT_BACKUP_ROOT: 'memory-backups', SHARED_CODEX_HOME: 'memory-home',
    findRunningCodexDesktopPid: () => 0,
    listRolloutBackups: root => { calls.push(['list', root]); return []; },
    rolloutBackupStorage: root => { calls.push(['storage', root]); return {}; },
    readBody: async () => { calls.push(['body']); return { id: 'fixture.bak' }; },
    restoreRolloutBackup: async (...args) => { calls.push(['restore', ...args]); return {}; },
    audit: (...args) => calls.push(['audit', ...args]),
    sendJson: (_response, status, body) => ({ status, body }),
    sendError: (_response, status, message) => ({ status, message }),
    ...overrides,
  });
  vm.runInContext(`async function route(request, url) { const response = {}; ${serverSource.slice(routeStart, routeEnd)} }`, context);
  return { calls, context, run: (pathname, method = 'GET') => context.route({ method }, { pathname }) };
}

test('backup list and storage routes preserve checksum, duration, capacity and unknown-space metadata', async () => {
  const item = { id: 'fixture.bak', checksumAvailable: false, durationMs: 0, backupBytes: 2048, requiredFreeBytes: 4096, freeBytesBefore: null };
  const storage = { backupRootBytes: 8192, backupCount: 3, freeBytes: null };
  const h = routeHarness({ listRolloutBackups: () => [item], rolloutBackupStorage: () => storage });
  const listed = await h.run('/api/codex-rollout-backups');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data[0], item);
  const measured = await h.run('/api/codex-rollout-backups/storage');
  assert.equal(measured.status, 200);
  assert.equal(measured.body.data, storage);
  assert.deepEqual(h.calls, [], 'read routes must not restore files or write audit events');
});

test('restore route rejects an already running Codex before reading the request or touching backup data', async () => {
  const h = routeHarness({ findRunningCodexDesktopPid: () => 1234 });
  const result = await h.run('/api/codex-rollout-backups/restore', 'POST');
  assert.equal(result.status, 409);
  assert.match(result.message, /退出 Codex/);
  assert.deepEqual(h.calls, []);
});

test('restore route supplies a live process guard instead of freezing the initial idle result', async () => {
  let pid = 0;
  const h = routeHarness({
    findRunningCodexDesktopPid: () => pid,
    restoreRolloutBackup: async (home, backupRoot, id, options) => {
      assert.equal(home, 'memory-home');
      assert.equal(backupRoot, 'memory-backups');
      assert.equal(id, 'fixture.bak');
      assert.equal(options.isFileActive(), false);
      pid = 2345;
      assert.equal(options.isFileActive(), true);
      throw Object.assign(new Error('会话仍在运行，已停止处理；请先退出 Codex'), { code: 'ROLLOUT_BUSY' });
    },
  });
  const result = await h.run('/api/codex-rollout-backups/restore', 'POST');
  assert.equal(result.status, 400);
  assert.match(result.message, /会话仍在运行/);
  assert.equal(h.calls.some(([kind]) => kind === 'audit'), false);
});

test('successful restore preserves all result metadata and records success only after completion', async () => {
  const restored = { bytes: 3072, safetyBackup: 'memory-only.bak', backupBytes: 3072, backupRootBytes: 8192, backupCount: 2, freeBytes: null, requiredFreeBytes: 10240, freeBytesBefore: null, durationMs: 321, timingsMs: { verify: 100 }, checksumAvailable: true };
  const h = routeHarness({ restoreRolloutBackup: async () => restored });
  const result = await h.run('/api/codex-rollout-backups/restore', 'POST');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.data, restored);
  assert.equal(h.calls[1][0], 'audit');
  assert.equal(h.calls[1][1], 'codex.rollout.restored');
  assert.equal(h.calls[1][2].result, 'fixture.bak:3072');
});

test('restore validation, changed-file and low-space failures remain failures with their actual explanation', async () => {
  for (const message of ['Rollout backup checksum mismatch', '会话文件在处理期间发生变化', '磁盘可用空间不足，未改写会话']) {
    const h = routeHarness({ restoreRolloutBackup: async () => { throw new Error(message); } });
    const result = await h.run('/api/codex-rollout-backups/restore', 'POST');
    assert.equal(result.status, 400);
    assert.equal(result.message, message);
    assert.equal(h.calls.some(([kind]) => kind === 'audit'), false);
  }
});

function element() {
  const handlers = new Map();
  return { innerHTML: '', textContent: '', hidden: false, disabled: false,
    addEventListener: (type, callback) => handlers.set(type, callback),
    emit: (type, event = {}) => handlers.get(type)?.(event) };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function uiHarness(options = {}) {
  const calls = [], toasts = [], controls = new Map();
  for (const key of ['all', 'selected', 'collapse-all', 'progress', 'backup-panel', 'backup-list', 'backup-storage', 'backups', 'close', 'cancel']) controls.set(key, element());
  controls.get('backup-panel').hidden = true;
  const form = { ...element(), querySelector: selector => controls.get(selector.slice('[data-launch-'.length, -1)), querySelectorAll: () => [] };
  const dialog = { ...element(), isConnected: false, open: false, appendChild() {},
    showModal() { this.open = true; }, close() { this.open = false; }, remove() { this.isConnected = false; } };
  const context = vm.createContext({
    document: { createElement: tag => tag === 'dialog' ? dialog : form, body: { appendChild: () => { dialog.isConnected = true; } } },
    state: { appLocale: options.english ? 'en' : 'zh-CN' },
    escapeHtml, tr: (zh, en) => options.english ? en : zh, navoUsesChinese: () => !options.english, confirm: () => options.confirm !== false,
    syncModalScrollLock() {}, showToast: (...args) => toasts.push(args),
    api: async (url, request) => {
      calls.push({ url, method: request?.method || 'GET', body: request?.body ? JSON.parse(request.body) : null });
      if (url === '/api/codex-launch-options') return { languages: [{ id: 'zh-CN', label: '简体中文' }, { id: 'en', label: 'English' }], defaultLanguage: 'zh-CN', projects: [], threadCount: 0, oversizedThreadCount: 0 };
      if (options.api) return options.api(url, request);
      if (url.endsWith('/storage')) return options.storage || { backupRootBytes: 1048576, backupCount: 1, freeBytes: null };
      if (url.endsWith('/restore')) return { durationMs: 250, safetyBackup: 'memory-only.bak' };
      return options.backups || [];
    },
  });
  const start = appSource.indexOf('function formatLaunchSize(');
  const end = appSource.indexOf('function parseModelList(', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(appSource.slice(start, end), context);
  const finished = context.openCodexLaunchDialog();
  await flush();
  return { calls, toasts, controls, dialog, finished,
    toggle: () => controls.get('backups').emit('click'),
    close: () => controls.get('close').emit('click'),
    restore: (button = { dataset: { restoreRollout: 'fixture.bak' }, disabled: false }) => ({ button, work: controls.get('backup-list').emit('click', { target: { closest: () => button } }) }),
  };
}

test('backup panel loads only when opened and renders measured capacity without changing unknown space to zero', async () => {
  const h = await uiHarness();
  assert.equal(h.calls.length, 1);
  await h.toggle();
  assert.equal(h.controls.get('backup-panel').hidden, false);
  assert.equal(h.controls.get('backup-storage').textContent, '备份占用: 1.0 MB · 备份数量: 1 · 磁盘可用: —');
  await h.toggle();
  assert.equal(h.calls.length, 3, 'closing the panel does not refetch');
  h.close();
  assert.equal(await h.finished, null);
});

test('backup entries distinguish recorded checksums from legacy data in Chinese and English', async () => {
  const base = { conversationFile: 'conversation-<example>.jsonl', createdAt: '2026-09-16T01:00:00Z', beforeBytes: 2097152, afterBytes: 1048576, backupBytes: 2097152, durationMs: 1200 };
  for (const english of [false, true]) {
    const h = await uiHarness({ english, backups: [{ ...base, id: 'fixture.bak', checksumAvailable: true }, { ...base, id: 'older.bak', kind: 'pre-restore', checksumAvailable: false }] });
    await h.toggle();
    const markup = h.controls.get('backup-list').innerHTML;
    assert.match(markup, /conversation-&lt;example&gt;\.jsonl/);
    assert.match(markup, /1\.2 s/);
    assert.match(markup, english ? /Checksum recorded/ : /含校验记录/);
    assert.match(markup, english ? /Legacy backup without checksum/ : /旧备份无校验记录/);
    assert.match(markup, english ? /Pre-restore backup/ : /恢复前备份/);
    assert.doesNotMatch(markup, /Checksum verified|校验已通过/);
    h.close();
    await h.finished;
  }
});

test('restore UI posts the selected backup ID and reloads metadata after successful completion', async () => {
  const pending = deferred();
  const h = await uiHarness({ api: url => url.endsWith('/restore') ? pending.promise : url.endsWith('/storage') ? { backupRootBytes: 2048, backupCount: 2, freeBytes: 4096 } : [] });
  const restore = h.restore();
  assert.equal(restore.button.disabled, true);
  assert.deepEqual(h.calls[1], { url: '/api/codex-rollout-backups/restore', method: 'POST', body: { id: 'fixture.bak' } });
  assert.equal(h.toasts.length, 0, 'no premature success notice');
  pending.resolve({ durationMs: 400, safetyBackup: 'memory-only.bak' });
  await restore.work;
  assert.match(h.toasts[0][0], /会话备份已恢复.*0\.4 s.*已保留恢复前备份/);
  assert.match(h.controls.get('backup-storage').textContent, /备份数量: 2/);
  assert.equal(h.calls.length, 4);
  h.close();
  await h.finished;
});

test('restore rejection reenables its button and cancelled confirmation sends no request', async () => {
  const h = await uiHarness({ api: async () => { throw new Error('磁盘可用空间不足'); } });
  const restore = h.restore();
  await restore.work;
  assert.equal(restore.button.disabled, false);
  assert.deepEqual(h.toasts, [['磁盘可用空间不足', true]]);
  h.close();
  await h.finished;
  const cancelled = await uiHarness({ confirm: false });
  await cancelled.restore().work;
  assert.equal(cancelled.calls.length, 1);
  cancelled.close();
  await cancelled.finished;
});

test('late backup reads do not repaint a dialog after it has closed', async () => {
  const pending = deferred();
  const h = await uiHarness({ api: () => pending.promise });
  const work = h.toggle();
  h.close();
  pending.resolve([]);
  await work;
  assert.equal(h.controls.get('backup-storage').textContent, '');
  assert.equal(h.controls.get('backup-list').innerHTML, '');
  assert.equal(await h.finished, null);
});

test('backup list or storage failures remain visible in the panel with bilingual prefixes and escaped upstream text', async () => {
  const message = 'Fixture <upstream> & 未知 503';
  for (const english of [false, true]) {
    for (const failedEndpoint of ['/api/codex-rollout-backups', '/api/codex-rollout-backups/storage']) {
      const h = await uiHarness({ english, api: async url => {
        if (url === failedEndpoint) throw new Error(message);
        return url.endsWith('/storage') ? { backupCount: 0 } : [];
      } });
      await h.toggle();
      const markup = h.controls.get('backup-list').innerHTML;
      assert.equal(h.controls.get('backup-panel').hidden, false);
      assert.equal(markup, `<p class="launch-empty" role="alert">${english ? 'Unable to read backups: ' : '无法读取备份：'}Fixture &lt;upstream&gt; &amp; 未知 503</p>`);
      assert.doesNotMatch(markup, /暂无可恢复备份|No backups/);
      assert.equal(h.controls.get('backup-storage').textContent, '');
      assert.deepEqual(h.toasts, [[message, true]]);
      assert.ok(h.calls.every(call => call.method === 'GET'));
      h.close();
      await h.finished;
    }
  }
});

test('closing and reopening a failed backup panel retries reads and replaces the error with fresh results', async () => {
  let failed = true;
  const h = await uiHarness({ english: true, api: async url => {
    if (failed) throw new Error('Fixture failure');
    return url.endsWith('/storage')
      ? { backupRootBytes: 2048, backupCount: 1, freeBytes: 4096 }
      : [{ id: 'fixture.bak', conversationFile: 'recovered-list.jsonl', createdAt: '2026-09-16T01:00:00Z', beforeBytes: 2048, backupBytes: 2048 }];
  } });
  await h.toggle();
  assert.match(h.controls.get('backup-list').innerHTML, /Unable to read backups:/);
  await h.toggle();
  assert.equal(h.controls.get('backup-panel').hidden, true);
  assert.equal(h.calls.length, 3, 'Hiding the failed panel does not issue requests');
  failed = false;
  await h.toggle();
  assert.equal(h.controls.get('backup-panel').hidden, false);
  assert.match(h.controls.get('backup-list').innerHTML, /recovered-list\.jsonl/);
  assert.doesNotMatch(h.controls.get('backup-list').innerHTML, /role="alert"|Fixture failure/);
  assert.match(h.controls.get('backup-storage').textContent, /Backup count: 1/);
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every(call => call.method === 'GET'));
  h.close();
  await h.finished;
});

test('late failed backup reads do not repaint or announce errors after the dialog has closed', async () => {
  const pending = deferred();
  const h = await uiHarness({ api: async () => { await pending.promise; throw new Error('Fixture late failure'); } });
  const work = h.toggle();
  h.close();
  pending.resolve();
  await work;
  assert.equal(h.controls.get('backup-list').innerHTML, '');
  assert.equal(h.controls.get('backup-storage').textContent, '');
  assert.deepEqual(h.toasts, []);
  assert.equal(await h.finished, null);
});

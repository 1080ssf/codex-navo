const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

test('hidden main windows pause list polling, keep notifications and sync immediately on reveal', () => {
  const timers = new Map(), events = new Map(), calls = [];
  let editing = false;
  const document = { hidden: true, addEventListener: (name, fn) => events.set(name, fn) };
  const context = vm.createContext({ state: {}, document, window: { addEventListener() {} },
    setInterval: (fn, ms) => { timers.set(ms, fn); return ms; },
    editingSurfaceActive: () => editing,
    refresh: () => calls.push('accounts'), refreshSessions: () => calls.push('sessions'),
    pollNotificationEvents: () => calls.push('notifications'), pollCodexLaunchProgress: () => calls.push('launch'),
  });
  vm.runInContext(source.slice(source.indexOf('state.timer = setInterval(')), context);
  for (const fn of timers.values()) fn();
  assert.deepEqual(calls, ['notifications', 'launch']);
  calls.length = 0;
  document.hidden = false;
  events.get('visibilitychange')();
  assert.deepEqual(calls, ['accounts', 'sessions', 'launch']);
  calls.length = 0;
  editing = true;
  timers.get(5000)();
  assert.deepEqual(calls, []);
});

test('an in-flight background response stores data without rendering a now-hidden window', async () => {
  let resolve;
  const response = new Promise(done => { resolve = done; });
  let renders = 0;
  const context = vm.createContext({
    document: { hidden: false }, state: { accounts: [], usageRange: 'today' },
    elements: { navoCurrentVersion: null }, applicationUpdate: {},
    api: () => response, editingSurfaceActive: () => false, render: () => { renders++; },
    showProtocolDialogConnectionError: () => false, showToast() {},
  });
  const start = source.indexOf('async function refresh(options = {})');
  vm.runInContext(source.slice(start, source.indexOf('\nelements.accounts.addEventListener', start)), context);
  const pending = context.refresh({ background: true });
  context.document.hidden = true;
  resolve({ accounts: [{ id: 'fixture', codexInitialized: true }] });
  await pending;
  assert.equal(context.state.accounts[0].id, 'fixture');
  assert.equal(renders, 0);
});

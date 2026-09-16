const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FLOATING_MAX_HEIGHT, fittedFloatingBounds } = require('../lib/floating-window-size');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'desktop-src/main.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'public/floating.js'), 'utf8');
function sourceFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `${name} is a production function`);
  return source.slice(start, end + 2);
}
const area = { x: 0, y: 0, width: 1920, height: 1040 };
const normal = { x: 1500, y: 200, width: 400, height: 458 };

test('measured content replaces old fixed heights without changing width or horizontal position', () => {
  assert.deepEqual(fittedFloatingBounds(normal, area, 493), { ...normal, height: 493 });
  assert.deepEqual(fittedFloatingBounds(normal, area, 643.4), { ...normal, height: 644 });
  assert.deepEqual(fittedFloatingBounds({ ...normal, height: 643 }, area, 470), { ...normal, height: 470 });
});

test('native height and vertical position are bounded to the current work area, including secondary monitors', () => {
  assert.deepEqual(fittedFloatingBounds({ ...normal, y: 900 }, area, 650), { ...normal, y: 390, height: 650 });
  const secondary = { x: -1920, y: -100, width: 1920, height: 600 };
  assert.deepEqual(fittedFloatingBounds({ x: -420, y: -200, width: 400, height: 458 }, secondary, 900), { x: -420, y: -100, width: 400, height: 600 });
  assert.equal(fittedFloatingBounds(normal, { ...area, height: 2000 }, 999999).height, FLOATING_MAX_HEIGHT);
  assert.equal(fittedFloatingBounds(normal, area, 1).height, 240);
  assert.equal(fittedFloatingBounds(normal, { ...area, height: 200 }, 493).height, 200);
});

test('invalid renderer sizes are rejected rather than coerced into window dimensions', () => {
  for (const height of [undefined, null, false, '493', {}, [], NaN, Infinity, -1, 0]) assert.equal(fittedFloatingBounds(normal, area, height), null);
});

function nativeHarness(initial = normal, workArea = area) {
  let bounds = { ...initial };
  const changes = [];
  const sender = {};
  const context = vm.createContext({
    fittedFloatingBounds,
    floatingWindow: { isDestroyed: () => false, webContents: sender, getBounds: () => ({ ...bounds }),
      setBounds(value, animated) { bounds = { ...value }; changes.push({ bounds, animated }); } },
    screen: { getDisplayMatching: () => ({ workArea }) },
  });
  vm.runInContext(sourceFunction(mainSource, 'resizeFloatingWindow'), context);
  const handlers = new Map();
  context.ipcMain = { handle: (name, callback) => handlers.set(name, callback) };
  const start = mainSource.indexOf("  ipcMain.handle('floating:set-expanded'");
  const end = mainSource.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(mainSource.slice(start, end), context);
  return { context, changes, sender, handlers, get bounds() { return bounds; } };
}

test('native resize deduplicates identical bounds and never calls pin, opacity, focus or settings operations', () => {
  const h = nativeHarness();
  h.context.resizeFloatingWindow(493);
  h.context.resizeFloatingWindow(493);
  h.context.resizeFloatingWindow(492.8);
  assert.equal(h.changes.length, 1);
  assert.deepEqual(h.changes[0], { bounds: { ...normal, height: 493 }, animated: false });
  h.context.resizeFloatingWindow(620);
  assert.equal(h.changes.length, 2);
  assert.equal(h.bounds.width, 400);
  h.context.floatingWindow = null;
  assert.equal(h.context.resizeFloatingWindow(493), false);
});

test('new height bridge is bound to the floating renderer while legacy boolean expansion still works', () => {
  const h = nativeHarness();
  const resize = h.handlers.get('floating:resize');
  assert.equal(resize({ sender: {} }, 493), false);
  assert.equal(resize({ sender: h.sender }, { height: 493 }), false);
  assert.equal(resize({ sender: h.sender }, 493).height, 493);
  assert.equal(h.handlers.get('floating:set-expanded')({}, true), true);
  assert.equal(h.bounds.height, 598);
  h.handlers.get('floating:set-expanded')({}, false);
  assert.equal(h.bounds.height, 458);
});

function clientHarness(options = {}) {
  const calls = [], frames = [], listeners = new Map(), observed = [];
  let measuredHeight = options.height || 493;
  let notify, disconnected = false;
  const settings = {}, account = {}, footer = {};
  const shell = { style: {}, children: [account, settings, footer], get scrollHeight() { return measuredHeight - 2; },
    getBoundingClientRect: () => ({ height: Math.min(measuredHeight, options.viewport || 458) }) };
  const bridge = options.noBridge ? {} : { resize: height => { calls.push(height); return Promise.resolve({ height: Math.min(height, options.viewport || 458) }); } };
  const context = vm.createContext({
    document: { querySelector: selector => selector === '.widget-shell' ? shell : null },
    window: { codexFloating: bridge, innerHeight: options.viewport || 458,
      getComputedStyle: () => ({ borderTopWidth: '1px', borderBottomWidth: '1px' }),
      requestAnimationFrame: callback => frames.push(callback), addEventListener: (name, callback) => listeners.set(name, callback) },
    ResizeObserver: class { constructor(callback) { notify = callback; } observe(target) { observed.push(target); } disconnect() { disconnected = true; } },
  });
  vm.runInContext(sourceFunction(clientSource, 'initializeFloatingAutoSize'), context);
  context.initializeFloatingAutoSize();
  return { calls, frames, shell, settings, observed, context, listeners, get disconnected() { return disconnected; },
    flush: () => { const frame = frames.shift(); if (frame) frame(); },
    observe: () => notify?.(), height: value => { measuredHeight = value; notify?.(); } };
}

test('renderer measures content beyond the old viewport, accounts for borders and coalesces observer notifications', () => {
  const h = clientHarness();
  h.observe(); h.observe();
  assert.equal(h.frames.length, 1);
  h.flush();
  assert.deepEqual(h.calls, [493]);
  assert.equal(h.shell.style.maxHeight, '458px');
  assert.equal(h.shell.style.overflowY, 'auto');
  h.observe(); h.flush();
  assert.deepEqual(h.calls, [493], 'same content must not create an IPC resize loop');
  h.height(643); h.flush();
  h.height(493); h.flush();
  assert.deepEqual(h.calls, [493, 643, 493]);
});

test('expanding and collapsing a child panel triggers measurement even while the shell box stays capped', () => {
  const h = clientHarness({ height: 493, viewport: 458 });
  assert.deepEqual(h.observed, [h.shell, ...h.shell.children]);
  h.flush();
  const cappedHeight = h.shell.getBoundingClientRect().height;
  assert.equal(cappedHeight, 458);
  assert.ok(h.observed.includes(h.settings), 'settings changes must be observed independently of its capped parent');
  h.height(643); h.flush();
  assert.equal(h.shell.getBoundingClientRect().height, cappedHeight);
  h.height(493); h.flush();
  assert.equal(h.shell.getBoundingClientRect().height, cappedHeight);
  assert.deepEqual(h.calls, [493, 643, 493]);
});

test('display-capped content stays measurable and scrollable without repeated resizing', () => {
  const h = clientHarness({ height: 900, viewport: 600 });
  h.flush();
  h.observe(); h.flush();
  h.listeners.get('resize')(); h.flush();
  assert.deepEqual(h.calls, [900]);
  assert.equal(h.shell.style.maxHeight, '600px');
  assert.equal(h.shell.style.overflowY, 'auto');
  h.height(500); h.flush();
  assert.deepEqual(h.calls, [900, 500]);
});

test('renderer stops queued resizing after unload and leaves older bridges untouched', () => {
  const h = clientHarness();
  h.listeners.get('beforeunload')();
  h.flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.disconnected, true);
  const older = clientHarness({ noBridge: true });
  assert.equal(older.frames.length, 0);
  assert.deepEqual(older.shell.style, {});
});

test('packaged preload exposes the new height channel and preserves the old expanded contract', () => {
  const exposed = new Map(), calls = [];
  const context = vm.createContext({ require: () => ({ contextBridge: { exposeInMainWorld: (name, bridge) => exposed.set(name, bridge) },
    ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(true); } } }) });
  vm.runInContext(fs.readFileSync(path.join(root, 'desktop-src/preload.js'), 'utf8'), context);
  exposed.get('codexFloating').resize(493);
  exposed.get('codexFloating').setExpanded(true);
  assert.deepEqual(calls, [['floating:resize', 493], ['floating:set-expanded', true]]);
  assert.match(mainSource, /maxHeight: FLOATING_MAX_HEIGHT/);
  assert.match(mainSource, /require\('\.\.\/lib\/floating-window-size'\)/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.files.includes('lib/**/*'));
});

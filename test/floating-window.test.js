'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('desktop creates a persisted transparent always-on-top floating window', () => {
  const main = fs.readFileSync(path.join(root, 'desktop-src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'desktop-src', 'preload.js'), 'utf8');
  assert.match(main, /FLOATING_SETTINGS_FILE/);
  assert.match(main, /theme: 'glass'/);
  assert.match(main, /pinned: true/);
  assert.match(main, /\['glass', 'midnight', 'paper'\]/);
  assert.match(main, /frame: false/);
  assert.match(main, /transparent: true/);
  assert.match(main, /alwaysOnTop: floatingSettings\.pinned/);
  assert.match(main, /skipTaskbar: true/);
  assert.match(main, /setAlwaysOnTop\(floatingSettings\.pinned, 'floating'\)/);
  assert.match(main, /setOpacity\(floatingSettings\.opacity \/ 100\)/);
  assert.match(main, /floatingWindow\.getPosition\(\)/);
  assert.match(main, /width: 400, height: 426/);
  assert.match(main, /expanded \? 566 : 426/);
  assert.match(main, /floatingSettings\.enabled \? '\u9690\u85cf\u60ac\u6d6e\u7a97' : '\u663e\u793a\u60ac\u6d6e\u7a97'/);
  assert.match(main, /function toggleFloatingWindow\(\)/);
  assert.match(main, /globalShortcut\.register\('CommandOrControl\+Alt\+N'/);
  assert.match(main, /floatingWindow\.moveTop\(\)/);
  assert.match(main, /globalShortcut\.unregisterAll\(\)/);
  assert.match(main, /updateTrayMenu\(\)/);
  assert.match(preload, /exposeInMainWorld\('codexFloating'/);
  for (const channel of ['floating:get-settings', 'floating:show', 'floating:hide', 'floating:update-settings', 'floating:set-expanded']) {
    assert.match(main, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(preload, new RegExp(channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(main, /ipcMain\.handle\('floating:update-locale'/);
  assert.match(main, /webContents\.send\('floating:locale', locale\)/);
  assert.match(preload, /updateLocale: \(locale\) => ipcRenderer\.invoke\('floating:update-locale', locale\)/);
  assert.match(preload, /ipcRenderer\.on\('floating:locale', listener\)/);
});

test('floating window renders account, quota, usage, task progress, and task usage', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'floating.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'public', 'floating.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'public', 'floating.css'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  for (const id of ['account-name', 'quota-bar', 'quota-refresh', 'usage-input', 'usage-cache', 'usage-cache-rate', 'usage-output', 'task-title', 'task-activity', 'task-progress', 'task-input', 'task-cache', 'task-output', 'opacity-input', 'pin-toggle']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(client, /fetch\('\/api\/floating-status'/);
  assert.match(client, /setInterval\(refresh, 2000\)/);
  assert.match(client, /codex-navo-app-locale/);
  assert.match(client, /navigator\.languages/);
  assert.match(client, /function applyLocale\(\)/);
  assert.match(client, /let locale = normalizedLocale/);
  assert.match(client, /function updateLocale\(value\)/);
  assert.match(client, /onLocale\?\.\(updateLocale\)/);
  assert.match(client, /event\.key === 'codex-navo-app-locale'/);
  assert.match(client, /\[1_000_000_000, 'B'\]/);
  assert.match(client, /\[1_000_000, 'M'\]/);
  assert.match(client, /\[1_000, 'K'\]/);
  assert.match(client, /updateSettings\(\{ pinned:/);
  assert.match(client, /updateSettings\(\{ opacity:/);
  assert.match(client, /Number\(usage\.cachedInput\) \/ Number\(usage\.input\) \* 100/);
  assert.match(client, /fetch\('\/api\/floating-status\/refresh'/);
  assert.match(styles, /body\[data-theme="midnight"\]/);
  assert.match(styles, /body\[data-theme="paper"\]/);
  assert.match(styles, /-webkit-app-region: drag/);
  assert.match(styles, /animation: task-running/);
  assert.match(server, /function floatingWindowState\(\)/);
  assert.match(server, /url\.pathname === '\/api\/floating-status'/);
  assert.match(server, /url\.pathname === '\/api\/floating-status\/refresh'/);
  assert.match(server, /activeStatuses = new Set\(\['running', 'waiting_input', 'waiting_approval'\]\)/);
  assert.match(server, /\['\/', '\/floating\.html'\]\.includes\(url\.pathname\)/);
  assert.match(server, /Location: url\.pathname/);
});

test('main application exposes a floating-window entry', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  assert.match(html, /id="floating-window-button"/);
  assert.match(client, /initializeFloatingWindow/);
  assert.match(client, /window\.codexFloating\?\.show\(\)/);
  assert.match(client, /window\.codexFloating\?\.hide\(\)/);
  assert.match(client, /navoUsesChinese\(\) \? '隐藏悬浮窗' : 'Hide floating window'/);
  assert.match(client, /navoUsesChinese\(\) \? '显示悬浮窗' : 'Show floating window'/);
});

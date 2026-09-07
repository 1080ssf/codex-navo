const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('installed-package query errors publish a recoverable error instead of rejecting IPC', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../desktop-src/main.js'), 'utf8');
  const start = source.indexOf('async function installCodexWindowsUpdate(');
  const end = source.indexOf('\nconst installCodexWindowsUpdateOnce', start);
  const context = {
    codexUpdateState: { status: 'available', latestVersion: '1.2.3' },
    reusableUpdateCheck: () => true,
    readInstalledCodexPackageState: async () => { throw new Error('Windows package query timed out'); },
    codexDownloadController: null,
    publishCodexUpdateState: (state) => state,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const result = await context.installCodexWindowsUpdate();
  assert.equal(result.status, 'error');
  assert.match(result.error, /query timed out/);
  assert.equal(context.codexDownloadController, null);
});

test('install entry does not consume stale update flags while a check is pending', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../desktop-src/main.js'), 'utf8');
  const start = source.indexOf('async function installCodexWindowsUpdate(');
  const end = source.indexOf('\nconst installCodexWindowsUpdateOnce', start);
  assert.ok(start >= 0 && end > start);
  const pending = { status: 'checking', updateAvailable: true, packageReady: true, latestVersion: '1.2.3' };
  const forbidden = () => { throw new Error('Side effect must not run while checking'); };
  const context = { codexUpdateState: pending, reusableUpdateCheck: () => false,
    fetchOfficialCodexUpdateState: async () => pending,
    codexDesktopIsRunning: forbidden, closeCodexDesktop: forbidden,
    downloadCodexPackage: forbidden, installCodexPackage: forbidden, publishCodexUpdateState: forbidden };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  assert.equal(await context.installCodexWindowsUpdate(), pending);
});

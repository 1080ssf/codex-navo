const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

test('export includes chunked web cookies without accessing real accounts', async () => {
  const start = source.indexOf('async function exportAccountWebSession(');
  const end = source.indexOf('\nasync function importAccountWebSession', start);
  for (const names of [['__Secure-next-auth.session-token.0', '__Secure-next-auth.session-token.1'], ['__Secure-next-auth.session-token'], ['irrelevant']]) {
    const cookies = names.map(name => ({ name, value: 'fixture', domain: '.chatgpt.com' }));
    const context = { path, accountPaths: () => ({ browserDir: 'fixture' }), readLiveChromeDebugPort: async () => 1234,
      transferableWebCookies: x => x, readProtocolCookies: async () => cookies };
    const fn = vm.runInNewContext(`(${source.slice(start, end)})`, context);
    const result = await fn({});
    assert.equal(Boolean(result), names[0] !== 'irrelevant');
    if (result) assert.deepEqual(result.cookies, cookies);
  }
});

test('optional name synchronization failure does not abort startup repairs', () => {
  const start = source.indexOf('function repairSharedCodexPreferences(');
  const end = source.indexOf('\nfunction restoreStoppedLaunchStateBeforeCatalog', start);
  const events = [];
  const fn = vm.runInNewContext(`(${source.slice(start, end)})`, {
    SHARED_CODEX_HOME: 'fixture', pruneMissingLocalProjects: () => ({ changed: false }),
    repairSharedCodexConfig: () => ({ changed: false }), repairSharedCodexThreadCatalog: () => ({ changed: false }),
    syncSessionIndexNames: () => { throw new Error('ETIMEDOUT'); }, audit: (...args) => events.push(args),
  });
  assert.equal(fn().changed, false);
  assert.equal(events[0][0], 'codex.thread-names.sync-deferred');
});

test('web verification failure retains imported profile and does not claim a verified login', async () => {
  const start = source.indexOf('async function importAuthorizationPackage(');
  const end = source.indexOf('\nconst MANAGED_CODEX_EXIT_GRACE_MS', start);
  const deleted = [], saved = [];
  const fn = vm.runInNewContext(`(${source.slice(start, end)})`, {
    path, crypto: { randomBytes: () => Buffer.from('fixture') }, accounts: [], settings: { mockLaunch: true },
    readAuthPackage: () => ({ files: { 'auth.json': {}, 'web-session.json': { cookies: [] } } }),
    authIdentity: () => 'fixture', existingAuthIdentity: () => null, uniqueImportedLabel: () => 'fixture',
    accountPaths: () => ({ browserDir: 'browser', codexDir: 'codex', codexHomeDir: 'codex' }),
    ensureCodexProfileConfig: () => {}, writeJsonAtomic: () => {},
    importAccountWebSession: async () => { throw new Error('HTTP 403'); },
    saveAccounts: value => saved.push(value), audit: () => {}, isWithin: () => true,
    BROWSER_PROFILES_DIR: 'profiles', CODEX_PROFILES_DIR: 'profiles', fs: { rmSync: value => deleted.push(value) },
  });
  const result = await fn({}, 'fixture');
  assert.equal(result.importStatus.web, 'failed');
  assert.equal(result.account.webLoginComplete, false);
  assert.equal(saved.length, 1);
  assert.deepEqual(deleted, []);
});

test('authorization package import applies the selected network route', async () => {
  const start = source.indexOf('async function importAuthorizationPackage(');
  const end = source.indexOf('\nconst MANAGED_CODEX_EXIT_GRACE_MS', start);
  const assigned = [];
  const saved = [];
  const fn = vm.runInNewContext(`(${source.slice(start, end)})`, {
    path, crypto: { randomBytes: () => Buffer.from('route') }, accounts: [], settings: { mockLaunch: true },
    readAuthPackage: () => ({ files: { 'auth.json': {} }, account: { label: '带线路账号' } }),
    authIdentity: () => 'route-fixture', existingAuthIdentity: () => null, uniqueImportedLabel: label => label,
    accountPaths: () => ({ browserDir: 'browser', codexDir: 'codex', codexHomeDir: 'codex' }),
    ensureCodexProfileConfig: () => {}, writeJsonAtomic: () => {}, saveAccounts: value => saved.push(value),
    networkManager: { assign: (accountId, value) => assigned.push({ accountId, value }) },
    audit: () => {}, isWithin: () => true, BROWSER_PROFILES_DIR: 'profiles', CODEX_PROFILES_DIR: 'profiles',
    fs: { rmSync: () => {} },
  });
  const network = { mode: 'proxy', sourceId: 'source-fixture', nodeName: 'node-fixture' };
  const result = await fn({}, 'fixture', network);
  assert.equal(result.account.label, '带线路账号');
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].accountId, result.account.id);
  assert.deepEqual(assigned[0].value, network);
  assert.equal(saved.length, 1);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  filterGlobalState,
  listCodexLaunchOptions,
  optimizeRolloutFile,
  prepareLaunchView,
  pruneMissingLocalProjects,
  restoreLaunchView,
  withDesktopLocale,
} = require('../lib/codex-launch-view');

function python(script, args) {
  const result = spawnSync('python', ['-c', script, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

test('desktop locale override is stored in the Codex desktop settings section', () => {
  const inserted = withDesktopLocale('model = "gpt"\n\n[desktop]\nappearanceTheme = "system"\nlocaleOverride = "en-US"\n', 'zh-CN');
  assert.match(inserted, /\[desktop\][\s\S]*localeOverride = "zh-CN"/);
  assert.equal((inserted.match(/\[desktop\]/g) || []).length, 1);
  const replaced = withDesktopLocale(inserted, 'en-US');
  assert.match(replaced, /localeOverride = "en-US"/);
  assert.equal((replaced.match(/localeOverride/g) || []).length, 1);
});

test('desktop locale also constrains generated plan and progress text', () => {
  const output = withDesktopLocale('model = "gpt-5.6-sol"\n', 'zh-CN');
  assert.match(output, /^developer_instructions = ".*Simplified Chinese.*"/m);
  assert.match(output, /localeOverride = "zh-CN"/);
});

test('launch view keeps only selected projects and conversations', () => {
  const source = {
    'local-projects': { p1: { rootPaths: ['C:/one'] }, p2: { rootPaths: ['C:/two'] } },
    'project-order': ['p1', 'p2'],
    'pinned-project-ids': ['p2'],
    'projectless-thread-ids': ['t1', 't2'],
    'thread-project-assignments': { t1: { projectId: 'p1' }, t2: { projectId: 'p2' } },
    'sidebar-project-thread-orders': { p1: { threadIds: ['t1'] }, p2: { threadIds: ['t2'] } },
    'selected-project': { projectKind: 'local', projectId: 'p2' },
    'electron-persisted-atom-state': {
      'thread-workspace-state-v1:t1': { project: { projectId: 'p1' } },
      'thread-workspace-state-v1:t2': { project: { projectId: 'p2' } },
      'sidebar-project-expanded-v1-codex:p1': true,
      'sidebar-project-expanded-v1-codex:p2': true,
    },
  };
  const filtered = filterGlobalState(source, { threadIds: ['t1'], projectIds: ['p1'] });
  assert.deepEqual(Object.keys(filtered['local-projects']), ['p1']);
  assert.deepEqual(Object.keys(filtered['thread-project-assignments']), ['t1']);
  assert.deepEqual(filtered['sidebar-project-thread-orders'].p1.threadIds, ['t1']);
  assert.equal(filtered['electron-persisted-atom-state']['thread-workspace-state-v1:t2'], undefined);
  assert.equal(filtered['selected-project'].projectId, 'p1');
});

test('launch options use Codex sidebar project and conversation names', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-titles-'));
  const db = path.join(root, 'state_5.sqlite');
  const rollout = path.join(root, 'session.jsonl');
  fs.writeFileSync(rollout, '');
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model_provider TEXT, name TEXT, title TEXT, first_user_message TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER, updated_at INTEGER, thread_source TEXT, source TEXT, archived INTEGER)')
db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', ('thread-1',sys.argv[2],'C:/workspace','openai',None,'Raw first prompt','Raw first prompt',10,10,10,'cli','cli',0))
db.commit(); db.close()
`, [db, rollout]);
  fs.writeFileSync(path.join(root, '.codex-global-state.json'), JSON.stringify({
    'local-projects': {
      p1: { name: 'Visible project', rootPaths: ['C:/workspace'] },
      removed: { name: 'Removed project', rootPaths: ['C:/removed'] },
    },
    'project-order': ['p1'],
    'thread-project-assignments': { 'thread-1': { projectId: 'p1' } },
  }));
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), `${JSON.stringify({ id: 'thread-1', thread_name: 'Visible conversation' })}\n`);
  const catalog = listCodexLaunchOptions(root);
  assert.equal(catalog.projects[0].label, 'Visible project');
  assert.equal(catalog.projects[0].threads[0].title, 'Visible conversation');
  assert.equal(catalog.projects.some((project) => project.id === 'removed'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('implicit cwd grouping only uses a project primary root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-primary-root-'));
  const db = path.join(root, 'state_5.sqlite');
  const primary = path.join(root, 'primary');
  const historical = path.join(root, 'historical');
  fs.mkdirSync(primary); fs.mkdirSync(historical);
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model_provider TEXT, name TEXT, title TEXT, first_user_message TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER, updated_at INTEGER, thread_source TEXT, source TEXT, archived INTEGER)')
db.executemany('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [
 ('implicit-secondary','',sys.argv[2],'openai',None,'secondary','secondary',10,10,10,'cli','cli',0),
 ('explicit-secondary','',sys.argv[2],'openai',None,'assigned','assigned',20,20,20,'cli','cli',0)])
db.commit(); db.close()
`, [db, historical]);
  fs.writeFileSync(path.join(root, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { p1: { name: 'Primary project', rootPaths: [primary, historical] } },
    'project-order': ['p1'],
    'thread-project-assignments': { 'explicit-secondary': { projectId: 'p1' } },
  }));
  const catalog = listCodexLaunchOptions(root);
  assert.deepEqual(catalog.projects.find((item) => item.id === 'p1').threads.map((item) => item.id), ['explicit-secondary']);
  assert.deepEqual(catalog.projects.find((item) => item.id === '__unassigned__').threads.map((item) => item.id), ['implicit-secondary']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('project removed while Codex is open stays removed after launch state restoration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-project-delete-'));
  const home = path.join(root, 'home');
  const backup = path.join(root, 'backup');
  fs.mkdirSync(home, { recursive: true });
  const stateFile = path.join(home, '.codex-global-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({
    'local-projects': { p1: { rootPaths: ['C:/one'] }, p2: { rootPaths: ['C:/two'] } },
    'project-order': ['p1', 'p2'],
    'pinned-project-ids': ['p1', 'p2'],
  }));
  const record = prepareLaunchView(home, backup, { language: 'zh-CN', projectIds: ['p1'], threadIds: [] });
  const live = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  delete live['local-projects'].p1;
  live['project-order'] = [];
  live['pinned-project-ids'] = [];
  fs.writeFileSync(stateFile, JSON.stringify(live));
  restoreLaunchView(record);
  const restored = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.deepEqual(Object.keys(restored['local-projects']), ['p2']);
  assert.deepEqual(restored['project-order'], ['p2']);
  assert.deepEqual(restored['pinned-project-ids'], ['p2']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing project folders are pruned from Codex sidebar state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-missing-project-'));
  const existing = path.join(root, 'existing');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(root, '.codex-global-state.json'), JSON.stringify({
    'local-projects': {
      keep: { rootPaths: [existing, path.join(root, 'moved-root')] },
      remove: { rootPaths: [path.join(root, 'deleted-root')] },
    },
    'project-order': ['keep', 'remove'],
    'pinned-project-ids': ['remove'],
    'thread-project-assignments': { t1: { projectId: 'remove' } },
    'sidebar-project-thread-orders': { remove: { threadIds: ['t1'] } },
    'selected-project': { projectId: 'remove' },
  }));
  const result = pruneMissingLocalProjects(root);
  const state = JSON.parse(fs.readFileSync(path.join(root, '.codex-global-state.json'), 'utf8'));
  assert.deepEqual(result.removed, ['remove']);
  assert.deepEqual(state['local-projects'].keep.rootPaths, [existing]);
  assert.equal(state['local-projects'].remove, undefined);
  assert.deepEqual(state['project-order'], ['keep']);
  assert.deepEqual(state['thread-project-assignments'], {});
  assert.equal(state['selected-project'], undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('selected conversation deleted while Codex is open is not resurrected', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-thread-delete-'));
  const home = path.join(root, 'home');
  const backup = path.join(root, 'backup');
  fs.mkdirSync(home, { recursive: true });
  const db = path.join(home, 'state_5.sqlite');
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT NOT NULL, archived INTEGER NOT NULL, title TEXT NOT NULL)')
db.executemany('INSERT INTO threads VALUES(?,?,?,?)', [('t1','openai',0,'one'),('t2','openai',0,'two')])
db.commit(); db.close()
`, [db]);
  const record = prepareLaunchView(home, backup, { language: 'zh-CN', projectIds: [], threadIds: ['t1'] });
  python("import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"DELETE FROM threads WHERE id='t1'\"); db.commit(); db.close()", [db]);
  restoreLaunchView(record);
  const ids = JSON.parse(python("import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(json.dumps([r[0] for r in db.execute('SELECT id FROM threads ORDER BY id')])); db.close()", [db]));
  assert.deepEqual(ids, ['t2']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('launch transaction hides unselected recent threads and restores their state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-state-'));
  const home = path.join(root, 'home');
  const backup = path.join(root, 'backup');
  fs.mkdirSync(home, { recursive: true });
  const db = path.join(home, 'state_5.sqlite');
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT NOT NULL, archived INTEGER NOT NULL, title TEXT NOT NULL)')
db.executemany('INSERT INTO threads VALUES(?,?,?,?)', [('t1','openai',0,'one'),('t2','openai',0,'two')])
db.commit(); db.close()
`, [db]);
  fs.writeFileSync(path.join(home, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { p1: { rootPaths: ['C:/one'] }, p2: { rootPaths: ['C:/two'] } },
    'thread-project-assignments': { t1: { projectId: 'p1' }, t2: { projectId: 'p2' } },
  }));
  const record = prepareLaunchView(home, backup, {
    language: 'zh-CN', projectIds: ['p1'], threadIds: ['t1'],
  }, { modelProvider: 'codex_navo' });
  const during = JSON.parse(python(`
import json, sqlite3, sys
db=sqlite3.connect(sys.argv[1])
print(json.dumps(db.execute('SELECT id,model_provider,archived FROM threads ORDER BY id').fetchall()))
db.close()
`, [db]));
  assert.deepEqual(during, [['t1', 'codex_navo', 0]]);
  python("import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"UPDATE threads SET title='changed' WHERE id='t1'\"); db.commit(); db.close()", [db]);
  restoreLaunchView(record);
  const after = JSON.parse(python(`
import json, sqlite3, sys
db=sqlite3.connect(sys.argv[1])
print(json.dumps(db.execute('SELECT id,model_provider,archived,title FROM threads ORDER BY id').fetchall()))
db.close()
`, [db]));
  assert.deepEqual(after, [['t1', 'openai', 0, 'changed'], ['t2', 'openai', 0, 'two']]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('launch catalog preserves selected archive deletion and new tasks during restoration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-catalog-'));
  const home = path.join(root, 'home');
  const backup = path.join(root, 'backup');
  const sqliteDir = path.join(home, 'sqlite');
  fs.mkdirSync(sqliteDir, { recursive: true });
  const catalogDb = path.join(sqliteDir, 'codex-dev.db');
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE local_thread_catalog(host_id TEXT NOT NULL, thread_id TEXT NOT NULL, display_title TEXT, model_provider TEXT, PRIMARY KEY(host_id, thread_id))')
db.execute('CREATE TABLE local_thread_catalog_metadata(id INTEGER PRIMARY KEY, catalog_revision INTEGER NOT NULL)')
db.execute('INSERT INTO local_thread_catalog_metadata VALUES(1, 0)')
db.executemany('INSERT INTO local_thread_catalog VALUES(?,?,?,?)', [('local','t1','one','openai'),('local','t2','two','openai')])
db.commit(); db.close()
`, [catalogDb]);
  const record = prepareLaunchView(home, backup, {
    language: 'zh-CN', projectIds: [], threadIds: ['t1'],
  }, { modelProvider: 'codex_navo' });
  const during = JSON.parse(python("import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(json.dumps(db.execute('SELECT thread_id,model_provider FROM local_thread_catalog ORDER BY thread_id').fetchall())); db.close()", [catalogDb]));
  assert.deepEqual(during, [['t1', 'codex_navo']]);
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute("DELETE FROM local_thread_catalog WHERE thread_id='t1'")
db.execute("INSERT INTO local_thread_catalog VALUES('local','t3','three','codex_navo')")
db.commit(); db.close()
`, [catalogDb]);
  restoreLaunchView(record);
  const after = JSON.parse(python("import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(json.dumps(db.execute('SELECT thread_id,display_title,model_provider FROM local_thread_catalog ORDER BY thread_id').fetchall())); db.close()", [catalogDb]));
  assert.deepEqual(after, [['t2', 'two', 'openai'], ['t3', 'three', 'codex_navo']]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('launch transaction maps mixed providers for the active mode and restores each original provider', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-provider-'));
  const home = path.join(root, 'home');
  const backup = path.join(root, 'backup');
  fs.mkdirSync(home, { recursive: true });
  const db = path.join(home, 'state_5.sqlite');
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT NOT NULL, archived INTEGER NOT NULL, title TEXT NOT NULL)')
db.executemany('INSERT INTO threads VALUES(?,?,?,?)', [('account-thread','openai',0,'account'),('api-thread','codex_navo',0,'api')])
db.commit(); db.close()
`, [db]);
  const record = prepareLaunchView(home, backup, {
    language: 'zh-CN', projectIds: [], threadIds: ['account-thread', 'api-thread'],
  }, { modelProvider: 'openai' });
  const during = JSON.parse(python(`
import json, sqlite3, sys
db=sqlite3.connect(sys.argv[1])
print(json.dumps(db.execute('SELECT id,model_provider FROM threads ORDER BY id').fetchall()))
db.close()
`, [db]));
  assert.deepEqual(during, [['account-thread', 'openai'], ['api-thread', 'openai']]);
  python("import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute(\"UPDATE threads SET title='continued' WHERE id='api-thread'\"); db.commit(); db.close()", [db]);
  restoreLaunchView(record);
  const after = JSON.parse(python(`
import json, sqlite3, sys
db=sqlite3.connect(sys.argv[1])
print(json.dumps(db.execute('SELECT id,model_provider,title FROM threads ORDER BY id').fetchall()))
db.close()
`, [db]));
  assert.deepEqual(after, [['account-thread', 'openai', 'account'], ['api-thread', 'codex_navo', 'continued']]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('launch view restoration tolerates Codex adding and removing thread columns during startup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-schema-'));
  const home = path.join(root, 'home');
  const backup = path.join(root, 'backup');
  fs.mkdirSync(home, { recursive: true });
  const db = path.join(home, 'state_5.sqlite');
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, archived INTEGER, legacy_value TEXT)')
db.execute('INSERT INTO threads VALUES(?,?,?,?)', ('t1','openai',0,'legacy'))
db.commit(); db.close()
`, [db]);
  const record = prepareLaunchView(home, backup, {
    language: 'zh-CN', projectIds: [], threadIds: ['t1'],
  }, { modelProvider: 'codex_navo' });
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('ALTER TABLE threads RENAME TO threads_old')
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, archived INTEGER, current_value TEXT)')
db.execute('INSERT INTO threads VALUES(?,?,?,?)', ('t1','codex_navo',0,'current'))
db.execute('DROP TABLE threads_old')
db.commit(); db.close()
`, [db]);
  restoreLaunchView(record);
  const after = JSON.parse(python(`
import json, sqlite3, sys
db=sqlite3.connect(sys.argv[1])
print(json.dumps(db.execute('SELECT id,model_provider,archived,legacy_value FROM threads').fetchall()))
db.close()
`, [db]));
  assert.deepEqual(after, [['t1', 'openai', 0, 'legacy']]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('oversized rollout cleanup keeps normal records and only the newest compacted checkpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-optimize-'));
  const file = path.join(root, 'rollout-test.jsonl');
  const backupRoot = path.join(root, 'backups');
  const large = 'x'.repeat(55 * 1024 * 1024);
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'thread' } }),
    JSON.stringify({ type: 'compacted', payload: { replacement_history: [large] } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'kept' } }),
    JSON.stringify({ type: 'compacted', payload: { replacement_history: [large] } }),
  ].join('\n') + '\n');
  const result = await optimizeRolloutFile(file, backupRoot);
  assert.ok(result);
  assert.equal(result.removedCompactions, 1);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.filter((item) => item.type === 'compacted').length, 1);
  assert.equal(lines.some((item) => item.payload?.text === 'kept'), true);
  assert.equal(fs.existsSync(result.backup), true);
  fs.rmSync(root, { recursive: true, force: true });
});

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
    'local-projects': { p1: { name: 'Visible project', rootPaths: ['C:/workspace'] } },
    'thread-project-assignments': { 'thread-1': { projectId: 'p1' } },
  }));
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), `${JSON.stringify({ id: 'thread-1', thread_name: 'Visible conversation' })}\n`);
  const catalog = listCodexLaunchOptions(root);
  assert.equal(catalog.projects[0].label, 'Visible project');
  assert.equal(catalog.projects[0].threads[0].title, 'Visible conversation');
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
  assert.deepEqual(during, [['t1', 'codex_navo', 0], ['t2', 'openai', 1]]);
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

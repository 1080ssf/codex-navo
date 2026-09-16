const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  filterGlobalState, mergeLaunchGlobalState, listCodexLaunchOptions, prepareLaunchView, restoreLaunchView,
} = require('../lib/codex-launch-view');

function stateFixture() {
  return {
    'local-projects': {
      p1: { name: 'First', rootPaths: ['C:/first'] },
      hidden: { name: 'Unloaded', rootPaths: ['C:/hidden'] },
      p2: { name: 'Second', rootPaths: ['C:/second', 'C:/first'] },
      removedEarlier: { name: 'Not in sidebar', rootPaths: ['C:/old'] },
    },
    'project-order': ['p1', 'hidden', 'p2'],
    'pinned-project-ids': ['p1', 'hidden', 'p2'],
    'thread-project-assignments': {
      t1: { projectId: 'p1' }, t2: { projectId: 'p1' },
      unloaded: { projectId: 'p1' }, hiddenThread: { projectId: 'hidden' },
    },
    'projectless-thread-ids': ['loose', 'hiddenLoose'],
    'sidebar-project-thread-orders': {
      p1: { threadIds: ['t1', 'unloaded', 't2'], mode: 'manual' },
      hidden: { threadIds: ['hiddenThread'] },
      p2: { threadIds: [], mode: 'manual' },
    },
    'electron-persisted-atom-state': {
      'thread-workspace-state-v1:t1': { project: { projectKind: 'local', projectId: 'p1' }, keep: true },
      'thread-workspace-state-v1:hiddenThread': { project: { projectId: 'hidden' } },
      'thread-workspace-state-v1:atomOnly': { cwd: 'C:/hidden' },
      'sidebar-project-expanded-v1-codex:p1': true,
      'sidebar-project-expanded-v1-codex:hidden': true,
      'sidebar-project-expanded-v1-codex:p2': true,
      appearance: 'dark',
    },
    'selected-project': { projectKind: 'local', projectId: 'p1' },
  };
}

const selection = { language: 'zh-CN', projectIds: ['p1', 'p2'], threadIds: ['t1', 't2', 'loose'] };
function merge(original, live, selected = selection) {
  return mergeLaunchGlobalState(original, live, selected.threadIds, selected.projectIds);
}

function python(script, args) {
  const result = spawnSync('python', ['-c', script, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return String(result.stdout || '').trim();
}

function temporaryHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-launch-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, home, file: path.join(home, '.codex-global-state.json') };
}

test('unchanged filtered views preserve project, pin and thread order without mutating inputs', () => {
  const original = stateFixture();
  const live = filterGlobalState(original, selection);
  const originalCopy = structuredClone(original);
  const liveCopy = structuredClone(live);
  const output = merge(original, live);
  assert.deepEqual(output, original);
  assert.deepEqual(original, originalCopy);
  assert.deepEqual(live, liveCopy);
  output['local-projects'].p1.name = 'mutated result';
  output['electron-persisted-atom-state']['thread-workspace-state-v1:t1'].keep = false;
  assert.deepEqual(live, liveCopy);
});

test('explicit task moves and drag order survive while hidden task slots are retained', () => {
  const original = stateFixture();
  const live = filterGlobalState(original, selection);
  live['thread-project-assignments'].t1 = { projectId: 'p2', projectKind: 'local' };
  live['sidebar-project-thread-orders'].p1.threadIds = ['t2'];
  live['sidebar-project-thread-orders'].p2.threadIds = ['t1'];
  live['project-order'] = ['p2', 'p1'];
  live['pinned-project-ids'] = ['p2'];
  const output = merge(original, live);
  assert.deepEqual(output['thread-project-assignments'].t1, live['thread-project-assignments'].t1);
  assert.deepEqual(output['sidebar-project-thread-orders'].p1.threadIds, ['t2', 'unloaded']);
  assert.deepEqual(output['sidebar-project-thread-orders'].p2.threadIds, ['t1']);
  assert.equal(output['sidebar-project-thread-orders'].p1.mode, 'manual');
  assert.deepEqual(output['project-order'], ['p2', 'hidden', 'p1']);
  assert.deepEqual(output['pinned-project-ids'], ['p2', 'hidden']);
  assert.equal(output['electron-persisted-atom-state']['thread-workspace-state-v1:t1'].project.projectId, 'p2');
  assert.deepEqual(output['local-projects'].hidden, original['local-projects'].hidden);
});

test('reordering and resetting loaded project tasks never drops unloaded tasks', () => {
  const original = stateFixture();
  const live = filterGlobalState(original, selection);
  live['sidebar-project-thread-orders'].p1 = { threadIds: ['t2', 't1', 't1'], mode: 'manual-v2' };
  let output = merge(original, live);
  assert.deepEqual(output['sidebar-project-thread-orders'].p1, {
    threadIds: ['t2', 'unloaded', 't1'], mode: 'manual-v2',
  });
  delete live['sidebar-project-thread-orders'].p1;
  delete live['sidebar-project-thread-orders'].p2;
  output = merge(original, live);
  assert.deepEqual(output['sidebar-project-thread-orders'].p1.threadIds, ['unloaded']);
  assert.equal(output['sidebar-project-thread-orders'].p2, undefined);
});

test('auto workspace regrouping and resurfaced unloaded data cannot overwrite explicit scope', () => {
  const original = stateFixture();
  const selected = { ...selection, threadIds: [...selection.threadIds, 'hiddenThread'] };
  const live = filterGlobalState(original, selected);
  live['electron-persisted-atom-state']['thread-workspace-state-v1:t1'].project = { projectId: 'p2' };
  live['electron-persisted-atom-state']['thread-workspace-state-v1:hiddenThread'].project = { projectId: 'p1' };
  live['electron-persisted-atom-state']['thread-workspace-state-v1:atomOnly'] = { cwd: 'C:/first' };
  live['thread-project-assignments'].hiddenThread = { projectId: 'p1' };
  live['thread-project-assignments'].unloaded = { projectId: 'p2' };
  live['thread-project-assignments'].hiddenLoose = { projectId: 'p2' };
  live['thread-project-assignments'].atomOnly = { projectId: 'p2' };
  live['local-projects'].hidden = { name: 'Auto discovered', rootPaths: ['C:/hidden'] };
  live['local-projects'].removedEarlier = { name: 'Auto restored', rootPaths: ['C:/old'] };
  live['project-order'].push('hidden', 'removedEarlier');
  live['pinned-project-ids'].push('removedEarlier');
  live['sidebar-project-thread-orders'].p2.threadIds = ['t1', 'hiddenThread', 'unloaded'];
  live['sidebar-project-thread-orders'].hidden = { threadIds: ['t1'] };
  live['electron-persisted-atom-state']['sidebar-project-expanded-v1-codex:hidden'] = false;
  const output = merge(original, live, selected);
  assert.deepEqual(output['thread-project-assignments'], original['thread-project-assignments']);
  assert.deepEqual(output['project-order'], original['project-order']);
  assert.deepEqual(output['pinned-project-ids'], original['pinned-project-ids']);
  assert.deepEqual(output['local-projects'].hidden, original['local-projects'].hidden);
  assert.deepEqual(output['sidebar-project-thread-orders'].hidden, original['sidebar-project-thread-orders'].hidden);
  assert.deepEqual(output['sidebar-project-thread-orders'].p2.threadIds, []);
  assert.deepEqual(output['electron-persisted-atom-state'], original['electron-persisted-atom-state']);
});

test('selected task without its project retains its filtered assignment on an unchanged launch', () => {
  const original = stateFixture();
  const selected = { ...selection, projectIds: ['p2'] };
  const output = merge(original, filterGlobalState(original, selected), selected);
  assert.deepEqual(output['thread-project-assignments'], original['thread-project-assignments']);
  assert.deepEqual(output['sidebar-project-thread-orders'], original['sidebar-project-thread-orders']);
});

test('new projects and projectless tasks survive, and explicit ungrouping clears stale project state', () => {
  const original = stateFixture();
  const live = filterGlobalState(original, selection);
  live['local-projects'].newProject = { name: 'New', rootPaths: ['C:/new'] };
  live['project-order'].push('newProject');
  live['thread-project-assignments'].newTask = { projectId: 'newProject' };
  live['sidebar-project-thread-orders'].newProject = { threadIds: ['newTask'] };
  live['projectless-thread-ids'].push('newLoose', 't1');
  live['electron-persisted-atom-state']['thread-workspace-state-v1:newTask'] = { project: { projectId: 'newProject' } };
  const output = merge(original, live);
  assert.deepEqual(output['project-order'], ['p1', 'hidden', 'p2', 'newProject']);
  assert.deepEqual(output['thread-project-assignments'].newTask, { projectId: 'newProject' });
  assert.equal(output['thread-project-assignments'].t1, undefined);
  assert.deepEqual(output['projectless-thread-ids'], ['loose', 'hiddenLoose', 'newLoose', 't1']);
  assert.equal(output['sidebar-project-thread-orders'].p1.threadIds.includes('t1'), false);
  assert.equal(output['electron-persisted-atom-state']['thread-workspace-state-v1:t1'].project, null);
  assert.deepEqual(output['electron-persisted-atom-state']['thread-workspace-state-v1:newTask'],
    live['electron-persisted-atom-state']['thread-workspace-state-v1:newTask']);
});

test('project edits and deletion remove dangling references but do not resurrect hidden projects', () => {
  const original = stateFixture();
  const live = filterGlobalState(original, selection);
  live['local-projects'].p2 = { name: 'Renamed', rootPaths: ['C:/new-primary', 'C:/second'] };
  // Codex may leave the project object and task caches after sidebar deletion.
  live['project-order'] = ['p2'];
  live['selected-project'] = { projectId: 'p1' };
  const output = merge(original, live);
  assert.equal(output['local-projects'].p1, undefined);
  assert.deepEqual(output['local-projects'].p2, live['local-projects'].p2);
  assert.deepEqual(output['project-order'], ['p2', 'hidden']);
  assert.deepEqual(output['pinned-project-ids'], ['hidden', 'p2']);
  assert.deepEqual(output['thread-project-assignments'], { hiddenThread: { projectId: 'hidden' } });
  assert.equal(output['sidebar-project-thread-orders'].p1, undefined);
  assert.equal(output['electron-persisted-atom-state']['sidebar-project-expanded-v1-codex:p1'], undefined);
  assert.equal(output['electron-persisted-atom-state']['thread-workspace-state-v1:t1'].project, null);
  assert.equal(output['selected-project'], null);
});

test('legacy states without project-order do not delete projects during filter and restore', () => {
  const original = stateFixture();
  delete original['project-order'];
  const live = filterGlobalState(original, selection);
  assert.deepEqual(live['project-order'], ['p1', 'p2']);
  const output = merge(original, live);
  assert.deepEqual(output['local-projects'], original['local-projects']);
  assert.deepEqual(output['project-order'], ['p1', 'hidden', 'p2', 'removedEarlier']);
});

test('explicitly projectless tasks do not return to cwd-based groups in the next launch catalog', (t) => {
  const { home, file } = temporaryHome(t);
  const db = path.join(home, 'state_5.sqlite');
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, model_provider TEXT, name TEXT, title TEXT, first_user_message TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER, updated_at INTEGER, thread_source TEXT, source TEXT, archived INTEGER)')
db.execute('INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', ('t1','','C:/first','openai',None,'task','task',10,10,10,'cli','cli',0))
db.commit(); db.close()
`, [db]);
  const original = stateFixture();
  const live = filterGlobalState(original, selection);
  live['projectless-thread-ids'].push('t1');
  fs.writeFileSync(file, JSON.stringify(merge(original, live)));
  const catalog = listCodexLaunchOptions(home);
  assert.deepEqual(catalog.projects.find((project) => project.id === '__unassigned__').threads.map((item) => item.id), ['t1']);
  assert.deepEqual(catalog.projects.find((project) => project.id === 'p1').threads, []);
});

test('durable launch records recover moves across A, B, API and A without changing hidden state', (t) => {
  const { root, home, file } = temporaryHome(t);
  const original = stateFixture();
  fs.writeFileSync(file, JSON.stringify(original));
  for (const [index, provider] of ['openai', 'openai', 'codex_navo', 'openai'].entries()) {
    const selected = index === 1 ? { ...selection, projectIds: ['p2'], threadIds: ['t1'] } : selection;
    const record = prepareLaunchView(home, path.join(root, `backup-${index}`), selected, { modelProvider: provider });
    if (index === 0) {
      const live = JSON.parse(fs.readFileSync(file, 'utf8'));
      live['thread-project-assignments'].t1 = { projectId: 'p2' };
      live['sidebar-project-thread-orders'].p1.threadIds = ['t2'];
      live['sidebar-project-thread-orders'].p2.threadIds = ['t1'];
      fs.writeFileSync(file, JSON.stringify(live));
    }
    // The server persists this record; restoration must not rely on in-memory state.
    restoreLaunchView(JSON.parse(JSON.stringify(record)));
    const output = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(output['thread-project-assignments'].t1.projectId, 'p2');
    assert.deepEqual(output['sidebar-project-thread-orders'].p2.threadIds, ['t1']);
    assert.deepEqual(output['sidebar-project-thread-orders'].p1.threadIds, ['t2', 'unloaded']);
    assert.deepEqual(output['local-projects'].hidden, original['local-projects'].hidden);
    assert.deepEqual(output['project-order'], original['project-order']);
    assert.equal(fs.existsSync(record.backupDir), false);
  }
});

test('missing global state after an interrupted launch is restored from the durable backup', (t) => {
  const { root, home, file } = temporaryHome(t);
  const original = stateFixture();
  fs.writeFileSync(file, JSON.stringify(original));
  const record = prepareLaunchView(home, path.join(root, 'backup'), selection);
  fs.unlinkSync(file);
  restoreLaunchView(JSON.parse(JSON.stringify(record)));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), original);
});

test('archive, delete, and new-task state survive the real launch transaction together', (t) => {
  const { root, home, file } = temporaryHome(t);
  const db = path.join(home, 'state_5.sqlite');
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY, model_provider TEXT, archived INTEGER, title TEXT)')
db.executemany('INSERT INTO threads VALUES(?,?,?,?)', [('t1','openai',0,'archive'),('t2','openai',0,'delete'),('unloaded','openai',0,'hidden')])
db.commit(); db.close()
`, [db]);
  fs.writeFileSync(file, JSON.stringify(stateFixture()));
  const record = prepareLaunchView(home, path.join(root, 'backup'), selection, { modelProvider: 'codex_navo' });
  python(`
import sqlite3, sys
db=sqlite3.connect(sys.argv[1])
db.execute("UPDATE threads SET archived=1 WHERE id='t1'")
db.execute("DELETE FROM threads WHERE id='t2'")
db.execute("INSERT INTO threads VALUES('newTask','codex_navo',0,'new')")
db.commit(); db.close()
`, [db]);
  const live = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete live['thread-project-assignments'].t2;
  live['thread-project-assignments'].newTask = { projectId: 'p2' };
  live['sidebar-project-thread-orders'].p1.threadIds = [];
  live['sidebar-project-thread-orders'].p2.threadIds = ['newTask'];
  fs.writeFileSync(file, JSON.stringify(live));
  restoreLaunchView(record);
  const output = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(output['thread-project-assignments'].t2, undefined);
  assert.deepEqual(output['thread-project-assignments'].t1, { projectId: 'p1' });
  assert.deepEqual(output['sidebar-project-thread-orders'].p1.threadIds, ['unloaded']);
  assert.deepEqual(output['sidebar-project-thread-orders'].p2.threadIds, ['newTask']);
  const rows = JSON.parse(python("import json,sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(json.dumps(db.execute('SELECT id,model_provider,archived FROM threads ORDER BY id').fetchall())); db.close()", [db]));
  assert.deepEqual(rows, [['newTask', 'codex_navo', 0], ['t1', 'openai', 1], ['unloaded', 'openai', 0]]);
});

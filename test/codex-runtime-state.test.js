const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  acquireCodexConfigLock,
  linkSharedCodexState,
  mergeMissingCodexPreferences,
  repairSharedCodexConfig,
  repairSharedCodexThreadCatalog,
  releaseCodexConfigLock,
} = require('../lib/codex-runtime-state');

test('shared config lock is exclusive and ownership-safe', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-config-lock-'));
  const lockFile = path.join(root, 'config.lock');
  try {
    const lock = acquireCodexConfigLock(lockFile, { kind: 'test' });
    assert.equal(fs.existsSync(lockFile), true);
    assert.throws(
      () => acquireCodexConfigLock(lockFile, { kind: 'second' }),
      (error) => error.code === 'CODEX_CONFIG_LOCKED',
    );
    assert.equal(releaseCodexConfigLock(lockFile, 'different-owner'), false);
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(releaseCodexConfigLock(lockFile, lock.id), true);
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shared config lock recovers a marker whose owner exited', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-stale-config-lock-'));
  const lockFile = path.join(root, 'config.lock');
  try {
    fs.writeFileSync(lockFile, JSON.stringify({ id: 'stale', pid: 2147483647, createdAt: new Date(0).toISOString() }));
    const lock = acquireCodexConfigLock(lockFile, { kind: 'replacement' });
    assert.notEqual(lock.id, 'stale');
    assert.equal(releaseCodexConfigLock(lockFile, lock.id), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shared Codex preferences recover only missing known keys', () => {
  const current = 'personality = "pragmatic"\n\n[desktop]\nappearanceTheme = "light"\n';
  const backup = [
    'model = "gpt-5.6-sol"',
    'approval_policy = "never"',
    'personality = "old"',
    '',
    '[desktop]',
    'appearanceTheme = "dark"',
    'sansFontSize = 15',
    '',
  ].join('\n');
  const merged = mergeMissingCodexPreferences(current, backup);
  assert.equal(merged.changed, true);
  assert.match(merged.source, /model = "gpt-5\.6-sol"/);
  assert.match(merged.source, /approval_policy = "never"/);
  assert.match(merged.source, /personality = "pragmatic"/);
  assert.match(merged.source, /appearanceTheme = "light"/);
  assert.match(merged.source, /sansFontSize = 15/);
});

test('repair creates a safety backup and preserves current user choices', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-config-repair-'));
  try {
    fs.writeFileSync(path.join(home, 'config.toml'), 'personality = "pragmatic"\n');
    fs.writeFileSync(path.join(home, 'config.toml.bak'), 'model = "gpt-5.6-sol"\napproval_policy = "never"\npersonality = "old"\n');
    const result = repairSharedCodexConfig(home);
    assert.equal(result.changed, true);
    assert.equal(fs.existsSync(result.safetyBackup), true);
    const repaired = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    assert.match(repaired, /personality = "pragmatic"/);
    assert.match(repaired, /model = "gpt-5\.6-sol"/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isolated API runtime links shared session and SQLite state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-shared-state-'));
  const shared = path.join(root, 'shared');
  const isolated = path.join(root, 'isolated');
  try {
    fs.mkdirSync(path.join(shared, 'sqlite'), { recursive: true });
    fs.mkdirSync(path.join(shared, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(shared, 'sqlite', 'codex-dev.db'), 'shared-db');
    fs.mkdirSync(path.join(isolated, 'sqlite'), { recursive: true });
    fs.writeFileSync(path.join(isolated, 'sqlite', 'stale.db'), 'stale');
    const linked = linkSharedCodexState(shared, isolated);
    assert.deepEqual(linked.sort(), ['sessions', 'sqlite']);
    assert.equal(fs.lstatSync(path.join(isolated, 'sqlite')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(isolated, 'sqlite', 'codex-dev.db'), 'utf8'), 'shared-db');
    assert.equal(path.resolve(fs.realpathSync(path.join(isolated, 'sessions'))), path.resolve(path.join(shared, 'sessions')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('thread catalog repair rebuilds local desktop catalog from Codex state sqlite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-catalog-repair-'));
  const home = path.join(root, 'codex-home');
  const sqliteDir = path.join(home, 'sqlite');
  fs.mkdirSync(sqliteDir, { recursive: true });
  const stateDb = path.join(home, 'state_5.sqlite');
  const catalogDb = path.join(sqliteDir, 'codex-dev.db');
  const runSql = (db, sql) => {
    const script = [
      'import sqlite3, sys',
      'db, sql = sys.argv[1], sys.argv[2]',
      'con = sqlite3.connect(db)',
      'con.executescript(sql)',
      'con.commit()',
      'con.close()',
    ].join('\n');
    const result = require('node:child_process').spawnSync('python', ['-c', script, db, sql], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
  };
  const readSql = (db, sql) => {
    const script = [
      'import json, sqlite3, sys',
      'db, sql = sys.argv[1], sys.argv[2]',
      'con = sqlite3.connect(db)',
      'cur = con.execute(sql)',
      'print(json.dumps(cur.fetchall(), ensure_ascii=False))',
      'con.close()',
    ].join('\n');
    const result = require('node:child_process').spawnSync('python', ['-c', script, db, sql], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    runSql(stateDb, `
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        rollout_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        has_user_event INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        git_branch TEXT,
        first_user_message TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        thread_source TEXT,
        preview TEXT NOT NULL DEFAULT '',
        recency_at_ms INTEGER NOT NULL DEFAULT 0,
        name TEXT
      );
      INSERT INTO threads(id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, has_user_event, archived, git_branch, first_user_message, created_at_ms, updated_at_ms, thread_source, recency_at_ms)
      VALUES('thread-a', 'rollout-a.jsonl', 1000, 2000, 'desktop', 'openai', 'C:\\\\Project', 'Visible chat', 1, 0, 'main', 'hello', 1000000, 2000000, 'user', 2000000);
      INSERT INTO threads(id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, has_user_event, archived, git_branch, first_user_message, created_at_ms, updated_at_ms, thread_source, recency_at_ms)
      VALUES('thread-b', 'rollout-b.jsonl', 1000, 3000, 'vscode', 'openai', 'C:\\\\Project', 'Imported visible chat', 0, 0, 'main', '', 1000000, 3000000, 'user', 3000000);
      INSERT INTO threads(id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, has_user_event, archived)
      VALUES('archived', 'rollout-c.jsonl', 1000, 2000, 'desktop', 'openai', 'C:\\\\Project', 'Archived chat', 1, 1);
    `);
    runSql(catalogDb, `
      CREATE TABLE local_thread_catalog (
        host_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        display_title TEXT NOT NULL,
        source_created_at REAL NOT NULL,
        source_updated_at REAL NOT NULL,
        cwd TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_detail TEXT,
        model_provider TEXT NOT NULL,
        git_branch TEXT,
        observation_sequence INTEGER NOT NULL,
        missing_candidate INTEGER NOT NULL DEFAULT 0 CHECK (missing_candidate IN (0, 1)),
        thread_source TEXT,
        source_recency_at REAL NOT NULL DEFAULT 0,
        pending_observed_title INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (host_id, thread_id)
      );
      CREATE TABLE local_thread_catalog_hosts (
        host_id TEXT PRIMARY KEY,
        host_kind TEXT NOT NULL CHECK (host_kind IN ('local', 'ssh', 'wsl', 'remote-control'))
      );
      CREATE TABLE local_thread_catalog_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        catalog_revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE local_thread_catalog_sync_state (
        host_id TEXT PRIMARY KEY,
        watermark_updated_at REAL,
        initial_build_complete INTEGER NOT NULL DEFAULT 0,
        observation_sequence INTEGER NOT NULL DEFAULT 0,
        last_full_reconciled_at INTEGER
      );
      INSERT INTO local_thread_catalog_hosts(host_id, host_kind) VALUES('local', 'local');
      INSERT INTO local_thread_catalog_metadata(id, catalog_revision) VALUES(1, 0);
      INSERT INTO local_thread_catalog_sync_state(host_id, initial_build_complete, observation_sequence) VALUES('local', 0, 7);
    `);
    const result = repairSharedCodexThreadCatalog(home);
    assert.equal(result.changed, true);
    const rows = readSql(catalogDb, 'SELECT host_id, thread_id, display_title, cwd, git_branch FROM local_thread_catalog ORDER BY thread_id');
    assert.deepEqual(rows, [
      ['local', 'thread-a', 'Visible chat', 'C:\\\\Project', 'main'],
      ['local', 'thread-b', 'Imported visible chat', 'C:\\\\Project', 'main'],
    ]);
    const sync = readSql(catalogDb, "SELECT initial_build_complete FROM local_thread_catalog_sync_state WHERE host_id='local'");
    assert.deepEqual(sync, [[1]]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

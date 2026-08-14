'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { activateAutomationScope, deactivateAutomationScope, quarantineLegacyApiAutomations, readAutomationScope } = require('../lib/codex-automation-scope');

function createFixture(home) {
  fs.mkdirSync(path.join(home, 'sqlite'), { recursive: true });
  const catalog = new DatabaseSync(path.join(home, 'sqlite', 'codex-dev.db'));
  catalog.exec(`
    CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, next_run_at INTEGER, last_run_at INTEGER, cwds TEXT NOT NULL, rrule TEXT NOT NULL, model TEXT, reasoning_effort TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, target_type TEXT, project_id TEXT);
    CREATE TABLE automation_runs (thread_id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  `);
  catalog.prepare("INSERT INTO automations (id,name,prompt,status,cwds,rrule,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run('normal-auto', 'Normal', 'normal prompt', 'ACTIVE', '[]', 'FREQ=DAILY', 1, 1);
  catalog.prepare("INSERT INTO automations (id,name,prompt,status,cwds,rrule,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run('leaked-api-auto', 'API', 'api prompt', 'ACTIVE', '[]', 'FREQ=DAILY', 2, 2);
  catalog.prepare("INSERT INTO automation_runs (thread_id,automation_id,status,created_at,updated_at) VALUES (?,?,?,?,?)").run('normal-thread', 'normal-auto', 'COMPLETED', 1, 1);
  catalog.prepare("INSERT INTO automation_runs (thread_id,automation_id,status,created_at,updated_at) VALUES (?,?,?,?,?)").run('api-thread', 'leaked-api-auto', 'COMPLETED', 2, 2);
  catalog.close();
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, model_provider TEXT NOT NULL)');
  state.prepare('INSERT INTO threads (id,model_provider) VALUES (?,?)').run('normal-thread', 'openai');
  state.prepare('INSERT INTO threads (id,model_provider) VALUES (?,?)').run('api-thread', 'codex_navo');
  state.close();
}

test('API automation scope is isolated while normal projects can keep using the shared catalog', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-automation-scope-'));
  const home = path.join(root, 'home');
  const apiFile = path.join(root, 'api-scope.json');
  const backupFile = path.join(root, 'normal-backup.json');
  try {
    createFixture(home);
    const activated = activateAutomationScope(home, apiFile, backupFile);
    assert.equal(activated.active, true);
    assert.equal(activated.migrated, 1);
    assert.deepEqual(readAutomationScope(home).tables.automations.map((row) => row.id), ['leaked-api-auto']);

    const database = new DatabaseSync(path.join(home, 'sqlite', 'codex-dev.db'));
    database.prepare("INSERT INTO automations (id,name,prompt,status,cwds,rrule,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run('new-api-auto', 'New API', 'new prompt', 'ACTIVE', '[]', 'FREQ=HOURLY', 3, 3);
    database.close();

    const restored = deactivateAutomationScope(home, apiFile, backupFile);
    assert.equal(restored.restored, true);
    assert.deepEqual(readAutomationScope(home).tables.automations.map((row) => row.id), ['normal-auto']);
    const apiSnapshot = JSON.parse(fs.readFileSync(apiFile, 'utf8'));
    assert.deepEqual(apiSnapshot.tables.automations.map((row) => row.id).sort(), ['leaked-api-auto', 'new-api-auto']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('previously leaked API automations are quarantined before another normal launch', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-automation-quarantine-'));
  const home = path.join(root, 'home');
  const legacyFile = path.join(root, 'legacy-api.json');
  try {
    createFixture(home);
    const result = quarantineLegacyApiAutomations(home, legacyFile);
    assert.equal(result.migrated, 1);
    assert.deepEqual(readAutomationScope(home).tables.automations.map((row) => row.id), ['normal-auto']);
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyFile, 'utf8')).tables.automations.map((row) => row.id), ['leaked-api-auto']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const TABLES = ['automations', 'automation_runs'];
const PRIMARY_KEYS = { automations: 'id', automation_runs: 'thread_id' };

function emptySnapshot() {
  return { schemaVersion: 1, tables: { automations: [], automation_runs: [] } };
}

function normalizeSnapshot(value) {
  const snapshot = emptySnapshot();
  for (const table of TABLES) {
    snapshot.tables[table] = Array.isArray(value?.tables?.[table])
      ? value.tables[table].filter((row) => row && typeof row === 'object').map((row) => ({ ...row }))
      : [];
  }
  return snapshot;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function databaseFile(codexHome) {
  return path.join(codexHome, 'sqlite', 'codex-dev.db');
}

function tableExists(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function readAutomationScope(codexHome) {
  const file = databaseFile(codexHome);
  if (!fs.existsSync(file)) return emptySnapshot();
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    const snapshot = emptySnapshot();
    for (const table of TABLES) {
      if (tableExists(database, table)) snapshot.tables[table] = database.prepare(`SELECT * FROM "${table}"`).all().map((row) => ({ ...row }));
    }
    return snapshot;
  } finally {
    database.close();
  }
}

function replaceAutomationScope(codexHome, snapshotValue) {
  const file = databaseFile(codexHome);
  if (!fs.existsSync(file)) return false;
  const snapshot = normalizeSnapshot(snapshotValue);
  const database = new DatabaseSync(file);
  try {
    database.exec('BEGIN IMMEDIATE');
    for (const table of [...TABLES].reverse()) {
      if (tableExists(database, table)) database.exec(`DELETE FROM "${table}"`);
    }
    for (const table of TABLES) {
      if (!tableExists(database, table)) continue;
      const available = new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
      for (const row of snapshot.tables[table]) {
        const columns = Object.keys(row).filter((column) => available.has(column) && row[column] !== undefined);
        if (!columns.length) continue;
        const identifiers = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(', ');
        const placeholders = columns.map(() => '?').join(', ');
        database.prepare(`INSERT INTO "${table}" (${identifiers}) VALUES (${placeholders})`).run(...columns.map((column) => row[column]));
      }
    }
    database.exec('COMMIT');
    return true;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

function legacyApiAutomationIds(codexHome, snapshot) {
  const stateFile = path.join(codexHome, 'state_5.sqlite');
  if (!fs.existsSync(stateFile)) return new Set();
  const database = new DatabaseSync(stateFile, { readOnly: true });
  try {
    if (!tableExists(database, 'threads')) return new Set();
    const apiThreads = new Set(database.prepare("SELECT id FROM threads WHERE model_provider = 'codex_navo'").all().map((row) => String(row.id)));
    return new Set(snapshot.tables.automation_runs
      .filter((row) => apiThreads.has(String(row.thread_id)))
      .map((row) => String(row.automation_id)));
  } finally {
    database.close();
  }
}

function mergeRows(left, right, key) {
  const merged = new Map();
  for (const row of [...left, ...right]) {
    const id = String(row?.[key] || '');
    if (!id) continue;
    const current = merged.get(id);
    if (!current || Number(row.updated_at || row.created_at || 0) >= Number(current.updated_at || current.created_at || 0)) merged.set(id, row);
  }
  return [...merged.values()];
}

function mergeSnapshots(leftValue, rightValue) {
  const left = normalizeSnapshot(leftValue);
  const right = normalizeSnapshot(rightValue);
  const output = emptySnapshot();
  for (const table of TABLES) output.tables[table] = mergeRows(left.tables[table], right.tables[table], PRIMARY_KEYS[table]);
  return output;
}

function splitLegacyApiScope(codexHome, snapshotValue) {
  const snapshot = normalizeSnapshot(snapshotValue);
  const apiIds = legacyApiAutomationIds(codexHome, snapshot);
  const api = emptySnapshot();
  const normal = emptySnapshot();
  for (const row of snapshot.tables.automations) (apiIds.has(String(row.id)) ? api : normal).tables.automations.push(row);
  for (const row of snapshot.tables.automation_runs) (apiIds.has(String(row.automation_id)) ? api : normal).tables.automation_runs.push(row);
  return { api, normal, migrated: apiIds.size };
}

function quarantineLegacyApiAutomations(codexHome, legacyScopeFile) {
  if (!fs.existsSync(databaseFile(codexHome))) return { migrated: 0 };
  const current = readAutomationScope(codexHome);
  const split = splitLegacyApiScope(codexHome, current);
  if (!split.migrated) return { migrated: 0 };
  writeJsonAtomic(legacyScopeFile, mergeSnapshots(readJson(legacyScopeFile, emptySnapshot()), split.api));
  replaceAutomationScope(codexHome, split.normal);
  return { migrated: split.migrated };
}

function activateAutomationScope(codexHome, apiScopeFile, normalBackupFile, legacyScopeFile = '') {
  if (!fs.existsSync(databaseFile(codexHome))) return { active: false, migrated: 0 };
  const current = readAutomationScope(codexHome);
  const split = splitLegacyApiScope(codexHome, current);
  let api = mergeSnapshots(readJson(apiScopeFile, emptySnapshot()), split.api);
  if (legacyScopeFile) api = mergeSnapshots(api, readJson(legacyScopeFile, emptySnapshot()));
  writeJsonAtomic(normalBackupFile, split.normal);
  replaceAutomationScope(codexHome, api);
  if (legacyScopeFile) fs.rmSync(legacyScopeFile, { force: true });
  return { active: true, migrated: split.migrated };
}

function deactivateAutomationScope(codexHome, apiScopeFile, normalBackupFile) {
  const normal = normalizeSnapshot(readJson(normalBackupFile, null));
  if (!fs.existsSync(normalBackupFile)) return { restored: false, saved: false };
  const current = readAutomationScope(codexHome);
  const changed = JSON.stringify(current) !== JSON.stringify(normal);
  if (changed) writeJsonAtomic(apiScopeFile, current);
  replaceAutomationScope(codexHome, normal);
  fs.rmSync(normalBackupFile, { force: true });
  return { restored: true, saved: changed };
}

module.exports = {
  activateAutomationScope,
  deactivateAutomationScope,
  emptySnapshot,
  quarantineLegacyApiAutomations,
  readAutomationScope,
  replaceAutomationScope,
  splitLegacyApiScope,
};

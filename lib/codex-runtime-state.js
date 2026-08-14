const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT_KEYS_TO_RECOVER = [
  'model',
  'model_reasoning_effort',
  'service_tier',
  'approval_policy',
  'sandbox_mode',
  'model_provider',
];

const DESKTOP_KEYS_TO_RECOVER = [
  'sansFontSize',
  'codeFontSize',
  'ambient-suggestions-enabled',
  'show-context-window-usage',
  'show-ultra-in-model-picker-slider',
  'enabled-reasoning-efforts',
  'usePointerCursors',
  'appearanceLightCodeThemeId',
  'appearanceLightChromeTheme',
  'defaultTerminalLocation',
  'appearanceTheme',
];

const SHARED_STATE_DIRECTORIES = [
  'sqlite',
  'sessions',
  'archived_sessions',
  'attachments',
];

function splitToml(source) {
  const lines = String(source || '').split(/\r?\n/);
  let section = '';
  const root = new Map();
  const sections = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!sections.has(section)) sections.set(section, new Map());
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/);
    if (!keyMatch) continue;
    const target = section ? sections.get(section) : root;
    if (!target.has(keyMatch[1])) target.set(keyMatch[1], { index, line: lines[index] });
  }
  return { lines, root, sections };
}

function insertSectionEntries(lines, sectionName, entries) {
  if (!entries.length) return lines;
  const header = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return [...lines, '', header, ...entries];
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  return [...lines.slice(0, end), ...entries, ...lines.slice(end)];
}

function mergeMissingCodexPreferences(currentSource, backupSource) {
  const current = splitToml(currentSource);
  const backup = splitToml(backupSource);
  const missingRootLines = ROOT_KEYS_TO_RECOVER
    .filter((key) => !current.root.has(key) && backup.root.has(key))
    .map((key) => backup.root.get(key).line);
  const currentDesktop = current.sections.get('desktop') || new Map();
  const backupDesktop = backup.sections.get('desktop') || new Map();
  const missingDesktopLines = DESKTOP_KEYS_TO_RECOVER
    .filter((key) => !currentDesktop.has(key) && backupDesktop.has(key))
    .map((key) => backupDesktop.get(key).line);
  if (!missingRootLines.length && !missingDesktopLines.length) {
    return { changed: false, source: String(currentSource || ''), recovered: [] };
  }
  let lines = [...missingRootLines, ...current.lines];
  lines = insertSectionEntries(lines, 'desktop', missingDesktopLines);
  return {
    changed: true,
    source: `${lines.join('\n').replace(/\n+$/, '')}\n`,
    recovered: [
      ...missingRootLines.map((line) => line.trim().split(/\s*=/, 1)[0]),
      ...missingDesktopLines.map((line) => `desktop.${line.trim().split(/\s*=/, 1)[0]}`),
    ],
  };
}

function recoveryScore(source) {
  const parsed = splitToml(source);
  const desktop = parsed.sections.get('desktop') || new Map();
  return ROOT_KEYS_TO_RECOVER.filter((key) => parsed.root.has(key)).length * 10
    + DESKTOP_KEYS_TO_RECOVER.filter((key) => desktop.has(key)).length;
}

function bestCodexConfigBackup(codexHome) {
  if (!fs.existsSync(codexHome)) return null;
  const candidates = fs.readdirSync(codexHome)
    .filter((name) => /^config\.toml\.bak(?:_|$)/i.test(name))
    .map((name) => {
      const file = path.join(codexHome, name);
      const source = fs.readFileSync(file, 'utf8');
      return { file, source, score: recoveryScore(source), mtimeMs: fs.statSync(file).mtimeMs };
    })
    .sort((left, right) => right.score - left.score || right.mtimeMs - left.mtimeMs);
  return candidates[0] || null;
}

function repairSharedCodexConfig(codexHome) {
  const configFile = path.join(codexHome, 'config.toml');
  if (!fs.existsSync(configFile)) return { changed: false, recovered: [] };
  const currentSource = fs.readFileSync(configFile, 'utf8');
  const backup = bestCodexConfigBackup(codexHome);
  if (!backup || backup.score <= recoveryScore(currentSource)) return { changed: false, recovered: [] };
  const merged = mergeMissingCodexPreferences(currentSource, backup.source);
  if (!merged.changed) return merged;
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const safetyBackup = path.join(codexHome, `config.toml.navo-recovery-${timestamp}.bak`);
  fs.copyFileSync(configFile, safetyBackup, fs.constants.COPYFILE_EXCL);
  const temporary = `${configFile}.navo-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(temporary, merged.source, { mode: 0o600 });
  fs.renameSync(temporary, configFile);
  return { ...merged, backup: backup.file, safetyBackup };
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function acquireCodexConfigLock(lockFile, details = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = {
      id: crypto.randomUUID(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      ...details,
    };
    try {
      fs.writeFileSync(lockFile, `${JSON.stringify(lock)}\n`, { flag: 'wx', mode: 0o600 });
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch {}
      let recentUnreadableLock = false;
      if (!existing) {
        try { recentUnreadableLock = Date.now() - fs.statSync(lockFile).mtimeMs < 120_000; } catch {}
      }
      if (recentUnreadableLock || (existing && processIsAlive(Number(existing.pid)))) {
        const busy = new Error('Codex shared config is already managed by another Navo process');
        busy.code = 'CODEX_CONFIG_LOCKED';
        throw busy;
      }
      fs.rmSync(lockFile, { force: true });
    }
  }
  const error = new Error('Codex shared config lock could not be acquired');
  error.code = 'CODEX_CONFIG_LOCKED';
  throw error;
}

function releaseCodexConfigLock(lockFile, lockId) {
  if (!fs.existsSync(lockFile)) return false;
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return false; }
  if (!lockId || existing.id !== lockId) return false;
  fs.rmSync(lockFile, { force: true });
  return true;
}

function pythonCandidates() {
  const candidates = [];
  if (process.env.CODEX_NAVO_PYTHON) candidates.push(process.env.CODEX_NAVO_PYTHON);
  candidates.push('python', 'py');
  return [...new Set(candidates.filter(Boolean))];
}

function runPython(script, args) {
  for (const executable of pythonCandidates()) {
    const commandArgs = executable.toLowerCase() === 'py'
      ? ['-3', '-c', script, ...args]
      : ['-c', script, ...args];
    const result = spawnSync(executable, commandArgs, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (!result.error) return result;
    if (result.error.code !== 'ENOENT') return result;
  }
  return {
    status: 1,
    stdout: '',
    stderr: 'Python runtime was not found',
    error: Object.assign(new Error('Python runtime was not found'), { code: 'ENOENT' }),
  };
}

const THREAD_CATALOG_REPAIR_SCRIPT = String.raw`
import json
import os
import shutil
import sqlite3
import sys
import time

codex_home = sys.argv[1]
state_db = os.path.join(codex_home, 'state_5.sqlite')
catalog_db = os.path.join(codex_home, 'sqlite', 'codex-dev.db')

def result(**kwargs):
    print(json.dumps(kwargs, ensure_ascii=False))

if not os.path.exists(state_db) or not os.path.exists(catalog_db):
    result(changed=False, reason='missing-db')
    raise SystemExit(0)

source = sqlite3.connect(f'file:{state_db}?mode=ro', uri=True)
source.row_factory = sqlite3.Row
try:
    rows = source.execute("""
        SELECT
          id,
          rollout_path,
          COALESCE(NULLIF(created_at_ms, 0), created_at * 1000) AS created_ms,
          COALESCE(NULLIF(updated_at_ms, 0), updated_at * 1000) AS updated_ms,
          COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), updated_at * 1000) AS recency_ms,
          source,
          model_provider,
          cwd,
          COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(first_user_message, ''), id) AS display_title,
          git_branch,
          COALESCE(NULLIF(thread_source, ''), NULLIF(source, ''), 'local') AS thread_source
        FROM threads
        WHERE archived = 0
          AND (
            COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(first_user_message, ''), NULLIF(preview, '')) IS NOT NULL
            OR COALESCE(NULLIF(rollout_path, ''), '') != ''
          )
        ORDER BY COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), updated_at * 1000) DESC
    """).fetchall()
finally:
    source.close()

if not rows:
    result(changed=False, reason='no-source-threads')
    raise SystemExit(0)

dest = sqlite3.connect(catalog_db, timeout=10)
try:
    dest.execute('PRAGMA busy_timeout=10000')
    dest.execute('PRAGMA journal_mode=WAL')
    existing = dest.execute("SELECT COUNT(*) FROM local_thread_catalog WHERE host_id = 'local'").fetchone()[0]
    source_count = len(rows)
    if existing >= source_count:
        result(changed=False, reason='catalog-current', sourceCount=source_count, catalogCount=existing)
        raise SystemExit(0)

    timestamp = time.strftime('%Y%m%d%H%M%S')
    backup = f'{catalog_db}.navo-catalog-repair-{timestamp}.bak'
    shutil.copy2(catalog_db, backup)

    sync_row = dest.execute("SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id = 'local'").fetchone()
    sequence = int(sync_row[0]) if sync_row and sync_row[0] is not None else 0
    now_ms = int(time.time() * 1000)
    max_updated = 0

    with dest:
        dest.execute("INSERT OR IGNORE INTO local_thread_catalog_hosts(host_id, host_kind) VALUES('local', 'local')")
        dest.execute("DELETE FROM local_thread_catalog WHERE host_id = 'local'")
        for row in rows:
            sequence += 1
            created = float(row['created_ms'] or 0)
            updated = float(row['updated_ms'] or created)
            recency = float(row['recency_ms'] or updated)
            max_updated = max(max_updated, updated)
            dest.execute("""
                INSERT INTO local_thread_catalog(
                  host_id, thread_id, display_title, source_created_at, source_updated_at,
                  cwd, source_kind, source_detail, model_provider, git_branch,
                  observation_sequence, missing_candidate, thread_source, source_recency_at,
                  pending_observed_title
                ) VALUES('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)
            """, (
                row['id'],
                row['display_title'],
                created,
                updated,
                row['cwd'] or '',
                row['source'] or 'local',
                row['rollout_path'] or '',
                row['model_provider'] or 'openai',
                row['git_branch'],
                sequence,
                row['thread_source'] or 'local',
                recency,
            ))
        dest.execute("INSERT OR IGNORE INTO local_thread_catalog_metadata(id, catalog_revision) VALUES(1, 0)")
        dest.execute("UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1")
        dest.execute("""
            INSERT INTO local_thread_catalog_sync_state(
              host_id, watermark_updated_at, initial_build_complete, observation_sequence, last_full_reconciled_at
            ) VALUES('local', ?, 1, ?, ?)
            ON CONFLICT(host_id) DO UPDATE SET
              watermark_updated_at=excluded.watermark_updated_at,
              initial_build_complete=1,
              observation_sequence=excluded.observation_sequence,
              last_full_reconciled_at=excluded.last_full_reconciled_at
        """, (max_updated, sequence, now_ms))

    result(changed=True, sourceCount=source_count, catalogCount=source_count, backup=backup)
finally:
    dest.close()
`;

function repairSharedCodexThreadCatalog(codexHome) {
  const stateDb = path.join(codexHome, 'state_5.sqlite');
  const catalogDb = path.join(codexHome, 'sqlite', 'codex-dev.db');
  if (!fs.existsSync(stateDb) || !fs.existsSync(catalogDb)) {
    return { changed: false, reason: 'missing-db' };
  }
  const result = runPython(THREAD_CATALOG_REPAIR_SCRIPT, [codexHome]);
  if (result.status !== 0) {
    return {
      changed: false,
      reason: 'repair-failed',
      error: String(result.stderr || result.error?.message || '').trim(),
    };
  }
  try {
    return JSON.parse(String(result.stdout || '').trim().split(/\r?\n/).pop() || '{}');
  } catch (error) {
    return { changed: false, reason: 'invalid-repair-output', error: error.message };
  }
}

function removeIsolatedEntry(isolatedHome, entry) {
  const target = path.resolve(isolatedHome, entry);
  const relative = path.relative(path.resolve(isolatedHome), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`隔离状态路径越界：${entry}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  return target;
}

function linkSharedCodexState(sharedHome, isolatedHome) {
  fs.mkdirSync(isolatedHome, { recursive: true });
  const linked = [];
  for (const name of SHARED_STATE_DIRECTORIES) {
    const shared = path.join(sharedHome, name);
    if (!fs.existsSync(shared) || !fs.statSync(shared).isDirectory()) continue;
    const isolated = path.join(isolatedHome, name);
    let matches = false;
    try {
      matches = fs.lstatSync(isolated).isSymbolicLink()
        && path.resolve(fs.realpathSync(isolated)) === path.resolve(shared);
    } catch {}
    if (!matches) {
      removeIsolatedEntry(isolatedHome, name);
      fs.symlinkSync(shared, isolated, 'junction');
    }
    linked.push(name);
  }
  return linked;
}

module.exports = {
  DESKTOP_KEYS_TO_RECOVER,
  ROOT_KEYS_TO_RECOVER,
  SHARED_STATE_DIRECTORIES,
  bestCodexConfigBackup,
  acquireCodexConfigLock,
  linkSharedCodexState,
  mergeMissingCodexPreferences,
  releaseCodexConfigLock,
  repairSharedCodexConfig,
  repairSharedCodexThreadCatalog,
};

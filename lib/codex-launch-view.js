const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');
const { assertUnchanged, beginRolloutMaintenance, checkRolloutSpace, fileFingerprint, rolloutBackupStorage } = require('./rollout-file-guard');
const { spawnSync } = require('node:child_process');
const { CODEX_LOCALES, SUPPORTED_LOCALES, resolveLocale } = require('./locales');

const GLOBAL_STATE_FILE = '.codex-global-state.json';

function runPython(script, args, timeout = 30_000) {
  for (const executable of ['python', 'py']) {
    const commandArgs = executable === 'py' ? ['-3', '-c', script, ...args] : ['-c', script, ...args];
    const result = spawnSync(executable, commandArgs, {
      encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
    });
    if (!result.error || result.error.code !== 'ENOENT') return result;
  }
  return { status: 1, stdout: '', stderr: 'Python runtime was not found' };
}

function runPythonWithLockRetry(script, args, attempts = 12) {
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = runPython(script, args);
    if (result.status === 0) return result;
    const detail = String(result.stderr || result.stdout || '');
    if (!/(?:database is locked|being used by another process|winerror 32|eperm|ebusy)/i.test(detail)) return result;
    if (attempt + 1 < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return result;
}

const THREAD_LIST_SCRIPT = String.raw`
import json, os, sqlite3, sys
home = sys.argv[1]
db_path = os.path.join(home, 'state_5.sqlite')
if not os.path.exists(db_path):
    print('[]')
    raise SystemExit(0)
db = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
db.row_factory = sqlite3.Row
try:
    rows = db.execute('''
      SELECT id, rollout_path, cwd, model_provider,
             COALESCE(NULLIF(name, ''), NULLIF(title, ''), NULLIF(first_user_message, ''), id) AS display_title,
             COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), updated_at * 1000) AS recency_ms,
             COALESCE(NULLIF(thread_source, ''), NULLIF(source, ''), 'local') AS thread_source,
             source
      FROM threads
      WHERE archived = 0 AND source IN ('vscode', 'cli')
      ORDER BY COALESCE(NULLIF(recency_at_ms, 0), NULLIF(updated_at_ms, 0), updated_at * 1000) DESC
    ''').fetchall()
    result = []
    for row in rows:
        item = dict(row)
        rollout = item.get('rollout_path') or ''
        item['size_bytes'] = os.path.getsize(rollout) if rollout and os.path.exists(rollout) else 0
        result.append(item)
    print(json.dumps(result, ensure_ascii=False))
finally:
    db.close()
`;

function normalizeFsPath(value) {
  return path.normalize(String(value || '').replace(/^\\\\\?\\/, '')).toLowerCase();
}

function readGlobalState(codexHome) {
  try { return JSON.parse(fs.readFileSync(path.join(codexHome, GLOBAL_STATE_FILE), 'utf8')); }
  catch { return {}; }
}

function pruneMissingLocalProjects(codexHome) {
  const file = path.join(codexHome, GLOBAL_STATE_FILE);
  if (!fs.existsSync(file)) return { changed: false, removed: [], prunedRoots: 0 };
  const state = readGlobalState(codexHome);
  const projects = state['local-projects'] && typeof state['local-projects'] === 'object'
    ? { ...state['local-projects'] } : {};
  const removed = new Set();
  let prunedRoots = 0;
  for (const [projectId, project] of Object.entries(projects)) {
    const roots = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
    if (!roots.length) continue;
    const existingRoots = roots.filter((root) => fs.existsSync(root));
    prunedRoots += roots.length - existingRoots.length;
    if (!existingRoots.length) {
      removed.add(projectId);
      delete projects[projectId];
    } else if (existingRoots.length !== roots.length) {
      projects[projectId] = { ...project, rootPaths: existingRoots };
    }
  }
  if (!removed.size && !prunedRoots) return { changed: false, removed: [], prunedRoots: 0 };
  state['local-projects'] = projects;
  for (const key of ['project-order', 'pinned-project-ids']) {
    if (Array.isArray(state[key])) state[key] = state[key].filter((id) => !removed.has(id));
  }
  if (state['thread-project-assignments'] && typeof state['thread-project-assignments'] === 'object') {
    state['thread-project-assignments'] = Object.fromEntries(Object.entries(state['thread-project-assignments'])
      .filter(([, value]) => !removed.has(value?.projectId)));
  }
  if (state['sidebar-project-thread-orders'] && typeof state['sidebar-project-thread-orders'] === 'object') {
    for (const projectId of removed) delete state['sidebar-project-thread-orders'][projectId];
  }
  if (state['electron-persisted-atom-state'] && typeof state['electron-persisted-atom-state'] === 'object') {
    for (const key of Object.keys(state['electron-persisted-atom-state'])) {
      const match = key.match(/^sidebar-project-expanded-v1-codex:(.+)$/);
      if (match && removed.has(match[1])) delete state['electron-persisted-atom-state'][key];
    }
  }
  if (removed.has(state['selected-project']?.projectId)) delete state['selected-project'];
  writeJsonAtomic(file, state);
  return { changed: true, removed: [...removed], prunedRoots };
}

function readSessionIndexNames(codexHome) {
  const names = new Map();
  try {
    for (const line of fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const item = JSON.parse(line);
        if (item.id && item.thread_name) names.set(String(item.id), String(item.thread_name).replace(/\s+/g, ' ').trim());
      } catch {}
    }
  } catch {}
  return names;
}

const SYNC_SESSION_INDEX_NAMES_SCRIPT = String.raw`
import json, os, sqlite3, sys
home, names_json = sys.argv[1:3]
names = json.loads(names_json)
changed = {'state': 0, 'catalog': 0}

state_path = os.path.join(home, 'state_5.sqlite')
if os.path.exists(state_path):
    db = sqlite3.connect(state_path, timeout=10)
    try:
        db.execute('PRAGMA busy_timeout=10000')
        columns = {row[1] for row in db.execute('PRAGMA table_info(threads)')}
        if 'id' in columns and 'name' in columns:
            with db:
                for thread_id, title in names.items():
                    cursor = db.execute(
                        "UPDATE threads SET name = ? WHERE id = ? AND COALESCE(name, '') <> ?",
                        (title, thread_id, title),
                    )
                    changed['state'] += cursor.rowcount
    finally:
        db.close()

catalog_path = os.path.join(home, 'sqlite', 'codex-dev.db')
if os.path.exists(catalog_path):
    db = sqlite3.connect(catalog_path, timeout=10)
    try:
        db.execute('PRAGMA busy_timeout=10000')
        columns = {row[1] for row in db.execute('PRAGMA table_info(local_thread_catalog)')}
        if {'host_id', 'thread_id', 'display_title'}.issubset(columns):
            with db:
                for thread_id, title in names.items():
                    cursor = db.execute(
                        "UPDATE local_thread_catalog SET display_title = ? WHERE host_id = 'local' AND thread_id = ? AND COALESCE(display_title, '') <> ?",
                        (title, thread_id, title),
                    )
                    changed['catalog'] += cursor.rowcount
                if changed['catalog']:
                    try:
                        db.execute("UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1")
                    except sqlite3.OperationalError:
                        pass
    finally:
        db.close()

print(json.dumps(changed))
`;

function syncSessionIndexNames(codexHome) {
  const names = readSessionIndexNames(codexHome);
  if (!names.size) return { state: 0, catalog: 0 };
  const result = runPythonWithLockRetry(SYNC_SESSION_INDEX_NAMES_SCRIPT, [codexHome, JSON.stringify(Object.fromEntries(names))]);
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Failed to sync Codex conversation names').trim());
  return JSON.parse(String(result.stdout || '{}').trim() || '{}');
}

function listCodexLaunchOptions(codexHome, preferredLanguage = 'zh-CN') {
  const result = runPython(THREAD_LIST_SCRIPT, [codexHome]);
  if (result.status !== 0) throw new Error(String(result.stderr || 'Failed to read Codex conversations').trim());
  const rows = JSON.parse(String(result.stdout || '[]').trim() || '[]');
  const state = readGlobalState(codexHome);
  const indexNames = readSessionIndexNames(codexHome);
  const projects = state['local-projects'] && typeof state['local-projects'] === 'object'
    ? state['local-projects'] : {};
  const hasProjectOrder = Object.prototype.hasOwnProperty.call(state, 'project-order')
    && Array.isArray(state['project-order']);
  const visibleProjectIds = hasProjectOrder ? new Set(state['project-order']) : new Set(Object.keys(projects));
  const assignments = state['thread-project-assignments'] && typeof state['thread-project-assignments'] === 'object'
    ? state['thread-project-assignments'] : {};
  const projectless = new Set(state['projectless-thread-ids'] || []);
  const byRoot = new Map();
  for (const [projectId, project] of Object.entries(projects)) {
    if (!visibleProjectIds.has(projectId)) continue;
    // Codex may retain historical/secondary roots after another project is
    // removed. Only the primary root is safe for implicit cwd grouping;
    // explicit thread-project assignments remain authoritative for all roots.
    const [primaryRoot] = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
    if (primaryRoot) byRoot.set(normalizeFsPath(primaryRoot), projectId);
  }
  const groups = new Map();
  for (const [projectId, project] of Object.entries(projects)) {
    if (!visibleProjectIds.has(projectId)) continue;
    const roots = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
    groups.set(projectId, {
      id: projectId,
      label: String(project?.name || '').trim() || (roots.length ? path.basename(roots[0]) : projectId),
      roots,
      threads: [],
    });
  }
  const unassigned = { id: '__unassigned__', label: '其他会话', roots: [], threads: [] };
  for (const row of rows) {
    const assigned = assignments[row.id]?.projectId;
    const projectId = projectless.has(row.id) ? undefined
      : groups.has(assigned) ? assigned : byRoot.get(normalizeFsPath(row.cwd));
    const target = groups.get(projectId) || unassigned;
    target.threads.push({
      id: row.id,
      title: indexNames.get(row.id) || row.display_title || row.id,
      cwd: row.cwd || '',
      provider: row.model_provider || 'openai',
      updatedAt: Number(row.recency_ms) || 0,
      sizeBytes: Number(row.size_bytes) || 0,
      oversized: Number(row.size_bytes) >= 500 * 1024 * 1024,
    });
  }
  if (unassigned.threads.length) groups.set(unassigned.id, unassigned);
  const order = Array.isArray(state['project-order']) ? state['project-order'] : [];
  const ordered = [...groups.values()]
    .filter((project) => project.threads.length || project.id !== '__unassigned__')
    .sort((left, right) => {
      const li = order.indexOf(left.id); const ri = order.indexOf(right.id);
      return (li < 0 ? Number.MAX_SAFE_INTEGER : li) - (ri < 0 ? Number.MAX_SAFE_INTEGER : ri)
        || left.label.localeCompare(right.label, 'zh-CN');
    });
  return {
    languages: CODEX_LOCALES,
    defaultLanguage: resolveLocale(preferredLanguage, 'zh-CN'),
    projects: ordered,
    threadCount: rows.length,
    oversizedThreadCount: rows.filter((row) => Number(row.size_bytes) >= 500 * 1024 * 1024).length,
  };
}

function normalizeLaunchSelection(value, catalog) {
  const knownThreads = new Set(catalog.projects.flatMap((project) => project.threads.map((thread) => thread.id)));
  const knownProjects = new Set(catalog.projects.map((project) => project.id));
  const requestedThreads = Array.isArray(value?.threadIds) ? value.threadIds : [...knownThreads];
  const requestedProjects = Array.isArray(value?.projectIds) ? value.projectIds : [...knownProjects];
  return {
    language: SUPPORTED_LOCALES.has(value?.language) ? value.language : catalog.defaultLanguage,
    threadIds: [...new Set(requestedThreads.filter((id) => knownThreads.has(id)))],
    projectIds: [...new Set(requestedProjects.filter((id) => knownProjects.has(id)))],
    optimizeOversized: value?.optimizeOversized === true,
  };
}

function setTomlSectionValue(source, sectionName, key, encodedValue) {
  const lines = String(source || '').split(/\r?\n/);
  const header = `[${sectionName}]`;
  let start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) return `${lines.join('\n').replace(/\n+$/, '')}\n\n${header}\n${key} = ${encodedValue}\n`;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[end])) end += 1;
  const keyPattern = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
  const existing = lines.slice(start + 1, end).findIndex((line) => keyPattern.test(line));
  if (existing >= 0) lines[start + 1 + existing] = `${key} = ${encodedValue}`;
  else lines.splice(end, 0, `${key} = ${encodedValue}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function setTomlTopLevelString(source, key, value) {
  const lines = String(source || '').split(/\r?\n/);
  const firstSection = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  const end = firstSection < 0 ? lines.length : firstSection;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?$`);
  const index = lines.slice(0, end).findIndex((line) => pattern.test(line));
  let combined = value;
  if (index >= 0) {
    const match = lines[index].match(pattern);
    try {
      const existing = JSON.parse(match[1]);
      if (existing && !existing.includes(value)) combined = `${existing}\n\n${value}`;
      else if (existing) combined = existing;
    } catch {}
    lines[index] = `${key} = ${JSON.stringify(combined)}`;
  } else {
    lines.splice(end, 0, `${key} = ${JSON.stringify(value)}`, ...(end ? [''] : []));
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function withDesktopLocale(source, language) {
  const locale = resolveLocale(language, 'zh-CN');
  const languageInstruction = locale === 'zh-CN'
    ? 'Use Simplified Chinese for task plans, progress updates, status text, and user-facing explanations unless the user explicitly requests another language.'
    : 'Use English for task plans, progress updates, status text, and user-facing explanations unless the user explicitly requests another language.';
  return setTomlSectionValue(
    setTomlTopLevelString(source, 'developer_instructions', languageInstruction),
    'desktop',
    'localeOverride',
    JSON.stringify(locale),
  );
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function filterGlobalState(state, selection) {
  const output = structuredClone(state || {});
  const threadIds = new Set(selection.threadIds);
  const projectIds = new Set(selection.projectIds.filter((id) => id !== '__unassigned__'));
  const filterObject = (value, predicate) => Object.fromEntries(Object.entries(value || {}).filter(([key, item]) => predicate(key, item)));
  output['local-projects'] = filterObject(output['local-projects'], (id) => projectIds.has(id));
  const projectOrder = Array.isArray(output['project-order']) ? output['project-order'] : Object.keys(output['local-projects']);
  output['project-order'] = projectOrder.filter((id) => projectIds.has(id));
  output['pinned-project-ids'] = (output['pinned-project-ids'] || []).filter((id) => projectIds.has(id));
  output['projectless-thread-ids'] = (output['projectless-thread-ids'] || []).filter((id) => threadIds.has(id));
  output['thread-project-assignments'] = filterObject(output['thread-project-assignments'], (id, item) => threadIds.has(id) && projectIds.has(item?.projectId));
  output['sidebar-project-thread-orders'] = Object.fromEntries(Object.entries(output['sidebar-project-thread-orders'] || {})
    .filter(([id]) => projectIds.has(id))
    .map(([id, item]) => [id, { ...item, threadIds: (item?.threadIds || []).filter((threadId) => threadIds.has(threadId)) }]));
  if (!projectIds.has(output['selected-project']?.projectId)) {
    const firstProject = [...projectIds][0];
    output['selected-project'] = firstProject ? { projectKind: 'local', projectId: firstProject } : null;
  }
  const atoms = output['electron-persisted-atom-state'];
  if (atoms && typeof atoms === 'object') {
    for (const key of Object.keys(atoms)) {
      const threadMatch = key.match(/^(?:thread-workspace-state-v1|heartbeat-thread-permissions-by-id)[:.]([^:.]+)$/i);
      if (threadMatch && !threadIds.has(threadMatch[1])) delete atoms[key];
      const projectMatch = key.match(/^sidebar-project-expanded-v1-codex:(.+)$/);
      if (projectMatch && !projectIds.has(projectMatch[1])) delete atoms[key];
    }
  }
  return output;
}

const FILTER_CATALOG_SCRIPT = String.raw`
import json, os, sqlite3, sys
db_path, backup_path, ids_json, provider = sys.argv[1:5]
ids = json.loads(ids_json)
if not os.path.exists(db_path):
    print(json.dumps({'changed': False, 'reason': 'missing-catalog'}))
    raise SystemExit(0)
src = sqlite3.connect(db_path, timeout=10)
backup = sqlite3.connect(backup_path)
try:
    src.backup(backup)
finally:
    backup.close()
try:
    src.execute('PRAGMA busy_timeout=10000')
    with src:
        if ids:
            placeholders = ','.join('?' for _ in ids)
            src.execute(f"DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id NOT IN ({placeholders})", ids)
            if provider:
                src.execute(f"UPDATE local_thread_catalog SET model_provider = ? WHERE host_id = 'local' AND thread_id IN ({placeholders})", [provider, *ids])
        else:
            src.execute("DELETE FROM local_thread_catalog WHERE host_id = 'local'")
        src.execute("UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1")
    print(json.dumps({'changed': True}))
finally:
    src.close()
`;

const FILTER_STATE_SCRIPT = String.raw`
import json, os, sqlite3, sys
db_path, backup_path, ids_json, provider = sys.argv[1:5]
ids = json.loads(ids_json)
if not os.path.exists(db_path):
    print(json.dumps({'changed': False, 'reason': 'missing-state'}))
    raise SystemExit(0)
src = sqlite3.connect(db_path, timeout=10)
backup = sqlite3.connect(backup_path)
try:
    src.backup(backup)
finally:
    backup.close()
try:
    src.execute('PRAGMA busy_timeout=10000')
    with src:
        if ids:
            placeholders = ','.join('?' for _ in ids)
            src.execute(f"DELETE FROM threads WHERE id NOT IN ({placeholders})", ids)
            src.execute(f"UPDATE threads SET archived = 0 WHERE id IN ({placeholders})", ids)
            if provider:
                src.execute(f"UPDATE threads SET model_provider = ? WHERE id IN ({placeholders})", [provider, *ids])
        else:
            src.execute('DELETE FROM threads')
    print(json.dumps({'changed': True}))
finally:
    src.close()
`;

const RESTORE_STATE_SCRIPT = String.raw`
import json, os, shutil, sqlite3, sys
db_path, backup_path, live_path, ids_json = sys.argv[1:5]
ids = set(json.loads(ids_json))
if not os.path.exists(backup_path):
    raise SystemExit(0)
live = sqlite3.connect(db_path, timeout=10)
snapshot = sqlite3.connect(live_path)
try:
    live.backup(snapshot)
finally:
    snapshot.close(); live.close()
for suffix in ('-wal', '-shm'):
    try: os.remove(db_path + suffix)
    except FileNotFoundError: pass
shutil.copy2(backup_path, db_path)
dest = sqlite3.connect(db_path, timeout=10)
source = sqlite3.connect(f'file:{live_path}?mode=ro', uri=True)
dest.row_factory = sqlite3.Row; source.row_factory = sqlite3.Row
try:
    dest_columns = [row[1] for row in dest.execute('PRAGMA table_info(threads)')]
    source_columns = {row[1] for row in source.execute('PRAGMA table_info(threads)')}
    columns = [name for name in dest_columns if name in source_columns]
    if 'id' not in columns:
        raise RuntimeError('Codex threads schema no longer contains a shared id column')
    original_ids = {row[0] for row in dest.execute('SELECT id FROM threads')}
    original_providers = dict(dest.execute('SELECT id, model_provider FROM threads')) if 'model_provider' in columns else {}
    source_ids = {row[0] for row in source.execute('SELECT id FROM threads')}
    with dest:
        for thread_id in ids:
            if thread_id in original_ids and thread_id not in source_ids:
                dest.execute('DELETE FROM threads WHERE id = ?', (thread_id,))
        for row in source.execute('SELECT * FROM threads'):
            thread_id = row['id']
            if thread_id not in ids and thread_id in original_ids:
                continue
            values = [row[name] for name in columns]
            if thread_id in original_providers and 'model_provider' in columns:
                values[columns.index('model_provider')] = original_providers[thread_id]
            if thread_id in original_ids:
                update_columns = [name for name in columns if name != 'id']
                update_values = [values[columns.index(name)] for name in update_columns]
                assignments = ','.join(f'{name} = ?' for name in update_columns)
                if assignments:
                    dest.execute(f"UPDATE threads SET {assignments} WHERE id = ?", [*update_values, thread_id])
            else:
                placeholders = ','.join('?' for _ in columns)
                dest.execute(f"INSERT OR REPLACE INTO threads ({','.join(columns)}) VALUES ({placeholders})", values)
finally:
    source.close(); dest.close()
`;

const RESTORE_CATALOG_SCRIPT = String.raw`
import json, os, shutil, sqlite3, sys
db_path, backup_path, live_path, ids_json = sys.argv[1:5]
ids = set(json.loads(ids_json))
if not os.path.exists(backup_path):
    raise SystemExit(0)
live = sqlite3.connect(db_path, timeout=10)
snapshot = sqlite3.connect(live_path)
try:
    live.backup(snapshot)
finally:
    snapshot.close(); live.close()
for suffix in ('-wal', '-shm'):
    try: os.remove(db_path + suffix)
    except FileNotFoundError: pass
shutil.copy2(backup_path, db_path)
dest = sqlite3.connect(db_path, timeout=10)
source = sqlite3.connect(f'file:{live_path}?mode=ro', uri=True)
dest.row_factory = sqlite3.Row; source.row_factory = sqlite3.Row
try:
    dest_columns = [row[1] for row in dest.execute('PRAGMA table_info(local_thread_catalog)')]
    source_columns = {row[1] for row in source.execute('PRAGMA table_info(local_thread_catalog)')}
    columns = [name for name in dest_columns if name in source_columns]
    if 'thread_id' not in columns or 'host_id' not in columns:
        raise RuntimeError('Codex catalog schema no longer contains host_id and thread_id')
    original_ids = {row[0] for row in dest.execute("SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local'")}
    source_ids = {row[0] for row in source.execute("SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local'")}
    original_providers = dict(dest.execute("SELECT thread_id, model_provider FROM local_thread_catalog WHERE host_id = 'local'")) if 'model_provider' in columns else {}

    def table_exists(connection, table):
        return connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone() is not None

    def shared_columns(table):
        dest_names = [row[1] for row in dest.execute(f'PRAGMA table_info("{table}")')]
        source_names = {row[1] for row in source.execute(f'PRAGMA table_info("{table}")')}
        return [name for name in dest_names if name in source_names]

    def insert_live_rows(table):
        if not table_exists(dest, table) or not table_exists(source, table):
            return
        names = shared_columns(table)
        if not names:
            return
        quoted = ','.join(f'"{name}"' for name in names)
        placeholders = ','.join('?' for _ in names)
        for row in source.execute(f'SELECT {quoted} FROM "{table}"'):
            dest.execute(f'INSERT INTO "{table}" ({quoted}) VALUES ({placeholders})', tuple(row[name] for name in names))

    with dest:
        # Automations are device-wide state. The live database contains the latest
        # last_run_at/next_run_at values and run records written while Codex was
        # open. Preserve them exactly so switching accounts cannot make the same
        # scheduled occurrence appear due again.
        for table in ('automation_runs', 'automations'):
            if table_exists(dest, table) and table_exists(source, table):
                dest.execute(f'DELETE FROM "{table}"')
        for table in ('automations', 'automation_runs'):
            insert_live_rows(table)

        # Archiving or deleting a selected task removes it from the live catalog.
        # Propagate that removal instead of resurrecting the backup row.
        for thread_id in ids:
            if thread_id in original_ids and thread_id not in source_ids:
                dest.execute("DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?", (thread_id,))
        for row in source.execute("SELECT * FROM local_thread_catalog WHERE host_id = 'local'"):
            thread_id = row['thread_id']
            if thread_id not in ids and thread_id in original_ids:
                continue
            values = [row[name] for name in columns]
            if thread_id in original_providers and 'model_provider' in columns:
                values[columns.index('model_provider')] = original_providers[thread_id]
            if thread_id in original_ids:
                update_columns = [name for name in columns if name not in ('host_id', 'thread_id')]
                update_values = [values[columns.index(name)] for name in update_columns]
                assignments = ','.join(f'{name} = ?' for name in update_columns)
                if assignments:
                    dest.execute(f"UPDATE local_thread_catalog SET {assignments} WHERE host_id = 'local' AND thread_id = ?", [*update_values, thread_id])
            else:
                placeholders = ','.join('?' for _ in columns)
                dest.execute(f"INSERT OR REPLACE INTO local_thread_catalog ({','.join(columns)}) VALUES ({placeholders})", values)
        try:
            dest.execute("UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1")
        except sqlite3.OperationalError:
            pass
finally:
    source.close(); dest.close()
`;

function prepareLaunchView(codexHome, backupDir, selection, { manageConfig = false, modelProvider = '' } = {}) {
  fs.mkdirSync(backupDir, { recursive: true });
  const record = { backupDir, language: selection.language, threadIds: selection.threadIds, projectIds: selection.projectIds };
  try {
    const globalFile = path.join(codexHome, GLOBAL_STATE_FILE);
    const globalBackup = path.join(backupDir, 'global-state.json');
    if (fs.existsSync(globalFile)) {
      fs.copyFileSync(globalFile, globalBackup);
      record.globalBackup = globalBackup;
      record.globalFile = globalFile;
      writeJsonAtomic(globalFile, filterGlobalState(readGlobalState(codexHome), selection));
    }
    const catalogFile = path.join(codexHome, 'sqlite', 'codex-dev.db');
    const catalogBackup = path.join(backupDir, 'codex-dev.db');
    if (fs.existsSync(catalogFile)) {
      fs.rmSync(catalogBackup, { force: true });
      const result = runPython(FILTER_CATALOG_SCRIPT, [catalogFile, catalogBackup, JSON.stringify(selection.threadIds), modelProvider]);
      if (fs.existsSync(catalogBackup)) {
        record.catalogBackup = catalogBackup;
        record.catalogFile = catalogFile;
      }
      if (result.status !== 0) throw new Error(String(result.stderr || 'Failed to filter Codex thread catalog').trim());
    }
    const stateFile = path.join(codexHome, 'state_5.sqlite');
    const stateBackup = path.join(backupDir, 'state_5.sqlite');
    if (fs.existsSync(stateFile)) {
      fs.rmSync(stateBackup, { force: true });
      const result = runPython(FILTER_STATE_SCRIPT, [stateFile, stateBackup, JSON.stringify(selection.threadIds), modelProvider]);
      if (fs.existsSync(stateBackup)) {
        record.stateBackup = stateBackup;
        record.stateFile = stateFile;
      }
      if (result.status !== 0) throw new Error(String(result.stderr || 'Failed to filter Codex state database').trim());
    }
    if (manageConfig) {
      const configFile = path.join(codexHome, 'config.toml');
      const configBackup = path.join(backupDir, 'config.toml');
      record.hadConfig = fs.existsSync(configFile);
      if (record.hadConfig) fs.copyFileSync(configFile, configBackup);
      record.configBackup = configBackup;
      record.configFile = configFile;
      const source = record.hadConfig ? fs.readFileSync(configFile, 'utf8') : '';
      const configured = modelProvider === 'openai' ? require('./codex-launch-auth').chatgptConfig(source) : source;
      fs.writeFileSync(configFile, withDesktopLocale(configured, selection.language), { mode: 0o600 });
    }
    return record;
  } catch (error) {
    try { restoreLaunchView(record); } catch {}
    throw error;
  }
}

function restoreLaunchView(record) {
  if (!record) return;
  const errors = [];
  try {
    if (record.globalBackup && record.globalFile && fs.existsSync(record.globalBackup)) {
      const original = JSON.parse(fs.readFileSync(record.globalBackup, 'utf8'));
      const live = fs.existsSync(record.globalFile) ? JSON.parse(fs.readFileSync(record.globalFile, 'utf8')) : null;
      // A missing file after an interrupted launch is not a user deleting every
      // loaded project/task. The durable snapshot is the only recovery source.
      writeJsonAtomic(record.globalFile, live === null ? original
        : mergeLaunchGlobalState(original, live, record.threadIds, record.projectIds));
    }
  } catch (error) { errors.push(`global state: ${error.message}`); }
  try {
    if (record.stateBackup && record.stateFile && fs.existsSync(record.stateBackup)) {
      const livePath = path.join(record.backupDir, 'state_5.live.sqlite');
      fs.rmSync(livePath, { force: true });
      const result = runPythonWithLockRetry(RESTORE_STATE_SCRIPT, [record.stateFile, record.stateBackup, livePath, JSON.stringify(record.threadIds || [])]);
      if (result.status !== 0) throw new Error(String(result.stderr || 'Failed to restore Codex state database').trim());
    }
  } catch (error) { errors.push(`thread state: ${error.message}`); }
  try {
    if (record.catalogBackup && record.catalogFile && fs.existsSync(record.catalogBackup)) {
      const livePath = path.join(record.backupDir, 'codex-dev.live.db');
      fs.rmSync(livePath, { force: true });
      const result = runPythonWithLockRetry(RESTORE_CATALOG_SCRIPT, [record.catalogFile, record.catalogBackup, livePath, JSON.stringify(record.threadIds || [])]);
      if (result.status !== 0) throw new Error(String(result.stderr || 'Failed to restore Codex thread catalog').trim());
    }
  } catch (error) { errors.push(`thread catalog: ${error.message}`); }
  try {
    if (record.configFile) {
      if (record.hadConfig && fs.existsSync(record.configBackup)) fs.copyFileSync(record.configBackup, record.configFile);
      else fs.rmSync(record.configFile, { force: true });
    }
  } catch (error) { errors.push(`config: ${error.message}`); }
  if (!errors.length) fs.rmSync(record.backupDir, { recursive: true, force: true });
  else throw new Error(`Codex launch view restore failed (${errors.join('; ')})`);
}

// Replace only visible slots. Hidden projects/tasks keep their relative position,
// while new visible entries are appended after the available slots are filled.
function mergeLaunchOrder(original, live, editable) {
  const next = [...new Set(live)].filter(editable);
  const output = [];
  let index = 0;
  for (const id of new Set(original)) {
    if (!editable(id)) output.push(id);
    else if (index < next.length) output.push(next[index++]);
  }
  return output.concat(next.slice(index));
}

function launchStateThreadIds(state) {
  const ids = new Set(Object.keys(state?.['thread-project-assignments'] || {}));
  for (const id of state?.['projectless-thread-ids'] || []) ids.add(id);
  for (const order of Object.values(state?.['sidebar-project-thread-orders'] || {})) {
    for (const id of order?.threadIds || []) ids.add(id);
  }
  for (const key of Object.keys(state?.['electron-persisted-atom-state'] || {})) {
    const match = key.match(/^(?:thread-workspace-state-v1|heartbeat-thread-permissions-by-id)[:.]([^:.]+)$/i);
    if (match) ids.add(match[1]);
  }
  return ids;
}

function mergeLaunchGlobalState(original, live, selectedIds = [], selectedProjectIds = []) {
  const output = structuredClone(original || {});
  const selected = new Set(selectedIds);
  const selectedProjects = new Set(selectedProjectIds.filter((id) => id !== '__unassigned__'));
  const originalProjects = original?.['local-projects'] || {};
  const liveProjects = live?.['local-projects'] || {};
  const liveProjectOrder = Array.isArray(live?.['project-order']) ? live['project-order'] : Object.keys(liveProjects);
  const liveVisibleProjects = new Set(liveProjectOrder);
  const editableProject = (id) => selectedProjects.has(id) || !Object.hasOwn(originalProjects, id);
  const knownThreads = launchStateThreadIds(original);
  const editableThread = (id) => selected.has(id) || !knownThreads.has(id);
  const removedProjects = new Set();

  output['local-projects'] = { ...(output['local-projects'] || {}) };
  for (const projectId of selectedProjects) {
    if (!liveVisibleProjects.has(projectId) || !liveProjects[projectId]) {
      delete output['local-projects'][projectId];
      if (Object.hasOwn(originalProjects, projectId)) removedProjects.add(projectId);
    } else {
      // The launch view contains the selected project's live object. Preserve
      // edits made in Codex (especially project renames) instead of restoring
      // the stale object captured before the account switch.
      output['local-projects'][projectId] = structuredClone(liveProjects[projectId]);
    }
  }
  for (const projectId of liveProjectOrder) {
    if (liveProjects[projectId] && !Object.hasOwn(originalProjects, projectId)) {
      output['local-projects'][projectId] = structuredClone(liveProjects[projectId]);
    }
  }
  const validProject = (id) => Object.hasOwn(output['local-projects'], id);
  const liveEditableProject = (id) => editableProject(id) && validProject(id) && liveVisibleProjects.has(id);
  const originalOrder = Array.isArray(original?.['project-order']) ? original['project-order'] : Object.keys(originalProjects);
  output['project-order'] = mergeLaunchOrder(originalOrder, liveProjectOrder, editableProject).filter(validProject);
  output['pinned-project-ids'] = mergeLaunchOrder(
    output['pinned-project-ids'] || [], live?.['pinned-project-ids'] || [], editableProject,
  ).filter(validProject);

  output['thread-project-assignments'] = { ...(output['thread-project-assignments'] || {}) };
  const liveAssignments = live?.['thread-project-assignments'] || {};
  const liveProjectless = new Set(live?.['projectless-thread-ids'] || []);
  // Explicit sidebar assignments (or an explicit projectless entry) win within
  // the loaded scope. Workspace atoms/cwd are derived state, not move events.
  // A hidden original assignment was filtered out at launch; its absence is not
  // a deletion, and auto-discovered hidden projects cannot become move targets.
  // These snapshots contain no move-origin marker: a direct assignment rewrite
  // between loaded projects is authoritative, regardless of its writer.
  for (const id of new Set([...selected, ...Object.keys(liveAssignments), ...liveProjectless])) {
    if (!editableThread(id)) continue;
    const value = liveAssignments[id];
    const originalValue = original?.['thread-project-assignments']?.[id];
    if (liveProjectless.has(id)) delete output['thread-project-assignments'][id];
    else if (value && liveEditableProject(value.projectId)
      && (!originalValue || selectedProjects.has(originalValue.projectId))) {
      output['thread-project-assignments'][id] = structuredClone(value);
    } else if (!value && selectedProjects.has(originalValue?.projectId)) {
      delete output['thread-project-assignments'][id];
    }
  }
  for (const [id, value] of Object.entries(output['thread-project-assignments'])) {
    if (removedProjects.has(value?.projectId)) delete output['thread-project-assignments'][id];
  }
  output['projectless-thread-ids'] = mergeLaunchOrder(
    output['projectless-thread-ids'] || [], [...liveProjectless], editableThread,
  ).filter((id) => !editableThread(id) || !output['thread-project-assignments'][id]);

  output['sidebar-project-thread-orders'] = { ...(output['sidebar-project-thread-orders'] || {}) };
  const projectless = new Set(output['projectless-thread-ids']);
  const liveOrders = live?.['sidebar-project-thread-orders'] || {};
  for (const projectId of new Set([...Object.keys(output['sidebar-project-thread-orders']), ...Object.keys(liveOrders)])) {
    if (removedProjects.has(projectId)) {
      delete output['sidebar-project-thread-orders'][projectId];
      continue;
    }
    if (!liveEditableProject(projectId)) continue;
    const previous = output['sidebar-project-thread-orders'][projectId];
    const next = liveOrders[projectId];
    const threadIds = mergeLaunchOrder(previous?.threadIds || [], next?.threadIds || [], editableThread)
      .filter((id) => !editableThread(id) || (!projectless.has(id)
        && (!output['thread-project-assignments'][id]
          || output['thread-project-assignments'][id].projectId === projectId)));
    // Removing/resetting the visible order must not erase hidden task entries.
    if (next || threadIds.length) {
      output['sidebar-project-thread-orders'][projectId] = { ...structuredClone(next || previous || {}), threadIds };
    } else delete output['sidebar-project-thread-orders'][projectId];
  }

  output['electron-persisted-atom-state'] = { ...(output['electron-persisted-atom-state'] || {}) };
  for (const key of Object.keys(output['electron-persisted-atom-state'])) {
    const threadMatch = key.match(/^(?:thread-workspace-state-v1|heartbeat-thread-permissions-by-id)[:.]([^:.]+)$/i);
    const projectMatch = key.match(/^sidebar-project-expanded-v1-codex:(.+)$/);
    if ((threadMatch && selected.has(threadMatch[1])) || (projectMatch && selectedProjects.has(projectMatch[1]))) {
      delete output['electron-persisted-atom-state'][key];
    }
  }
  for (const [key, value] of Object.entries(live?.['electron-persisted-atom-state'] || {})) {
    const threadMatch = key.match(/^(?:thread-workspace-state-v1|heartbeat-thread-permissions-by-id)[:.]([^:.]+)$/i);
    const projectMatch = key.match(/^sidebar-project-expanded-v1-codex:(.+)$/);
    if (threadMatch && !editableThread(threadMatch[1])) continue;
    if (projectMatch && !liveEditableProject(projectMatch[1])) continue;
    output['electron-persisted-atom-state'][key] = structuredClone(value);
  }
  for (const [key, value] of Object.entries(output['electron-persisted-atom-state'])) {
    const threadMatch = key.match(/^thread-workspace-state-v1[:.]([^:.]+)$/i);
    if (!threadMatch || !value || typeof value !== 'object') continue;
    const id = threadMatch[1];
    const assignment = output['thread-project-assignments'][id];
    if (editableThread(id) && assignment && value.project?.projectId !== assignment.projectId) {
      const originalProject = original?.['electron-persisted-atom-state']?.[key]?.project;
      value.project = structuredClone(originalProject?.projectId === assignment.projectId
        ? originalProject : { projectKind: 'local', ...assignment });
    } else if ((editableThread(id) && (projectless.has(id)
      || (!assignment && original?.['thread-project-assignments']?.[id]))) || removedProjects.has(value.project?.projectId)) {
      value.project = null;
    }
  }
  if (Object.prototype.hasOwnProperty.call(live || {}, 'selected-project')) output['selected-project'] = structuredClone(live['selected-project']);
  if (removedProjects.has(output['selected-project']?.projectId)) output['selected-project'] = null;
  return output;
}

function isRolloutTurnStart(item) {
  const type = String(item?.payload?.type || '').toLowerCase();
  return item?.type === 'event_msg' && (type === 'task_started' || type === 'turn_started');
}

function isRolloutRollback(item) {
  return item?.type === 'event_msg' && /(?:roll(?:ed)?_?back|rollback)/i.test(String(item?.payload?.type || ''));
}

function isValidReplacementCheckpoint(item) {
  return item?.type === 'compacted'
    && Array.isArray(item?.payload?.replacement_history)
    && item.payload.replacement_history.length > 0;
}

async function hashFile(file) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function inspectRollout(file) {
  let lineNumber = 0;
  let lastTurnStartLine = 0;
  let invalidLines = 0;
  let compactedCount = 0;
  let lastRollbackLine = 0;
  let latestCheckpoint = null;
  let unknownRecordTypes = 0;
  const sessionMetaLines = new Set();
  const stream = fs.createReadStream(file);
  const digest = crypto.createHash('sha256');
  stream.on('data', (chunk) => digest.update(chunk));
  const input = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of input) {
    lineNumber += 1;
    let item;
    try { item = JSON.parse(line); }
    catch {
      invalidLines += 1;
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.type !== 'string') {
      invalidLines += 1;
      continue;
    }
    if (!['session_meta', 'event_msg', 'response_item', 'turn_context', 'compacted'].includes(item.type)) unknownRecordTypes += 1;
    if (item.type === 'session_meta') sessionMetaLines.add(lineNumber);
    if (isRolloutTurnStart(item)) lastTurnStartLine = lineNumber;
    if (isRolloutRollback(item)) lastRollbackLine = lineNumber;
    if (item.type === 'compacted') compactedCount += 1;
    if (isValidReplacementCheckpoint(item)) {
      latestCheckpoint = {
        lineNumber,
        segmentStartLine: lastTurnStartLine || lineNumber,
        serialized: line,
      };
    }
  }
  return {
    lineCount: lineNumber,
    invalidLines,
    compactedCount,
    lastRollbackLine,
    latestCheckpoint,
    sessionMetaLines,
    unknownRecordTypes,
    sha256: digest.digest('hex'),
  };
}

async function optimizeRolloutFile(file, backupRoot, options = {}) {
  const minimumBytes = Number(options.minimumBytes) || 500 * 1024 * 1024;
  const minimumSavingsRatio = Number.isFinite(options.minimumSavingsRatio) ? options.minimumSavingsRatio : 0.35;
  const guard = beginRolloutMaintenance(file, options);
  const temporary = `${file}.navo-optimize-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  let output;
  let outputFinished;
  try {
    const originalBytes = fs.statSync(file).size;
    if (originalBytes < minimumBytes) return null;
    await guard.checkpoint('inspect');
    const inspection = await inspectRollout(file);
    guard.assertCurrent();
    const checkpoint = inspection.latestCheckpoint;
    if (!checkpoint || checkpoint.segmentStartLine === checkpoint.lineNumber
      || !inspection.sessionMetaLines.size || inspection.invalidLines || inspection.compactedCount < 1
      || inspection.unknownRecordTypes) return null;
    // A rollback newer than the checkpoint can make an older checkpoint live again.
    // Unknown formats are also left untouched instead of guessing their semantics.
    if (inspection.lastRollbackLine > checkpoint.lineNumber) return null;

    const storage = checkRolloutSpace([{ path: file, bytes: originalBytes }, { path: backupRoot, bytes: originalBytes }], options);
    await guard.checkpoint('write');
    output = fs.createWriteStream(temporary, { mode: 0o600, flags: 'wx' });
    outputFinished = finished(output);
    outputFinished.catch(() => {});
    const expectedDigest = crypto.createHash('sha256');
    let lineNumber = 0;
    let keptLines = 0;
    const input = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of input) {
      lineNumber += 1;
      const keep = inspection.sessionMetaLines.has(lineNumber) || lineNumber >= checkpoint.segmentStartLine;
      if (!keep) continue;
      const chunk = `${line}\n`;
      expectedDigest.update(chunk);
      keptLines += 1;
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end();
    await outputFinished;
    guard.assertCurrent();

    const afterBytes = fs.statSync(temporary).size;
    const savingsRatio = 1 - (afterBytes / originalBytes);
    if (savingsRatio < minimumSavingsRatio) {
      fs.rmSync(temporary, { force: true });
      return null;
    }
    await guard.checkpoint('verify');
    const verification = await inspectRollout(temporary);
    const temporaryFingerprint = fileFingerprint(temporary);
    if (verification.sha256 !== expectedDigest.digest('hex')) throw new Error('Optimized rollout checksum mismatch');
    if (verification.invalidLines
      || verification.latestCheckpoint?.serialized !== checkpoint.serialized
      || verification.lineCount !== keptLines) {
      throw new Error('Optimized rollout failed structural recovery validation');
    }

    await guard.checkpoint('backup');
    fs.mkdirSync(backupRoot, { recursive: true });
    const backup = path.join(backupRoot, `${path.basename(file)}.${Date.now()}-${crypto.randomBytes(6).toString('hex')}.bak`);
    // A hard link can keep changing while another writer holds the original.
    // Use an independent copy and verify it against the inspected source bytes.
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    guard.assertCurrent();
    if (await hashFile(backup) !== inspection.sha256) throw new Error('Rollout backup checksum mismatch');
    guard.assertCurrent();
    const manifest = {
      version: 2,
      source: path.resolve(file),
      createdAt: new Date().toISOString(),
      beforeBytes: originalBytes,
      afterBytes,
      backupBytes: fs.statSync(backup).size,
      sourceSha256: inspection.sha256,
      optimizedSha256: verification.sha256,
      checkpointLine: checkpoint.lineNumber,
      segmentStartLine: checkpoint.segmentStartLine,
      ...storage,
      ...guard.metadata(),
    };
    fs.writeFileSync(`${backup}.json`, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await guard.checkpoint('commit');
    if (await hashFile(file) !== inspection.sha256) throw Object.assign(new Error('会话内容已变化，已保留备份并停止优化'), { code: 'ROLLOUT_CHANGED' });
    writeJsonAtomic(`${backup}.json`, { ...manifest, ...guard.metadata() });
    guard.assertCurrent();
    assertUnchanged(temporary, temporaryFingerprint);
    // A failed rename leaves the original intact. Never copy a stale backup over
    // it: it may have changed or been reopened since the attempted replacement.
    fs.renameSync(temporary, file);
    return {
      file,
      backup,
      beforeBytes: originalBytes,
      afterBytes,
      removedRecords: inspection.lineCount - keptLines,
      removedCompactions: inspection.compactedCount - verification.compactedCount,
      backupBytes: manifest.backupBytes,
      ...rolloutBackupStorage(backupRoot),
      ...storage,
      ...guard.metadata(),
      checksumAvailable: true,
    };
  } catch (error) {
    try { output?.destroy(); } catch {}
    await outputFinished?.catch(() => {});
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    guard.release();
  }
}

async function optimizeSelectedRollouts(codexHome, threadIds, backupRoot, options = {}) {
  const catalog = listCodexLaunchOptions(codexHome);
  const wanted = new Set(threadIds);
  const results = [];
  for (const thread of catalog.projects.flatMap((project) => project.threads)) {
    if (!wanted.has(thread.id) || !thread.oversized) continue;
    const rowResult = runPython(String.raw`
import sqlite3, sys
db=sqlite3.connect(f'file:{sys.argv[1]}?mode=ro', uri=True)
row=db.execute('SELECT rollout_path FROM threads WHERE id=?', (sys.argv[2],)).fetchone()
print(row[0] if row and row[0] else '')
db.close()
`, [path.join(codexHome, 'state_5.sqlite'), thread.id]);
    const rollout = String(rowResult.stdout || '').trim();
    if (!rollout || !fs.existsSync(rollout)) continue;
    const optimized = await optimizeRolloutFile(rollout, backupRoot, options);
    if (optimized) results.push({ ...optimized, threadId: thread.id });
  }
  return results;
}

function listRolloutBackups(backupRoot) {
  if (!fs.existsSync(backupRoot)) return [];
  const storage = rolloutBackupStorage(backupRoot);
  return fs.readdirSync(backupRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.bak.json'))
    .map((entry) => {
      const manifestFile = path.join(backupRoot, entry.name);
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        const backupName = entry.name.slice(0, -'.json'.length);
        const backupFile = path.join(backupRoot, backupName);
        if (!fs.existsSync(backupFile) || !manifest.source) return null;
        return {
          id: backupName,
          conversationFile: path.basename(String(manifest.source)),
          createdAt: manifest.createdAt || fs.statSync(backupFile).mtime.toISOString(),
          beforeBytes: Number(manifest.beforeBytes) || fs.statSync(backupFile).size,
          afterBytes: Number(manifest.afterBytes) || 0,
          kind: manifest.kind || 'optimization',
          backupBytes: fs.statSync(backupFile).size,
          ...storage,
          durationMs: Number(manifest.durationMs) || 0,
          timingsMs: manifest.timingsMs || {},
          requiredFreeBytes: Number(manifest.requiredFreeBytes) || 0,
          freeBytesBefore: Number.isFinite(manifest.freeBytesBefore) ? manifest.freeBytesBefore : null,
          checksumAvailable: /^[a-f0-9]{64}$/.test(String(manifest.sourceSha256 || '')),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function restoreRolloutBackup(codexHome, backupRoot, backupId, options = {}) {
  const safeId = path.basename(String(backupId || ''));
  if (!safeId || safeId !== String(backupId || '') || !safeId.endsWith('.bak')) throw new Error('Invalid rollout backup');
  const backup = path.join(backupRoot, safeId);
  const manifestFile = `${backup}.json`;
  if (!fs.existsSync(backup) || !fs.existsSync(manifestFile)) throw new Error('Rollout backup not found');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const source = path.resolve(String(manifest.source || ''));
  const sessionsRoot = `${path.resolve(codexHome, 'sessions')}${path.sep}`.toLowerCase();
  if (!source.toLowerCase().startsWith(sessionsRoot)) throw new Error('Rollout backup source is outside Codex sessions');
  const guard = beginRolloutMaintenance(source, options);
  const backupFingerprint = fileFingerprint(backup);
  const temporary = `${source}.navo-restore-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await guard.checkpoint('copy');
    const beforeBytes = fs.existsSync(source) ? fs.statSync(source).size : 0;
    const backupBytes = fs.statSync(backup).size;
    const storage = checkRolloutSpace([{ path: source, bytes: backupBytes }, { path: backupRoot, bytes: beforeBytes }], options);
    fs.copyFileSync(backup, temporary, fs.constants.COPYFILE_EXCL);
    assertUnchanged(backup, backupFingerprint);
    await guard.checkpoint('verify');
    const verification = await inspectRollout(temporary);
    const temporaryFingerprint = fileFingerprint(temporary);
    if (verification.invalidLines || !verification.lineCount || !verification.sessionMetaLines.size) {
      throw new Error('Rollout backup failed structural validation');
    }
    if (manifest.sourceSha256 && verification.sha256 !== manifest.sourceSha256) throw new Error('Rollout backup checksum mismatch');
    assertUnchanged(backup, backupFingerprint);
    await guard.checkpoint('backup');
    let safety = null;
    let currentSha256 = null;
    if (fs.existsSync(source)) {
      currentSha256 = await hashFile(source);
      guard.assertCurrent();
      safety = path.join(backupRoot, `${path.basename(source)}.pre-restore-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.bak`);
      fs.copyFileSync(source, safety, fs.constants.COPYFILE_EXCL);
      guard.assertCurrent();
      if (await hashFile(safety) !== currentSha256) throw new Error('Pre-restore safety backup checksum mismatch');
      guard.assertCurrent();
      fs.writeFileSync(`${safety}.json`, `${JSON.stringify({
        version: 2,
        source,
        createdAt: new Date().toISOString(),
        beforeBytes: fs.statSync(source).size,
        afterBytes: fs.statSync(source).size,
        kind: 'pre-restore',
        sourceSha256: currentSha256,
        backupBytes: fs.statSync(safety).size,
        ...storage,
        ...guard.metadata(),
      }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    }
    await guard.checkpoint('commit');
    if (currentSha256 && await hashFile(source) !== currentSha256) throw Object.assign(new Error('会话内容已变化，已停止恢复'), { code: 'ROLLOUT_CHANGED' });
    guard.assertCurrent();
    assertUnchanged(backup, backupFingerprint);
    assertUnchanged(temporary, temporaryFingerprint);
    fs.renameSync(temporary, source);
    return {
      restored: source, bytes: fs.statSync(source).size, safetyBackup: safety,
      backupBytes, ...rolloutBackupStorage(backupRoot), ...storage, ...guard.metadata(),
      checksumAvailable: Boolean(manifest.sourceSha256),
    };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  } finally {
    guard.release();
  }
}

module.exports = {
  filterGlobalState,
  listRolloutBackups,
  mergeLaunchGlobalState,
  listCodexLaunchOptions,
  normalizeLaunchSelection,
  optimizeRolloutFile,
  optimizeSelectedRollouts,
  prepareLaunchView,
  pruneMissingLocalProjects,
  restoreLaunchView,
  restoreRolloutBackup,
  rolloutBackupStorage,
  setTomlSectionValue,
  syncSessionIndexNames,
  withDesktopLocale,
};

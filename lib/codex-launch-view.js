const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
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

function listCodexLaunchOptions(codexHome, preferredLanguage = 'zh-CN') {
  const result = runPython(THREAD_LIST_SCRIPT, [codexHome]);
  if (result.status !== 0) throw new Error(String(result.stderr || 'Failed to read Codex conversations').trim());
  const rows = JSON.parse(String(result.stdout || '[]').trim() || '[]');
  const state = readGlobalState(codexHome);
  const indexNames = readSessionIndexNames(codexHome);
  const projects = state['local-projects'] && typeof state['local-projects'] === 'object'
    ? state['local-projects'] : {};
  const assignments = state['thread-project-assignments'] && typeof state['thread-project-assignments'] === 'object'
    ? state['thread-project-assignments'] : {};
  const byRoot = new Map();
  for (const [projectId, project] of Object.entries(projects)) {
    for (const root of Array.isArray(project?.rootPaths) ? project.rootPaths : []) byRoot.set(normalizeFsPath(root), projectId);
  }
  const groups = new Map();
  for (const [projectId, project] of Object.entries(projects)) {
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
    const projectId = groups.has(assigned) ? assigned : byRoot.get(normalizeFsPath(row.cwd));
    const target = groups.get(projectId) || unassigned;
    target.threads.push({
      id: row.id,
      title: indexNames.get(row.id) || row.display_title || row.id,
      cwd: row.cwd || '',
      provider: row.model_provider || 'openai',
      updatedAt: Number(row.recency_ms) || 0,
      sizeBytes: Number(row.size_bytes) || 0,
      oversized: Number(row.size_bytes) >= 100 * 1024 * 1024,
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
    optimizeOversized: value?.optimizeOversized !== false,
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
  output['project-order'] = (output['project-order'] || []).filter((id) => projectIds.has(id));
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
            src.execute(f"UPDATE threads SET archived = 1 WHERE id NOT IN ({placeholders})", ids)
            src.execute(f"UPDATE threads SET archived = 0 WHERE id IN ({placeholders})", ids)
            if provider:
                src.execute(f"UPDATE threads SET model_provider = ? WHERE id IN ({placeholders})", [provider, *ids])
        else:
            src.execute('UPDATE threads SET archived = 1')
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
    with dest:
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
      fs.writeFileSync(configFile, withDesktopLocale(source, selection.language), { mode: 0o600 });
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
      const live = fs.existsSync(record.globalFile) ? JSON.parse(fs.readFileSync(record.globalFile, 'utf8')) : {};
      writeJsonAtomic(record.globalFile, mergeLaunchGlobalState(original, live, record.threadIds));
    }
  } catch (error) { errors.push(`global state: ${error.message}`); }
  try {
    if (record.stateBackup && record.stateFile && fs.existsSync(record.stateBackup)) {
      const livePath = path.join(record.backupDir, 'state_5.live.sqlite');
      fs.rmSync(livePath, { force: true });
      const result = runPython(RESTORE_STATE_SCRIPT, [record.stateFile, record.stateBackup, livePath, JSON.stringify(record.threadIds || [])]);
      if (result.status !== 0) throw new Error(String(result.stderr || 'Failed to restore Codex state database').trim());
    }
  } catch (error) { errors.push(`thread state: ${error.message}`); }
  try {
    if (record.catalogBackup && record.catalogFile && fs.existsSync(record.catalogBackup)) {
      fs.rmSync(`${record.catalogFile}-wal`, { force: true });
      fs.rmSync(`${record.catalogFile}-shm`, { force: true });
      fs.copyFileSync(record.catalogBackup, record.catalogFile);
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

function mergeLaunchGlobalState(original, live, selectedIds = []) {
  const output = structuredClone(original || {});
  const selected = new Set(selectedIds);
  const mergeObject = (key, predicate = () => true) => {
    output[key] = { ...(output[key] || {}) };
    for (const [id, value] of Object.entries(live?.[key] || {})) if (predicate(id, value)) output[key][id] = value;
  };
  mergeObject('local-projects');
  output['project-order'] = [...new Set([...(output['project-order'] || []), ...(live?.['project-order'] || [])])];
  output['pinned-project-ids'] = [...new Set([...(output['pinned-project-ids'] || []), ...(live?.['pinned-project-ids'] || [])])];
  mergeObject('thread-project-assignments', (id) => selected.has(id) || !(original?.['thread-project-assignments'] || {})[id]);
  output['projectless-thread-ids'] = [...new Set([...(output['projectless-thread-ids'] || []), ...(live?.['projectless-thread-ids'] || []).filter((id) => selected.has(id))])];
  mergeObject('sidebar-project-thread-orders');
  mergeObject('electron-persisted-atom-state', (key) => {
    const match = key.match(/^(?:thread-workspace-state-v1|heartbeat-thread-permissions-by-id)[:.]([^:.]+)$/i);
    return !match || selected.has(match[1]);
  });
  return output;
}

async function optimizeRolloutFile(file, backupRoot) {
  let compactedCount = 0;
  let compactedBytes = 0;
  const firstPass = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of firstPass) {
    try {
      if (JSON.parse(line).type === 'compacted') {
        compactedCount += 1;
        compactedBytes += Buffer.byteLength(line) + 1;
      }
    } catch {}
  }
  const originalBytes = fs.statSync(file).size;
  if (compactedCount < 2 || originalBytes < 100 * 1024 * 1024 || compactedBytes / originalBytes < 0.5) return null;
  fs.mkdirSync(backupRoot, { recursive: true });
  const backup = path.join(backupRoot, `${path.basename(file)}.${Date.now()}.bak`);
  try { fs.linkSync(file, backup); } catch { fs.copyFileSync(file, backup); }
  const temporary = `${file}.navo-optimize-${process.pid}-${Date.now()}.tmp`;
  const output = fs.createWriteStream(temporary, { mode: 0o600 });
  let remaining = compactedCount;
  const secondPass = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of secondPass) {
    let compacted = false;
    try { compacted = JSON.parse(line).type === 'compacted'; } catch {}
    if (compacted) remaining -= 1;
    if (!compacted || remaining === 0) {
      if (!output.write(`${line}\n`)) await new Promise((resolve) => output.once('drain', resolve));
    }
  }
  await new Promise((resolve, reject) => output.end((error) => error ? reject(error) : resolve()));
  fs.renameSync(temporary, file);
  return { file, backup, beforeBytes: originalBytes, afterBytes: fs.statSync(file).size, removedCompactions: compactedCount - 1 };
}

async function optimizeSelectedRollouts(codexHome, threadIds, backupRoot) {
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
    const optimized = await optimizeRolloutFile(rollout, backupRoot);
    if (optimized) results.push({ ...optimized, threadId: thread.id });
  }
  return results;
}

module.exports = {
  filterGlobalState,
  mergeLaunchGlobalState,
  listCodexLaunchOptions,
  normalizeLaunchSelection,
  optimizeRolloutFile,
  optimizeSelectedRollouts,
  prepareLaunchView,
  restoreLaunchView,
  setTomlSectionValue,
  withDesktopLocale,
};

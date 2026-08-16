'use strict';

const { EventEmitter } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const MAX_SESSIONS = 200;
const INITIAL_TAIL_BYTES = 1024 * 1024;
const DEFAULT_ACTIVE_WINDOW_MS = 15 * 60 * 1000;

function emptyUsage() {
  return { input: 0, cachedInput: 0, output: 0, reasoning: 0, total: 0 };
}

function normalizeUsage(raw = {}) {
  const usage = {
    input: Number(raw.input_tokens || 0),
    cachedInput: Number(raw.cached_input_tokens || 0),
    output: Number(raw.output_tokens || 0),
    reasoning: Number(raw.reasoning_output_tokens || 0),
    total: Number(raw.total_tokens || 0),
  };
  if (!usage.total) usage.total = usage.input + usage.output;
  return usage;
}

function subtractUsage(current = emptyUsage(), baseline = emptyUsage()) {
  const usage = {};
  for (const field of Object.keys(emptyUsage())) {
    usage[field] = Math.max(0, Number(current[field] || 0) - Number(baseline[field] || 0));
  }
  return usage;
}

function addTurnUsage(current = emptyUsage(), addition = emptyUsage()) {
  const usage = {};
  for (const field of Object.keys(emptyUsage())) {
    usage[field] = Math.max(0, Number(current[field] || 0) + Number(addition[field] || 0));
  }
  return usage;
}

function compactText(value, maximum = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function cleanFsPath(value) {
  const raw = String(value || '').replace(/^\\\\\?\\/, '');
  return raw ? path.normalize(raw) : '';
}

function normalizedFsPath(value) {
  return cleanFsPath(value).toLowerCase();
}

function timestamp(value, fallback = new Date().toISOString()) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && String(value).trim() !== ''
    ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function sessionIdFromFile(file) {
  return path.basename(file, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || '';
}

class SessionState {
  constructor(file) {
    this.file = file;
    this.lastFileActivityAt = 0;
    this.sessionUsageTotal = null;
    this.taskUsageBaseline = null;
    this.value = {
      id: path.basename(file, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || path.basename(file, '.jsonl'),
      threadName: '',
      project: '未知项目',
      cwd: '',
      originator: 'Codex',
      model: '',
      status: 'idle',
      statusLabel: '空闲',
      currentActivity: '等待新任务',
      startedAt: null,
      completedAt: null,
      durationMs: 0,
      turnId: null,
      usage: emptyUsage(),
      lastMessage: '',
      lastUpdatedAt: null,
      file,
    };
  }

  markFileActivity(value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) this.lastFileActivityAt = numeric;
  }

  setThreadName(name) {
    if (name) this.value.threadName = compactText(name, 120);
  }

  setMeta(payload = {}) {
    this.value.id = payload.id || payload.session_id || this.value.id;
    this.value.cwd = cleanFsPath(payload.cwd || this.value.cwd);
    this.value.project = this.value.cwd ? path.basename(this.value.cwd) : this.value.project;
    this.value.originator = payload.originator || payload.source || this.value.originator;
  }

  apply(record) {
    const payload = record?.payload || {};
    const at = timestamp(record?.timestamp);
    let terminal = null;

    if (record?.type === 'session_meta') this.setMeta(payload);
    if (record?.type === 'turn_context') {
      this.value.model = payload.model || this.value.model;
      if (payload.cwd) this.setMeta({ cwd: payload.cwd });
    }

    if (record?.type === 'event_msg') {
      switch (payload.type) {
        case 'task_started':
          this.value.status = 'running';
          this.value.statusLabel = '运行中';
          this.value.currentActivity = 'Codex 正在分析任务';
          this.value.startedAt = timestamp(payload.started_at, at);
          this.value.completedAt = null;
          this.value.durationMs = 0;
          this.value.turnId = payload.turn_id || null;
          this.value.usage = emptyUsage();
          this.taskUsageBaseline = this.sessionUsageTotal ? { ...this.sessionUsageTotal } : null;
          break;
        case 'user_message': {
          const title = compactText(payload.message, 120);
          if (title && !this.value.threadName) this.value.threadName = title;
          break;
        }
        case 'token_count': {
          const rawLast = payload.info?.last_token_usage || null;
          const rawTotal = payload.info?.total_token_usage || null;
          const last = rawLast ? normalizeUsage(rawLast) : null;
          const total = rawTotal ? normalizeUsage(rawTotal) : null;
          if (total) {
            if (!this.taskUsageBaseline) this.taskUsageBaseline = last ? subtractUsage(total, last) : { ...total };
            this.value.usage = subtractUsage(total, this.taskUsageBaseline);
            this.sessionUsageTotal = total;
          } else if (last) {
            this.value.usage = addTurnUsage(this.value.usage, last);
          }
          if (this.value.status === 'running') this.value.currentActivity = '模型正在生成内容';
          break;
        }
        case 'agent_reasoning':
          if (this.value.status === 'running') this.value.currentActivity = '模型正在推理';
          break;
        case 'agent_message':
          this.value.lastMessage = compactText(payload.message, 200);
          if (this.value.status === 'running') this.value.currentActivity = '正在整理结果';
          break;
        case 'task_complete':
          this.value.status = 'completed';
          this.value.statusLabel = '已完成';
          this.value.currentActivity = '任务处理完毕';
          this.value.completedAt = timestamp(payload.completed_at, at);
          this.value.durationMs = Number(payload.duration_ms || 0);
          this.value.turnId = payload.turn_id || this.value.turnId;
          this.value.lastMessage = compactText(payload.last_agent_message || this.value.lastMessage, 200);
          terminal = { type: 'completed', task: this.snapshot() };
          break;
        case 'turn_aborted':
        case 'task_aborted':
          this.value.status = 'interrupted';
          this.value.statusLabel = '已中断';
          this.value.currentActivity = '任务已中断';
          this.value.completedAt = at;
          terminal = { type: 'interrupted', task: this.snapshot() };
          break;
        case 'error':
        case 'stream_error':
        case 'model_error':
          this.value.status = 'failed';
          this.value.statusLabel = '执行失败';
          this.value.currentActivity = '任务执行失败';
          this.value.completedAt = at;
          terminal = { type: 'failed', task: this.snapshot() };
          break;
        case 'approval_request':
        case 'exec_approval_request':
          this.value.status = 'waiting_approval';
          this.value.statusLabel = '等待授权';
          this.value.currentActivity = '等待您确认操作';
          terminal = { type: 'waiting_approval', task: this.snapshot() };
          break;
        default:
          break;
      }
    }

    if (record?.type === 'response_item') {
      const toolCall = payload.type === 'custom_tool_call' || payload.type === 'function_call';
      const toolOutput = payload.type === 'custom_tool_call_output' || payload.type === 'function_call_output';
      if (toolCall) {
        const name = String(payload.name || '工具');
        this.value.currentActivity = `正在运行 ${name}`;
        if (/request.*user.*input/i.test(name)) {
          this.value.status = 'waiting_input';
          this.value.statusLabel = '等待输入';
          this.value.currentActivity = '等待您提供信息';
          terminal = { type: 'waiting_input', task: this.snapshot() };
        }
      } else if (toolOutput) {
        if (this.value.status === 'waiting_input' || this.value.status === 'waiting_approval') {
          this.value.status = 'running';
          this.value.statusLabel = '运行中';
        }
        this.value.currentActivity = '工具执行完毕，继续处理';
      }
    }

    this.value.lastUpdatedAt = at;
    return terminal;
  }

  snapshot(options = {}) {
    const snapshot = JSON.parse(JSON.stringify(this.value));
    const now = Number(options.now || Date.now());
    const activeWindowMs = Number(options.activeWindowMs || 0);
    if (snapshot.status === 'running' && activeWindowMs > 0 && this.lastFileActivityAt > 0
      && now - this.lastFileActivityAt > activeWindowMs) {
      snapshot.status = 'idle';
      snapshot.statusLabel = '\u5386\u53f2\u4f1a\u8bdd';
      snapshot.currentActivity = '\u6700\u8fd1\u6ca1\u6709\u6d3b\u52a8';
    }
    return snapshot;
  }
}

class CodexSessionMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    this.sessionRoot = path.join(this.codexHome, 'sessions');
    this.archivedRoot = path.join(this.codexHome, 'archived_sessions');
    this.databaseFile = path.join(this.codexHome, 'state_5.sqlite');
    this.indexFile = path.join(this.codexHome, 'session_index.jsonl');
    this.globalStateFile = path.join(this.codexHome, '.codex-global-state.json');
    this.dismissedFile = options.dismissedFile || '';
    this.intervalMs = Number(options.intervalMs || 1000);
    this.activeWindowMs = Number(options.activeWindowMs || DEFAULT_ACTIVE_WINDOW_MS);
    this.sessions = new Map();
    this.offsets = new Map();
    this.names = new Map();
    this.catalog = new Map();
    this.catalogAvailable = false;
    this.projectNames = new Map();
    this.projectByThread = new Map();
    this.projectByRoot = new Map();
    this.dismissed = new Set();
    try {
      const values = JSON.parse(fs.readFileSync(this.dismissedFile, 'utf8'));
      if (Array.isArray(values)) this.dismissed = new Set(values.map(String));
    } catch {}
    this.watchers = [];
    this.timer = null;
    this.running = false;
    this.bootstrapped = false;
    this.revision = 0;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    await this.scan(true);
    this.bootstrapped = true;
    this.watch();
    this.timer = setInterval(() => this.scan(false).catch((error) => this.emit('error', error)), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
  }

  watch() {
    for (const [target, recursive] of [[this.sessionRoot, true], [this.archivedRoot, true], [this.indexFile, false], [this.databaseFile, false], [this.globalStateFile, false]]) {
      try {
        const watcher = fs.watch(target, { recursive }, () => this.scan(false).catch((error) => this.emit('error', error)));
        watcher.on('error', (error) => this.emit('error', error));
        this.watchers.push(watcher);
      } catch {}
    }
  }

  async refreshNames() {
    const next = new Map();
    try {
      const text = await fsp.readFile(this.indexFile, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          if (item.id && item.thread_name) next.set(item.id, item.thread_name);
        } catch {}
      }
    } catch {}
    this.names = next;
  }

  refreshDesktopState() {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(this.globalStateFile, 'utf8')); } catch {}
    const projects = state['local-projects'] && typeof state['local-projects'] === 'object' ? state['local-projects'] : {};
    this.projectNames = new Map();
    this.projectByRoot = new Map();
    for (const [id, project] of Object.entries(projects)) {
      const roots = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
      const name = compactText(project?.name || path.basename(roots[0] || '') || id, 120);
      this.projectNames.set(id, name);
      for (const root of roots) this.projectByRoot.set(normalizedFsPath(root), name);
    }
    const assignments = state['thread-project-assignments'] && typeof state['thread-project-assignments'] === 'object'
      ? state['thread-project-assignments'] : {};
    this.projectByThread = new Map(Object.entries(assignments).map(([threadId, assignment]) => [threadId, this.projectNames.get(assignment?.projectId) || '']));
  }

  saveDismissed() {
    if (!this.dismissedFile) return;
    fs.mkdirSync(path.dirname(this.dismissedFile), { recursive: true });
    const temporary = `${this.dismissedFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify([...this.dismissed], null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.dismissedFile);
  }

  refreshCatalog() {
    if (!fs.existsSync(this.databaseFile)) { this.catalog = new Map(); this.catalogAvailable = false; return; }
    let database;
    try {
      database = new DatabaseSync(this.databaseFile, { readOnly: true });
      const rows = database.prepare('SELECT id,cwd,title,name,first_user_message,model,model_provider,archived,rollout_path,COALESCE(NULLIF(recency_at_ms,0),NULLIF(updated_at_ms,0),updated_at*1000) AS updated_ms FROM threads ORDER BY updated_ms DESC').all();
      this.catalog = new Map(rows.map((item) => [item.id, item]));
      this.catalogAvailable = true;
    } catch { this.catalogAvailable = false; }
    finally { try { database?.close(); } catch {} }
  }

  async listFiles(root = this.sessionRoot) {
    const found = [];
    let entries = [];
    try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return found; }
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) found.push(...await this.listFiles(full));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fsp.stat(full);
          found.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
    return found;
  }

  async scan(initial) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.refreshNames();
      this.refreshDesktopState();
      this.refreshCatalog();
      const currentFiles = (await this.listFiles(this.sessionRoot)).map((item) => ({ ...item, archived: false }));
      const archivedFiles = (await this.listFiles(this.archivedRoot)).map((item) => ({ ...item, archived: true }));
      const discovered = [...currentFiles, ...archivedFiles];
      const catalogFiles = this.catalogAvailable
        ? discovered.filter((item) => this.catalog.has(sessionIdFromFile(item.file)))
        : discovered;
      const files = catalogFiles.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_SESSIONS * 2);
      for (const entry of files) await this.readFile(entry, initial);
      const kept = new Set(files.map((item) => item.file));
      for (const file of this.sessions.keys()) {
        if (!kept.has(file)) {
          this.sessions.delete(file);
          this.offsets.delete(file);
        }
      }
      this.revision += 1;
      this.emit('updated', this.snapshot());
    } finally {
      this.scanning = false;
    }
  }

  async readFile(entry, initial) {
    let parser = this.sessions.get(entry.file);
    if (!parser) {
      parser = new SessionState(entry.file);
      this.sessions.set(entry.file, parser);
    }
    parser.markFileActivity(entry.mtimeMs);
    parser.value.archived = entry.archived === true;

    let offset = this.offsets.get(entry.file);
    if (offset === undefined || entry.size < offset) {
      offset = Math.max(0, entry.size - INITIAL_TAIL_BYTES);
      if (offset > 0) offset = await this.nextLineOffset(entry.file, offset, entry.size);
    }
    if (entry.size === offset) {
      this.applyCatalog(parser);
      return;
    }

    const length = entry.size - offset;
    const handle = await fsp.open(entry.file, 'r');
    const buffer = Buffer.allocUnsafe(length);
    try { await handle.read(buffer, 0, length, offset); } finally { await handle.close(); }
    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const text = buffer.subarray(0, lastNewline + 1).toString('utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const terminal = parser.apply(JSON.parse(line));
        if (terminal && !initial && this.bootstrapped) this.emit('terminal', terminal);
      } catch {}
    }
    this.applyCatalog(parser);
    if (parser.value.status === 'idle' && Date.now() - entry.mtimeMs < 30_000) {
      parser.value.status = 'running';
      parser.value.statusLabel = '运行中';
      parser.value.currentActivity = '会话正在活动';
    }
    this.offsets.set(entry.file, offset + lastNewline + 1);
  }

  applyCatalog(parser) {
    const item = this.catalog.get(parser.value.id);
    parser.setThreadName(this.names.get(parser.value.id) || item?.name || item?.title || item?.first_user_message);
    if (!item) return;
    parser.setMeta({ cwd: item.cwd });
    parser.value.project = this.projectByThread.get(parser.value.id)
      || this.projectByRoot.get(normalizedFsPath(parser.value.cwd))
      || parser.value.project;
    parser.value.model = item.model || item.model_provider || parser.value.model;
    parser.value.archived = Number(item.archived) === 1;
  }

  runCatalogMutation(operation, id, rolloutPath = '') {
    const database = new DatabaseSync(this.databaseFile);
    try {
      const result = operation === 'archive'
        ? database.prepare('UPDATE threads SET archived=1, archived_at=unixepoch(), rollout_path=? WHERE id=?').run(rolloutPath, id)
        : database.prepare('DELETE FROM threads WHERE id=?').run(id);
      if (Number(result.changes) !== 1) throw new Error('Conversation index record was not found');
    } finally { database.close(); }
  }

  async archiveThread(id) {
    const session = [...this.sessions.values()].find((item) => item.value.id === id);
    if (!session) throw new Error('会话不存在');
    if (['running', 'waiting_input', 'waiting_approval'].includes(session.value.status)) throw new Error('运行中的会话不能归档');
    fs.mkdirSync(this.archivedRoot, { recursive: true });
    const destination = path.join(this.archivedRoot, path.basename(session.file));
    const moved = path.resolve(session.file) !== path.resolve(destination);
    if (moved && fs.existsSync(destination)) throw new Error('归档目录中已存在同名会话');
    if (moved) fs.renameSync(session.file, destination);
    try { this.runCatalogMutation('archive', id, destination); }
    catch (error) {
      if (moved && fs.existsSync(destination)) fs.renameSync(destination, session.file);
      throw error;
    }
    this.dismissed.delete(id);
    this.saveDismissed();
    await this.scan(false);
    return this.snapshot();
  }

  async deleteThread(id, options = {}) {
    const session = [...this.sessions.values()].find((item) => item.value.id === id);
    if (!session) throw new Error('会话不存在');
    if (['running', 'waiting_input', 'waiting_approval'].includes(session.value.status)) throw new Error('运行中的会话不能删除');
    const resolved = path.resolve(session.file);
    const allowed = [this.sessionRoot, this.archivedRoot].some((root) => resolved.startsWith(`${path.resolve(root)}${path.sep}`));
    if (!allowed) throw new Error('会话文件不在 Codex 目录中');
    const staged = path.join(path.dirname(resolved), `.navo-delete-${path.basename(resolved)}`);
    if (fs.existsSync(staged)) throw new Error('会话删除暂存文件已存在');
    fs.renameSync(resolved, staged);
    try { this.runCatalogMutation('delete', id); }
    catch (error) {
      if (fs.existsSync(staged)) fs.renameSync(staged, resolved);
      throw error;
    }
    fs.unlinkSync(staged);
    this.dismissed.delete(id);
    this.saveDismissed();
    if (options.scan !== false) await this.scan(false);
    return this.snapshot();
  }

  async clearFailed(mode = 'list') {
    const targets = [...this.sessions.values()].filter((session) => ['failed', 'interrupted'].includes(session.value.status));
    if (mode === 'list') {
      for (const session of targets) this.dismissed.add(session.value.id);
      this.saveDismissed();
      this.revision += 1;
      const snapshot = this.snapshot();
      this.emit('updated', snapshot);
      return snapshot;
    }
    if (mode !== 'delete') throw new Error('未知的清空方式');
    for (const session of targets) await this.deleteThread(session.value.id, { scan: false });
    await this.scan(false);
    return this.snapshot();
  }

  async nextLineOffset(file, offset, size) {
    const handle = await fsp.open(file, 'r');
    const length = Math.min(64 * 1024, size - offset);
    const buffer = Buffer.allocUnsafe(length);
    try { await handle.read(buffer, 0, length, offset); } finally { await handle.close(); }
    const newline = buffer.indexOf(0x0a);
    return newline < 0 ? offset : offset + newline + 1;
  }

  snapshot() {
    const now = Date.now();
    const tasks = [...this.sessions.values()]
      .map((session) => session.snapshot({ now, activeWindowMs: this.activeWindowMs }))
      .filter((task) => !this.dismissed.has(task.id))
      .sort((a, b) => String(b.lastUpdatedAt || '').localeCompare(String(a.lastUpdatedAt || '')));
    const today = new Date().toDateString();
    const counts = { running: 0, waiting: 0, completedToday: 0, failed: 0, archived: 0, total: tasks.length };
    for (const task of tasks) {
      if (task.status === 'running') counts.running += 1;
      if (task.status === 'waiting_input' || task.status === 'waiting_approval') counts.waiting += 1;
      if (task.status === 'failed' || task.status === 'interrupted') counts.failed += 1;
      if (task.archived) counts.archived += 1;
      if (task.status === 'completed' && task.completedAt && new Date(task.completedAt).toDateString() === today) counts.completedToday += 1;
    }
    return { revision: this.revision, connected: this.running, tasks, counts, codexHome: this.codexHome };
  }
}

module.exports = { CodexSessionMonitor, SessionState, normalizeUsage, subtractUsage, compactText, DEFAULT_ACTIVE_WINDOW_MS };

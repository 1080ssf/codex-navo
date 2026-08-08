const fs = require('node:fs');
const path = require('node:path');

const STORE_VERSION = 2;
const TAIL_STATE_BYTES = 512 * 1024;

// OpenAI API list prices per 1M tokens. This is an API-equivalent estimate,
// not the amount charged to a ChatGPT subscription.
const MODEL_PRICING = {
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
};

function emptyUsage() {
  return {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return localDateKey(new Date());
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function tokenSnapshot(value) {
  if (!value || typeof value !== 'object') return null;
  const snapshot = {
    input: safeNumber(value.input_tokens),
    cachedInput: safeNumber(value.cached_input_tokens ?? value.cache_read_input_tokens),
    cacheWriteInput: safeNumber(value.cache_write_input_tokens),
    output: safeNumber(value.output_tokens),
    reasoningOutput: safeNumber(value.reasoning_output_tokens),
  };
  return Object.values(snapshot).some(Boolean) ? snapshot : null;
}

function subtractSnapshot(current, previous) {
  if (!current) return null;
  if (!previous) return { ...current };
  return Object.fromEntries(Object.keys(current).map((key) => [key, Math.max(0, current[key] - (previous[key] || 0))]));
}

function normalizeDelta(delta) {
  if (!delta) return null;
  const normalized = {
    input: safeNumber(delta.input),
    cachedInput: safeNumber(delta.cachedInput),
    cacheWriteInput: safeNumber(delta.cacheWriteInput),
    output: safeNumber(delta.output),
    reasoningOutput: safeNumber(delta.reasoningOutput),
  };
  normalized.cachedInput = Math.min(normalized.cachedInput, normalized.input);
  normalized.cacheWriteInput = Math.min(normalized.cacheWriteInput, Math.max(0, normalized.input - normalized.cachedInput));
  return normalized.input || normalized.output ? normalized : null;
}

function normalizeModel(value) {
  const raw = String(value || 'unknown').trim().toLowerCase();
  return raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
}

function estimateCost(model, delta) {
  const pricing = MODEL_PRICING[normalizeModel(model)];
  if (!pricing) return null;
  const longContextMultiplier = delta.input > 272_000 ? 2 : 1;
  const outputMultiplier = delta.input > 272_000 ? 1.5 : 1;
  const uncached = Math.max(0, delta.input - delta.cachedInput - delta.cacheWriteInput);
  const cost = (
    (uncached * pricing.input * longContextMultiplier)
    + (delta.cachedInput * pricing.cachedInput * longContextMultiplier)
    + (delta.cacheWriteInput * pricing.input * 1.25 * longContextMultiplier)
    + (delta.output * pricing.output * outputMultiplier)
  ) / 1_000_000;
  return Number(cost.toFixed(8));
}

function addUsage(target, source) {
  for (const key of Object.keys(emptyUsage())) target[key] += Number(source[key]) || 0;
  target.estimatedCostUsd = Number(target.estimatedCostUsd.toFixed(8));
  return target;
}

function collectJsonl(directory, output) {
  if (!directory || !fs.existsSync(directory)) return;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(candidate);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(candidate);
    }
  }
}

function selectedDayKeys(range, availableKeys, now = new Date()) {
  if (range === 'all') return [...availableKeys];
  const count = range === '30d' ? 30 : range === '7d' ? 7 : 1;
  const offset = range === 'yesterday' ? 1 : 0;
  const keys = [];
  for (let index = offset; index < offset + count; index += 1) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - index);
    keys.push(localDateKey(date));
  }
  return keys;
}

class CodexUsageTracker {
  constructor(options) {
    this.storeFile = options.storeFile;
    this.sharedCodexHome = options.sharedCodexHome;
    this.getAccounts = options.getAccounts;
    this.getAccountHome = options.getAccountHome;
    this.getActiveAccountId = options.getActiveAccountId;
    this.getSharedIntervals = options.getSharedIntervals || (() => []);
    this.lastSyncAt = 0;
    this.syncing = false;
    this.store = this.readStore();
  }

  readStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      if (parsed.version === STORE_VERSION && parsed.cursors && parsed.days) return parsed;
    } catch {}
    return { version: STORE_VERSION, startedAt: new Date().toISOString(), updatedAt: null, cursors: {}, days: {} };
  }

  save() {
    fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
    const temporary = `${this.storeFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, this.storeFile);
  }

  sources() {
    const sources = [];
    const seen = new Set();
    const appendHome = (home, accountId) => {
      const files = [];
      collectJsonl(path.join(home, 'sessions'), files);
      collectJsonl(path.join(home, 'archived_sessions'), files);
      for (const file of files) {
        const resolved = path.resolve(file);
        const sessionKey = path.basename(resolved).toLowerCase();
        if (seen.has(sessionKey)) continue;
        seen.add(sessionKey);
        sources.push({ file: resolved, accountId });
      }
    };
    appendHome(this.sharedCodexHome, null);
    for (const account of this.getAccounts()) appendHome(this.getAccountHome(account), account.id);
    return sources;
  }

  initializeCursor(file, stat) {
    const cursor = { offset: stat.size, model: 'unknown', total: null, previousSignature: '' };
    if (!stat.size || Date.now() - stat.mtimeMs > 6 * 60 * 60 * 1000) return cursor;
    const start = Math.max(0, stat.size - TAIL_STATE_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const descriptor = fs.openSync(file, 'r');
    try { fs.readSync(descriptor, buffer, 0, length, start); } finally { fs.closeSync(descriptor); }
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    for (const line of text.split(/\r?\n/)) this.inspectLine(line, cursor, null);
    return cursor;
  }

  inspectLine(line, cursor, accountSource) {
    if (!line || (!line.includes('"turn_context"') && !line.includes('"token_count"'))) return false;
    let event;
    try { event = JSON.parse(line); } catch { return false; }
    if (event.type === 'turn_context') {
      const model = event.payload?.model || event.payload?.info?.model;
      if (model) cursor.model = normalizeModel(model);
      return false;
    }
    if (event.type !== 'event_msg' || event.payload?.type !== 'token_count' || !event.payload.info) return false;
    const info = event.payload.info;
    const total = tokenSnapshot(info.total_token_usage);
    const last = tokenSnapshot(info.last_token_usage);
    const signature = JSON.stringify({ total, last });
    if (signature === cursor.previousSignature) return false;
    cursor.previousSignature = signature;
    const delta = normalizeDelta(last || subtractSnapshot(total, cursor.total));
    if (total) cursor.total = total;
    const model = normalizeModel(info.model || info.model_name || event.payload.model || cursor.model);
    if (model !== 'unknown') cursor.model = model;
    const accountId = typeof accountSource === 'function'
      ? accountSource(event.timestamp || null)
      : accountSource;
    if (!delta || !accountId) return false;

    const cost = estimateCost(model, delta);
    const usage = emptyUsage();
    usage.requests = 1;
    usage.inputTokens = delta.input;
    usage.cachedInputTokens = delta.cachedInput;
    usage.cacheWriteInputTokens = delta.cacheWriteInput;
    usage.outputTokens = delta.output;
    usage.reasoningOutputTokens = delta.reasoningOutput;
    usage.totalTokens = delta.input + delta.output;
    usage.estimatedCostUsd = cost || 0;
    usage.pricedRequests = cost == null ? 0 : 1;
    usage.unpricedRequests = cost == null ? 1 : 0;
    const day = localDateKey(event.timestamp || new Date());
    this.store.days[day] ||= { accounts: {} };
    this.store.days[day].accounts[accountId] ||= emptyUsage();
    addUsage(this.store.days[day].accounts[accountId], usage);
    return true;
  }

  sync(force = false) {
    if (this.syncing || (!force && Date.now() - this.lastSyncAt < 2_000)) return false;
    this.syncing = true;
    let changed = false;
    try {
      const activeAccountId = this.getActiveAccountId();
      const sharedIntervals = this.getSharedIntervals();
      const historyStart = sharedIntervals.length
        ? Math.min(...sharedIntervals.map((interval) => interval.startMs))
        : null;
      const resolveSharedAccount = (timestamp) => {
        const time = Date.parse(timestamp || '');
        if (Number.isFinite(time)) {
          for (let index = sharedIntervals.length - 1; index >= 0; index -= 1) {
            const interval = sharedIntervals[index];
            if (time >= interval.startMs && (interval.endMs == null || time <= interval.endMs)) return interval.accountId;
          }
        }
        return activeAccountId;
      };
      for (const source of this.sources()) {
        let stat;
        try { stat = fs.statSync(source.file); } catch { continue; }
        let cursor = this.store.cursors[source.file];
        if (!cursor) {
          const sessionKey = path.basename(source.file).toLowerCase();
          const previousPath = Object.keys(this.store.cursors).find((candidate) => (
            candidate !== source.file
            && path.basename(candidate).toLowerCase() === sessionKey
            && !fs.existsSync(candidate)
          ));
          if (previousPath) {
            cursor = this.store.cursors[previousPath];
            delete this.store.cursors[previousPath];
            this.store.cursors[source.file] = cursor;
            changed = true;
          }
        }
        if (!cursor) {
          const canBackfill = Boolean(source.accountId || (historyStart != null && stat.mtimeMs >= historyStart));
          cursor = canBackfill
            ? { offset: 0, model: 'unknown', total: null, previousSignature: '' }
            : this.initializeCursor(source.file, stat);
          this.store.cursors[source.file] = cursor;
          changed = true;
          if (!canBackfill) continue;
        } else if (stat.size < cursor.offset) {
          this.store.cursors[source.file] = this.initializeCursor(source.file, stat);
          changed = true;
          continue;
        }
        if (stat.size === cursor.offset) continue;
        const length = stat.size - cursor.offset;
        const buffer = Buffer.alloc(length);
        const descriptor = fs.openSync(source.file, 'r');
        try { fs.readSync(descriptor, buffer, 0, length, cursor.offset); } finally { fs.closeSync(descriptor); }
        const lastNewline = buffer.lastIndexOf(0x0a);
        if (lastNewline < 0) continue;
        const complete = buffer.subarray(0, lastNewline + 1);
        const accountSource = source.accountId || resolveSharedAccount;
        for (const line of complete.toString('utf8').split(/\r?\n/)) {
          if (this.inspectLine(line, cursor, accountSource)) changed = true;
        }
        cursor.offset += complete.length;
        changed = true;
      }
      this.lastSyncAt = Date.now();
      if (changed) {
        this.store.updatedAt = new Date().toISOString();
        this.save();
      }
      return changed;
    } finally {
      this.syncing = false;
    }
  }

  summary(range = 'today') {
    const allowed = new Set(['today', 'yesterday', '7d', '30d', 'all']);
    const selectedRange = allowed.has(range) ? range : 'today';
    const dayKeys = selectedDayKeys(selectedRange, Object.keys(this.store.days));
    const totals = emptyUsage();
    const accounts = {};
    for (const dayKey of dayKeys) {
      for (const [accountId, usage] of Object.entries(this.store.days[dayKey]?.accounts || {})) {
        accounts[accountId] ||= emptyUsage();
        addUsage(accounts[accountId], usage);
        addUsage(totals, usage);
      }
    }
    return {
      range: selectedRange,
      startedAt: this.store.startedAt,
      updatedAt: this.store.updatedAt,
      totals,
      accounts,
      pricingSource: 'OpenAI API list prices',
    };
  }
}

module.exports = {
  CodexUsageTracker,
  MODEL_PRICING,
  emptyUsage,
  estimateCost,
  localDateKey,
  selectedDayKeys,
  tokenSnapshot,
};

'use strict';

// Synthetic local-state benchmark. Never starts server.js, watchers, network,
// account login, CLI processes, or reads the user's Codex home.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { CodexUsageTracker, localDateKey, emptyUsage } = require('../lib/codex-usage');
const { CodexSessionMonitor } = require('../lib/session-monitor');
const { ApiServiceManager } = require('../lib/api-service');

const BYTE_LIMIT = 200_000_000;
const quick = process.argv.includes('--quick');
const accountCounts = quick ? [1] : [1, 20, 100];
const scales = quick ? ['normal'] : ['normal', 'large'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-state-benchmark-'));
let bytesWritten = 0;
let active = null;
const restores = [];
const rows = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bytes = (value) => Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value));
const rounded = (value) => Math.round(value * 1000) / 1000;
function inside(target) {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Benchmark path escapes its dedicated temporary directory');
  return target;
}
function budget(size) {
  if (bytesWritten + size > BYTE_LIMIT) throw new Error('Synthetic write budget exceeds 200 MB');
  bytesWritten += size;
}
function patch(object, name, wrapper) {
  const original = object[name];
  object[name] = wrapper(original);
  restores.push(() => { object[name] = original; });
}

// Count logical JS filesystem I/O, not physical disk traffic. SQLite's native
// reads, OS cache effects and Node internals are explicitly outside these bytes.
for (const name of ['existsSync', 'statSync', 'readdirSync', 'openSync', 'closeSync', 'renameSync', 'mkdirSync']) {
  patch(fs, name, (original) => function (...args) {
    if (active) active.metadataCalls++;
    return original.apply(this, args);
  });
}
let syncDepth = 0;
for (const name of ['readFileSync', 'readSync', 'writeFileSync', 'appendFileSync']) {
  patch(fs, name, (original) => function (...args) {
    const outer = syncDepth++ === 0;
    const writing = name === 'writeFileSync' || name === 'appendFileSync';
    try {
      if (writing && outer) { inside(args[0]); budget(bytes(args[1])); }
      const result = original.apply(this, args);
      if (active && outer) {
        if (writing) { active.writeCalls++; active.writeBytes += bytes(args[1]); }
        else { active.readCalls++; active.readBytes += name === 'readSync' ? result : bytes(result); }
      }
      return result;
    } finally { syncDepth--; }
  });
}
for (const name of ['readdir', 'stat', 'readFile', 'open']) {
  patch(fsp, name, (original) => async function (...args) {
    const result = await original.apply(this, args);
    if (active) {
      if (name === 'readFile') { active.readCalls++; active.readBytes += bytes(result); }
      else active.metadataCalls++;
    }
    if (name === 'open') {
      const read = result.read.bind(result);
      result.read = async (...readArgs) => {
        const readResult = await read(...readArgs);
        if (active) { active.readCalls++; active.readBytes += readResult.bytesRead; }
        return readResult;
      };
    }
    return result;
  });
}

// Reuse the actual atomic JSON helpers without evaluating server startup.
const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const helperStart = serverSource.indexOf('function readJson(');
const helperEnd = serverSource.indexOf('function copyFileAtomic(', helperStart);
if (helperStart < 0 || helperEnd < helperStart) throw new Error('Server JSON helper boundary not found');
const helpers = vm.runInNewContext(`${serverSource.slice(helperStart, helperEnd)}\n({readJson, writeJsonAtomic})`, { fs, path, process, Date });

function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
async function measure(scope, label, iterations, operation, prepare = () => {}) {
  const samples = [];
  for (let index = 0; index < iterations; index++) {
    await prepare(index);
    const io = { readBytes: 0, writeBytes: 0, readCalls: 0, writeCalls: 0, metadataCalls: 0 };
    let previousTick = performance.now();
    let maxLoopDelayMs = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxLoopDelayMs = Math.max(maxLoopDelayMs, now - previousTick - 1);
      previousTick = now;
    }, 1);
    try {
      await delay(3);
      maxLoopDelayMs = 0;
      previousTick = performance.now();
      const cpu = process.cpuUsage();
      const started = performance.now();
      active = io;
      try { await operation(index); }
      finally { active = null; }
      const elapsedMs = performance.now() - started;
      const consumed = process.cpuUsage(cpu);
      await delay(3);
      samples.push({ elapsedMs, cpuMs: (consumed.user + consumed.system) / 1000, maxLoopDelayMs, ...io });
    } finally { clearInterval(timer); }
  }
  const row = { ...scope, operation: label, samples: iterations,
    medianMs: rounded(median(samples.map((item) => item.elapsedMs))),
    maxMs: rounded(Math.max(...samples.map((item) => item.elapsedMs))),
    medianCpuMs: rounded(median(samples.map((item) => item.cpuMs))),
    maxLoopDelayMs: rounded(Math.max(...samples.map((item) => item.maxLoopDelayMs))),
  };
  for (const field of ['readBytes', 'writeBytes', 'readCalls', 'writeCalls', 'metadataCalls']) row[field] = median(samples.map((sample) => sample[field]));
  rows.push(row);
  process.stderr.write(`${label}: ${scope.accounts} accounts / ${scope.scale}, ${row.medianMs} ms\n`);
}

function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function removeFixture(directory) {
  inside(directory);
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
function idFor(index) { return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`; }

async function sessionsCase(accountsCount, scale) {
  const directory = path.join(root, `sessions-${accountsCount}-${scale}`);
  const count = scale === 'large' ? 2000 : 20;
  const days = scale === 'large' ? 365 : 7;
  const shared = path.join(directory, 'shared');
  const accountRoot = path.join(directory, 'accounts');
  const accounts = Array.from({ length: accountsCount }, (_, index) => ({ id: `account-${index}` }));
  const files = [];
  const at = new Date().toISOString();
  for (let index = 0; index < count; index++) {
    const file = path.join(accountRoot, accounts[index % accountsCount].id, 'sessions', `rollout-${idFor(index)}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const records = [
      { type: 'session_meta', timestamp: at, payload: { id: idFor(index), cwd: 'C:/synthetic/project', originator: 'Codex' } },
      { type: 'turn_context', timestamp: at, payload: { model: 'gpt-6-astra' } },
      { type: 'event_msg', timestamp: at, payload: { type: 'task_started', turn_id: `turn-${index}` } },
      ...Array.from({ length: 4 }, (_, turn) => ({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: {
        navo_diagnostic_request_id: `${index}-${turn}`, last_token_usage: { input_tokens: 1000, cached_input_tokens: 500, output_tokens: 100 },
      } } })),
      { type: 'event_msg', timestamp: at, payload: { type: 'task_complete', turn_id: `turn-${index}` } },
    ];
    fs.writeFileSync(file, `${records.map(JSON.stringify).join('\n')}\n`);
    files.push(file);
  }
  writeJson(path.join(shared, '.codex-global-state.json'), { 'local-projects': {} });
  fs.writeFileSync(path.join(shared, 'session_index.jsonl'), files.map((_file, index) => JSON.stringify({ id: idFor(index), thread_name: `Synthetic task ${index}` })).join('\n'));
  const databaseFile = inside(path.join(shared, 'state_5.sqlite'));
  const database = new DatabaseSync(databaseFile);
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY,cwd TEXT,title TEXT,name TEXT,first_user_message TEXT,model TEXT,model_provider TEXT,archived INTEGER,rollout_path TEXT,thread_source TEXT,source TEXT,recency_at_ms INTEGER,updated_at_ms INTEGER,updated_at INTEGER); BEGIN');
  const insert = database.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  files.forEach((file, index) => insert.run(idFor(index), 'C:/synthetic/project', `Task ${index}`, '', '', 'gpt-6-astra', '', 0, file, '', '', Date.now(), Date.now(), Math.floor(Date.now() / 1000)));
  database.exec('COMMIT'); database.close();
  budget(fs.statSync(databaseFile).size * 2); // Conservative allowance for SQLite fixture/journal writes.
  const scope = { group: 'sessions-usage', accounts: accountsCount, scale, sessionFiles: count, historyDays: days, sqliteBytes: fs.statSync(databaseFile).size };
  const tracker = new CodexUsageTracker({
    storeFile: path.join(directory, 'usage.json'), sharedCodexHome: shared,
    getAccounts: () => accounts, getAccountHome: (account) => path.join(accountRoot, account.id), getActiveAccountId: () => accounts[0].id,
  });
  await measure(scope, 'usage.cold-sync', 1, () => tracker.sync(true));
  assert.equal(tracker.summary('today').totals.requests, count * 4, 'All synthetic usage events must be ingested');
  for (let day = 1; day < days; day++) {
    const date = new Date(); date.setDate(date.getDate() - day);
    tracker.store.days[localDateKey(date)] = { accounts: Object.fromEntries(accounts.map((account) => [account.id, { ...emptyUsage(), requests: 10, inputTokens: 10000, outputTokens: 1000, totalTokens: 11000 }])) };
  }
  tracker.save();
  await measure(scope, 'usage.due-no-change', 3, () => tracker.sync(true));
  await measure(scope, 'usage.cached-poll', 3, () => tracker.sync());
  await measure(scope, 'usage.summary-all', 3, () => JSON.stringify(tracker.summary('all')));
  await measure(scope, 'usage.one-increment', 1, () => tracker.sync(true), () => fs.appendFileSync(files[0], `${JSON.stringify({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { navo_diagnostic_request_id: 'increment', last_token_usage: { input_tokens: 1234, output_tokens: 123 } } } })}\n`));
  const monitor = new CodexSessionMonitor({ codexHome: shared, dismissedFile: path.join(directory, 'dismissed.json') });
  monitor.sessionRoot = accountRoot; // Same real recursive scan over the synthetic account rollouts.
  await measure(scope, 'sessions.cold-scan', 1, () => monitor.scan(true));
  assert.equal(monitor.snapshot().tasks.length, Math.min(count, 400), 'Exercise the real 400-rollout retention limit');
  await measure(scope, 'sessions.warm-scan', 3, () => monitor.scan(false));
  await measure(scope, 'sessions.snapshot', 3, () => JSON.stringify(monitor.snapshot()));
  removeFixture(directory);
}

async function ledgerCase(accountsCount, scale) {
  const directory = path.join(root, `ledger-${accountsCount}-${scale}`);
  const entries = scale === 'large' ? 20000 : 100;
  const today = localDateKey();
  const keys = Array.from({ length: accountsCount }, (_, index) => ({ id: `synthetic-${index}`, name: `Synthetic ${index}`, enabled: true,
    accountIds: [`account-${index}`], accountScope: 'explicit', dailyUsageVersion: 2, usage: {}, dailyUsage: [{ date: today, usage: {} }], usageLedger: [] }));
  for (let index = 0; index < entries; index++) keys[index % keys.length].usageLedger.push({
    requestId: `synthetic-request-${index}`, model: 'gpt-6-astra', date: today, usedAt: `${today}T04:00:00.000Z`,
    inputTokens: 1000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0, source: 'api', pricingRevision: '2026-09-06',
  });
  writeJson(path.join(directory, 'api-service', 'keys.json'), keys);
  let manager;
  const scope = { group: 'api-ledger', accounts: accountsCount, scale, keyCount: keys.length, ledgerEntries: entries };
  await measure(scope, 'api.load-ledger', 3, () => { manager = new ApiServiceManager({ runtimeRoot: directory, ...helpers }); });
  await measure(scope, 'api.record-one-request', 3, (index) => manager.recordUsage(manager.keys[0], { inputTokens: 1000, outputTokens: 100 }, 'gpt-6-astra', new Date(), { requestId: `new-${index}` }));
  await measure(scope, 'api.public-state', 3, () => JSON.stringify(manager.publicState()));
  removeFixture(directory);
}

async function main() {
  try {
    await measure({ group: 'baseline', accounts: 0, scale: 'idle' }, 'idle.timer-jitter', 3, () => delay(20));
    for (const count of accountCounts) for (const scale of scales) await sessionsCase(count, scale);
    for (const count of accountCounts) for (const scale of scales) await ledgerCase(count, scale);
    const result = { generatedAt: new Date().toISOString(), environment: {
      node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(),
      cpu: os.cpus()[0].model.trim(), logicalCpus: os.cpus().length, totalMemoryGiB: rounded(os.totalmem() / 1024 ** 3),
      processPeakRssMiB: rounded(process.resourceUsage().maxRSS / 1024), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, syntheticWriteBytes: bytesWritten, writeLimitBytes: BYTE_LIMIT, rows };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    while (restores.length) restores.pop()();
    const absolute = path.resolve(root);
    const temp = path.resolve(os.tmpdir());
    if (path.dirname(absolute) !== temp || !path.basename(absolute).startsWith('navo-state-benchmark-')) throw new Error('Unsafe benchmark cleanup target');
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });

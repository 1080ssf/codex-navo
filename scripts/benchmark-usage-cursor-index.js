'use strict';

// Compare this narrow change with the pinned pre-change implementation.
// Only synthetic rollouts/stores under a new Temp directory are accessed.
// No server, timers/watchers, accounts, network, CLI or real usage store starts.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const assert = require('node:assert/strict');
const { CodexUsageTracker } = require('../lib/codex-usage');

const BASELINE_REF = '42c62ea';
const BYTE_LIMIT = 50_000_000;
const repo = path.resolve(__dirname, '..');
const baselineSource = execFileSync('git', ['show', `${BASELINE_REF}:lib/codex-usage.js`],
  { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
const baselineModule = { exports: {} };
// Compile in this realm, like the current CommonJS module, so object/array
// operations do not get a different cross-context cost in just the baseline.
vm.compileFunction(baselineSource, ['require', 'module', 'exports'],
  { filename: `${BASELINE_REF}/lib/codex-usage.js` })((name) => {
  assert.ok(['node:fs', 'node:path', 'node:readline'].includes(name), `Unexpected baseline dependency: ${name}`);
  return require(name);
}, baselineModule, baselineModule.exports);
const variants = { baseline: baselineModule.exports.CodexUsageTracker, indexed: CodexUsageTracker };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-usage-index-benchmark-'));
const originalWrite = fs.writeFileSync;
let bytesWritten = 0;
fs.writeFileSync = function (file, content, ...args) {
  const relative = path.relative(root, path.resolve(file));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Write must remain in the benchmark directory');
  const size = Buffer.isBuffer(content) ? content.length : Buffer.byteLength(String(content));
  assert.ok(bytesWritten + size <= BYTE_LIMIT, 'Synthetic writes must remain below 50 MB');
  bytesWritten += size;
  return originalWrite.call(this, file, content, ...args);
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
const round = (value) => Math.round(value * 1000) / 1000;
function measure(operation) {
  const cpu = process.cpuUsage();
  const started = performance.now();
  operation();
  const elapsedMs = performance.now() - started;
  const consumed = process.cpuUsage(cpu);
  return { elapsedMs: round(elapsedMs), cpuMs: (consumed.user + consumed.system) / 1000 };
}
function makeHome(count) {
  const home = path.join(root, `files-${count}`);
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const timestamp = new Date().toISOString();
  for (let index = 0; index < count; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const lines = [
      { type: 'session_meta', timestamp, payload: { id } },
      { type: 'turn_context', payload: { model: 'gpt-6-astra' } },
      { type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 100 },
      } } },
    ];
    fs.writeFileSync(path.join(home, 'sessions', `rollout-${id}.jsonl`), `${lines.map(JSON.stringify).join('\n')}\n`);
  }
  return home;
}
function createTracker(variant, count, iteration, home) {
  return new variants[variant]({ storeFile: path.join(root, `stores-${count}`, `${variant}-${iteration}.json`),
    sharedCodexHome: path.join(root, 'unused-shared'), getAccounts: () => [{ id: 'synthetic-account' }],
    getAccountHome: () => home, getActiveAccountId: () => 'synthetic-account' });
}
function seedMovedPaths(tracker) {
  const moved = {};
  for (const [file, cursor] of Object.entries(tracker.store.cursors)) {
    moved[path.join(root, 'former-home-not-present', path.basename(file))] = cursor;
  }
  tracker.store.cursors = moved;
}
function assertUsage(tracker, count) {
  const usage = tracker.summary('all').totals;
  assert.equal(usage.requests, count);
  assert.equal(usage.inputTokens, count * 1000);
  assert.equal(usage.cachedInputTokens, count * 900);
  assert.equal(usage.outputTokens, count * 100);
  assert.equal(Object.keys(tracker.store.cursors).length, count);
}

try {
  const rows = [];
  for (const count of [100, 1000, 2000]) {
    const home = makeHome(count);
    const samples = { baseline: { cold: [], unchanged: [], migration: [] }, indexed: { cold: [], unchanged: [], migration: [] } };
    for (let iteration = 0; iteration < 3; iteration++) {
      // Alternate order to avoid always giving either implementation the first scan.
      for (const variant of iteration % 2 ? ['indexed', 'baseline'] : ['baseline', 'indexed']) {
        const tracker = createTracker(variant, count, iteration, home);
        samples[variant].cold.push(measure(() => tracker.sync(true)));
        assertUsage(tracker, count);
        samples[variant].unchanged.push(measure(() => assert.equal(tracker.sync(true), false)));
        seedMovedPaths(tracker);
        samples[variant].migration.push(measure(() => tracker.sync(true)));
        assertUsage(tracker, count);
        assert.ok(Object.keys(tracker.store.cursors).every((file) => fs.existsSync(file)));
      }
    }
    for (const variant of Object.keys(samples)) {
      for (const operation of Object.keys(samples[variant])) {
        const values = samples[variant][operation];
        rows.push({ files: count, variant, operation,
          medianMs: round(median(values.map((sample) => sample.elapsedMs))),
          medianCpuMs: round(median(values.map((sample) => sample.cpuMs))), samples: values });
      }
    }
    process.stderr.write(`Completed synthetic ${count}-file comparison\n`);
  }

  // Count basename work separately: instrumentation is deliberately excluded
  // from the elapsed-time samples above.
  const counts = [];
  const countHome = makeHome(128);
  for (const variant of Object.keys(variants)) {
    const tracker = createTracker(variant, 128, 'counts', countHome);
    const originalBasename = path.basename;
    let calls = 0;
    path.basename = function (...args) { calls++; return originalBasename.apply(this, args); };
    try { tracker.sync(true); } finally { path.basename = originalBasename; }
    assertUsage(tracker, 128);
    counts.push({ files: 128, variant, operation: 'cold', basenameCalls: calls });
  }
  process.stdout.write(`${JSON.stringify({ measuredAt: new Date().toISOString(), baselineRef: BASELINE_REF,
    node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0]?.model,
    byteLimit: BYTE_LIMIT, bytesWritten, rows, instrumentationCounts: counts }, null, 2)}\n`);
} finally {
  fs.writeFileSync = originalWrite;
  const relative = path.relative(os.tmpdir(), root);
  assert.ok(relative.startsWith('navo-usage-index-benchmark-') && !relative.includes(path.sep), 'Invalid cleanup target');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexUsageTracker, localDateKey } = require('../lib/codex-usage');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-usage-cursor-test-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('navo-usage-cursor-test-') && !relative.includes(path.sep));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const options = { storeFile: path.join(root, 'usage.json'), sharedCodexHome: path.join(root, 'shared'),
    getAccounts: () => [], getAccountHome: () => path.join(root, 'account'), getActiveAccountId: () => 'a' };
  const tracker = new CodexUsageTracker(options);
  const sources = [];
  tracker.sources = () => sources;
  function write(relative, content = '') {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }
  function add(file) { sources.push({ file, accountId: 'a' }); }
  return { tracker, sources, write, add, options };
}

function event(input, timestamp = new Date().toISOString()) {
  return `${JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: {
    model: 'gpt-6-astra', last_token_usage: { input_tokens: input, output_tokens: input / 10 },
  } } })}\n`;
}

test('moving an accounted rollout to archive preserves its cursor and only counts appended events', (t) => {
  const { tracker, sources, write, add, options } = fixture(t);
  const first = write('sessions/rollout-one.jsonl', event(100));
  add(first);
  tracker.sync(true);
  const savedOffset = tracker.store.cursors[first].offset;
  const archived = write('archived_sessions/rollout-one.jsonl');
  fs.renameSync(first, archived);
  fs.appendFileSync(archived, event(200));
  sources[0].file = archived;

  // Restore the persisted cursor, not merely an in-memory index from first sync.
  const restored = new CodexUsageTracker(options);
  restored.sources = () => sources;
  assert.equal(restored.store.cursors[first].offset, savedOffset);
  assert.equal(restored.sync(true), true);
  assert.equal(restored.store.cursors[first], undefined);
  assert.equal(restored.store.cursors[archived].offset, fs.statSync(archived).size);
  assert.equal(restored.summary('all').totals.requests, 2);
  assert.equal(restored.summary('all').totals.inputTokens, 300);
  assert.equal(restored.sync(true), false);
  assert.equal(restored.summary('all').totals.inputTokens, 300);
});

test('same-name copies do not take a cursor while the original path still exists', (t) => {
  const { tracker, sources, write, add } = fixture(t);
  const original = write('old/rollout-copy.jsonl', event(100));
  add(original);
  tracker.sync(true);
  const originalCursor = tracker.store.cursors[original];
  const copy = write('new/rollout-copy.jsonl', event(100));
  sources[0].file = copy;
  tracker.sync(true);
  assert.equal(tracker.store.cursors[original], originalCursor);
  assert.notEqual(tracker.store.cursors[copy], originalCursor);
  assert.equal(tracker.summary('all').totals.requests, 2);
});

test('same-name migration preserves candidate insertion order and removes migrated paths from the index', (t) => {
  const { tracker, write, add } = fixture(t);
  const present = write('present/rollout-order.jsonl');
  const missingFirst = write('gone-one/ROLLOUT-ORDER.jsonl');
  const missingSecond = write('gone-two/rollout-order.jsonl');
  const first = { offset: 0, marker: 'first missing' };
  const second = { offset: 0, marker: 'second missing' };
  tracker.store.cursors[present] = { offset: 0, marker: 'must not move' };
  tracker.store.cursors[missingFirst] = first;
  tracker.store.cursors[missingSecond] = second;
  fs.unlinkSync(missingFirst);
  fs.unlinkSync(missingSecond);
  const destinationOne = write('new-one/rollout-order.jsonl');
  const destinationTwo = write('new-two/rollout-order.jsonl');
  add(destinationOne);
  add(destinationTwo);
  tracker.sync(true);
  assert.equal(tracker.store.cursors[destinationOne], first);
  assert.equal(tracker.store.cursors[destinationTwo], second);
  assert.deepEqual(Object.keys(tracker.store.cursors), [present, destinationOne, destinationTwo]);
});

test('a path added earlier in the same sync can migrate if the file moves during ingestion', (t) => {
  const { tracker, write, add } = fixture(t);
  const first = write('first/rollout-new.jsonl', event(100));
  const second = write('second/rollout-new.jsonl', event(100));
  add(first);
  add(second);
  const inspect = tracker.inspectLine.bind(tracker);
  tracker.inspectLine = (...args) => {
    const changed = inspect(...args);
    if (changed && fs.existsSync(first)) fs.unlinkSync(first);
    return changed;
  };
  tracker.sync(true);
  assert.equal(tracker.store.cursors[first], undefined);
  assert.equal(tracker.store.cursors[second].offset, fs.statSync(second).size);
  assert.equal(tracker.summary('all').totals.requests, 1);
});

test('rebuild paths also enter an already-created migration index', (t) => {
  const { tracker, write, add } = fixture(t);
  const at = new Date('2026-09-12T12:00:00');
  const later = new Date('2026-09-14T12:00:00');
  const unrelated = write('other/rollout-unrelated.jsonl');
  const first = write('first/rollout-rebuilt.jsonl', event(100, at.toISOString()));
  const second = write('second/rollout-rebuilt.jsonl', event(100, at.toISOString()));
  fs.utimesSync(unrelated, later, later);
  fs.utimesSync(first, at, at);
  fs.utimesSync(second, later, later);
  tracker.store.rebuildDays = [localDateKey(at)];
  add(unrelated);
  add(first);
  add(second);
  const inspect = tracker.inspectLine.bind(tracker);
  tracker.inspectLine = (...args) => {
    const changed = inspect(...args);
    if (changed && fs.existsSync(first)) fs.unlinkSync(first);
    return changed;
  };
  tracker.sync(true);
  assert.equal(tracker.store.cursors[first], undefined);
  assert.equal(tracker.store.cursors[second].offset, fs.statSync(second).size);
  assert.equal(tracker.summary('all').totals.requests, 1);
  assert.equal(tracker.store.rebuildDays, undefined);
});

test('new unrelated paths enumerate the cursor table once and unchanged scans never build the index', (t) => {
  const { tracker, write, add } = fixture(t);
  for (let index = 0; index < 64; index++) add(write(`sessions/rollout-${index}.jsonl`, event(index + 10)));
  let enumerations = 0;
  tracker.store.cursors = new Proxy(tracker.store.cursors, {
    ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
  });
  tracker.sync(true);
  assert.equal(tracker.summary('all').totals.requests, 64);
  assert.equal(enumerations, 2, 'one index build plus one atomic JSON snapshot, not one scan per file');
  enumerations = 0;
  assert.equal(tracker.sync(true), false);
  assert.equal(enumerations, 0, 'an unchanged scan must not enumerate cursors for a migration index');
});

test('truncated migrated files initialize at their current size without replaying prior usage', (t) => {
  const { tracker, sources, write, add } = fixture(t);
  const original = write('original/rollout-truncated.jsonl', event(100) + event(200));
  add(original);
  tracker.sync(true);
  const target = write('moved/rollout-truncated.jsonl', event(100));
  fs.unlinkSync(original);
  sources[0].file = target;
  tracker.sync(true);
  assert.equal(tracker.store.cursors[original], undefined);
  assert.equal(tracker.store.cursors[target].offset, fs.statSync(target).size);
  assert.equal(tracker.summary('all').totals.inputTokens, 300);
  fs.appendFileSync(target, event(300));
  tracker.sync(true);
  assert.equal(tracker.summary('all').totals.inputTokens, 600);
});

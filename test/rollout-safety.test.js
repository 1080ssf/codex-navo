const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { listRolloutBackups, optimizeRolloutFile, restoreRolloutBackup, rolloutBackupStorage } = require('../lib/codex-launch-view');

const encode = (items) => `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;
const smallOptions = { minimumBytes: 1, minimumSavingsRatio: 0.1 };
const appended = encode([{ type: 'response_item', payload: { type: 'message', text: 'new writer data' } }]);

function fixture(t, turnType = 'turn_started') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-rollout-safety-'));
  // All writes and cleanup in this suite are confined to this dedicated fixture.
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const sessions = path.join(home, 'sessions');
  const backupRoot = path.join(root, 'backups');
  const file = path.join(sessions, 'rollout-fixture.jsonl');
  fs.mkdirSync(sessions, { recursive: true });
  const checkpoint = { type: 'compacted', payload: { replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'checkpoint summary' }] }] } };
  const items = [
    { type: 'session_meta', payload: { id: 'fixture-thread', future_metadata: { kept: true } } },
    { type: 'response_item', payload: { type: 'message', text: 'x'.repeat(32 * 1024) } },
    { type: 'event_msg', payload: { type: turnType, turn_id: 'fixture-turn' } },
    { type: 'turn_context', payload: { model: 'test-only-model', reasoning: { effort: 'low' } } },
    checkpoint,
    { type: 'event_msg', payload: { type: 'future_compatible_event', data: ['preserve', 'verbatim'] } },
    { type: 'response_item', payload: { type: 'message', text: 'retained tail' } },
  ];
  const original = encode(items);
  fs.writeFileSync(file, original);
  return { root, home, sessions, backupRoot, file, items, original, checkpoint };
}

function noTemporaryFiles(directory) {
  return fs.readdirSync(directory).every((name) => !/\.navo-(?:optimize|restore)-/.test(name));
}

test('both known turn-start formats preserve checkpoint, context and later records with auditable metadata', async (t) => {
  for (const turnType of ['turn_started', 'task_started']) {
    const f = fixture(t, turnType);
    const result = await optimizeRolloutFile(f.file, f.backupRoot, smallOptions);
    assert.ok(result);
    assert.equal(fs.readFileSync(f.file, 'utf8'), encode([f.items[0], ...f.items.slice(2)]));
    assert.equal(fs.readFileSync(result.backup, 'utf8'), f.original);
    const manifest = JSON.parse(fs.readFileSync(`${result.backup}.json`, 'utf8'));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.sourceSha256, crypto.createHash('sha256').update(f.original).digest('hex'));
    assert.equal(manifest.optimizedSha256, crypto.createHash('sha256').update(fs.readFileSync(f.file)).digest('hex'));
    assert.equal(result.backupBytes, Buffer.byteLength(f.original));
    assert.ok(result.durationMs >= 0);
    assert.ok(result.timingsMs.inspect >= 0 && result.timingsMs.verify >= 0);
    assert.ok(result.requiredFreeBytes > result.backupBytes);
    assert.equal(result.checksumAvailable, true);
    const listed = listRolloutBackups(f.backupRoot);
    assert.equal(listed[0].backupBytes, result.backupBytes);
    assert.ok(listed[0].backupRootBytes >= result.backupBytes);
    assert.equal(listed[0].checksumAvailable, true);
    assert.equal(rolloutBackupStorage(f.backupRoot).backupCount, 1);
  }
});

test('unknown top-level formats, malformed JSON and non-object records are left untouched', async (t) => {
  for (const extra of ['{"type":"future_history_format","payload":{}}\n', '{invalid json\n', 'null\n', '[]\n']) {
    const f = fixture(t);
    const content = f.original + extra;
    fs.writeFileSync(f.file, content);
    assert.equal(await optimizeRolloutFile(f.file, f.backupRoot, smallOptions), null);
    assert.equal(fs.readFileSync(f.file, 'utf8'), content);
    assert.equal(fs.existsSync(f.backupRoot), false);
  }
});

test('post-checkpoint rollbacks and old message-only compactions are not guessed or truncated', async (t) => {
  const f = fixture(t);
  const rolled = f.original + encode([{ type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } }]);
  fs.writeFileSync(f.file, rolled);
  assert.equal(await optimizeRolloutFile(f.file, f.backupRoot, smallOptions), null);
  assert.equal(fs.readFileSync(f.file, 'utf8'), rolled);
  const legacy = encode(f.items.map((item) => item.type === 'compacted' ? { type: 'compacted', payload: { message: 'old summary' } } : item));
  fs.writeFileSync(f.file, legacy);
  assert.equal(await optimizeRolloutFile(f.file, f.backupRoot, smallOptions), null);
  assert.equal(fs.readFileSync(f.file, 'utf8'), legacy);
});

test('a writer changing source data between inspection and replacement aborts without overwriting it', async (t) => {
  for (const stage of ['write', 'verify', 'commit']) {
    const f = fixture(t);
    await assert.rejects(optimizeRolloutFile(f.file, f.backupRoot, {
      ...smallOptions,
      onProgress(progress) { if (progress.stage === stage) fs.appendFileSync(f.file, appended); },
    }), { code: 'ROLLOUT_CHANGED' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original + appended);
    assert.equal(noTemporaryFiles(f.sessions), true);
    if (stage === 'commit') {
      const backups = listRolloutBackups(f.backupRoot);
      assert.equal(backups.length, 1);
      assert.equal(fs.readFileSync(path.join(f.backupRoot, backups[0].id), 'utf8'), f.original);
    }
  }
});

test('staged output corruption is caught before commit and leaves the source intact', async (t) => {
  const f = fixture(t);
  await assert.rejects(optimizeRolloutFile(f.file, f.backupRoot, {
    ...smallOptions,
    onProgress({ stage }) {
      if (stage === 'verify') {
        const temporary = fs.readdirSync(f.sessions).find((name) => name.includes('.navo-optimize-'));
        fs.appendFileSync(path.join(f.sessions, temporary), appended);
      }
    },
  }), /checksum mismatch/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  assert.equal(noTemporaryFiles(f.sessions), true);
});

test('active sessions are rejected at start and if Codex becomes active before commit', async (t) => {
  const f = fixture(t);
  await assert.rejects(optimizeRolloutFile(f.file, f.backupRoot, { ...smallOptions, isFileActive: () => true }), { code: 'ROLLOUT_BUSY' });
  assert.equal(fs.existsSync(f.backupRoot), false);
  let running = false;
  await assert.rejects(optimizeRolloutFile(f.file, f.backupRoot, {
    ...smallOptions, isFileActive: () => running,
    onProgress({ stage }) { if (stage === 'commit') running = true; },
  }), { code: 'ROLLOUT_BUSY' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

test('per-file maintenance excludes overlapping operations and releases the guard after completion', async (t) => {
  const f = fixture(t);
  let release, inspected;
  const paused = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { inspected = resolve; });
  const first = optimizeRolloutFile(f.file, f.backupRoot, {
    ...smallOptions, async onProgress({ stage }) { if (stage === 'inspect') { inspected(); await paused; } },
  });
  await ready;
  await assert.rejects(optimizeRolloutFile(f.file, f.backupRoot, smallOptions), { code: 'ROLLOUT_BUSY' });
  release();
  const result = await first;
  assert.ok(await restoreRolloutBackup(f.home, f.backupRoot, path.basename(result.backup)));
});

test('insufficient backup and staging space is reported before file mutation', async (t) => {
  const f = fixture(t);
  await assert.rejects(optimizeRolloutFile(f.file, f.backupRoot, { ...smallOptions, getFreeBytes: () => 0 }), { code: 'ROLLOUT_NO_SPACE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  assert.equal(fs.existsSync(f.backupRoot), false);
  assert.equal(noTemporaryFiles(f.sessions), true);
});

test('failed replacement never copies an old backup over data appended by another writer', async (t) => {
  const f = fixture(t);
  const rename = fs.renameSync;
  fs.renameSync = (source, destination) => {
    if (destination === f.file) {
      fs.appendFileSync(f.file, appended);
      throw Object.assign(new Error('simulated file in use'), { code: 'EBUSY' });
    }
    return rename(source, destination);
  };
  try {
    await assert.rejects(optimizeRolloutFile(f.file, f.backupRoot, smallOptions), { code: 'EBUSY' });
  } finally { fs.renameSync = rename; }
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original + appended);
  assert.equal(noTemporaryFiles(f.sessions), true);
  assert.equal(listRolloutBackups(f.backupRoot).length, 1);
});

test('restore checks the backup digest even when altered data remains valid JSONL', async (t) => {
  const f = fixture(t);
  const optimized = await optimizeRolloutFile(f.file, f.backupRoot, smallOptions);
  const current = fs.readFileSync(f.file, 'utf8');
  fs.appendFileSync(optimized.backup, appended);
  await assert.rejects(restoreRolloutBackup(f.home, f.backupRoot, path.basename(optimized.backup)), /checksum mismatch/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), current);
  assert.equal(noTemporaryFiles(f.sessions), true);
});

test('restore rejects source, backup and staged-file changes during processing', async (t) => {
  for (const target of ['source', 'backup', 'temporary']) {
    const f = fixture(t);
    const optimized = await optimizeRolloutFile(f.file, f.backupRoot, smallOptions);
    const current = fs.readFileSync(f.file, 'utf8');
    await assert.rejects(restoreRolloutBackup(f.home, f.backupRoot, path.basename(optimized.backup), {
      onProgress({ stage }) {
        if (stage !== 'commit') return;
        if (target === 'source') fs.appendFileSync(f.file, appended);
        else if (target === 'backup') fs.appendFileSync(optimized.backup, appended);
        else {
          const temporary = fs.readdirSync(f.sessions).find((name) => name.includes('.navo-restore-'));
          fs.appendFileSync(path.join(f.sessions, temporary), appended);
        }
      },
    }), { code: 'ROLLOUT_CHANGED' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), current + (target === 'source' ? appended : ''));
    assert.equal(noTemporaryFiles(f.sessions), true);
  }
});

test('restore preserves a checksummed safety backup and supports restoring it again', async (t) => {
  const f = fixture(t);
  const optimized = await optimizeRolloutFile(f.file, f.backupRoot, smallOptions);
  fs.appendFileSync(f.file, appended);
  const current = fs.readFileSync(f.file, 'utf8');
  const restored = await restoreRolloutBackup(f.home, f.backupRoot, path.basename(optimized.backup));
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  assert.equal(fs.readFileSync(restored.safetyBackup, 'utf8'), current);
  assert.equal(restored.checksumAvailable, true);
  assert.ok(restored.durationMs >= 0 && restored.backupRootBytes > restored.backupBytes);
  await restoreRolloutBackup(f.home, f.backupRoot, path.basename(restored.safetyBackup));
  assert.equal(fs.readFileSync(f.file, 'utf8'), current);
});

test('legacy manifests retain structural validation and explicitly report unavailable checksums', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.backupRoot);
  const backup = path.join(f.backupRoot, 'legacy.bak');
  fs.writeFileSync(backup, f.original);
  fs.writeFileSync(`${backup}.json`, JSON.stringify({ source: f.file, beforeBytes: Buffer.byteLength(f.original) }));
  assert.equal(listRolloutBackups(f.backupRoot)[0].checksumAvailable, false);
  const restored = await restoreRolloutBackup(f.home, f.backupRoot, 'legacy.bak');
  assert.equal(restored.checksumAvailable, false);
  fs.writeFileSync(backup, 'null\n');
  await assert.rejects(restoreRolloutBackup(f.home, f.backupRoot, 'legacy.bak'), /structural validation/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

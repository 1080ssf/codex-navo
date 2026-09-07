const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdateDiagnostics } = require('../lib/update-diagnostics');

test('diagnostics records stage durations without secrets and throttles progress', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-timings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'timings.jsonl');
  let now = 1000;
  const record = createUpdateDiagnostics(file, { clock: () => now });
  record('codex', { status: 'checking', error: 'SECRET', packageUrl: 'SECRET', networkRoute: 'SECRET' });
  now += 2500;
  record('codex', { status: 'downloading', bytesDownloaded: 10 });
  for (let index = 0; index < 100; index++) record('codex', { status: 'downloading', bytesDownloaded: index });
  now += 12000;
  record('codex', { status: 'downloading', bytesDownloaded: 500 });
  now += 2000;
  record('codex', { status: 'error', error: 'SECRET' });
  await record.flush();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('SECRET'));
  const events = text.trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 4);
  assert.equal(events[1].elapsedMs, 2500);
  assert.equal(events[3].elapsedMs, 14000);
  assert.equal(events[3].previousPhase, 'downloading');
  assert.equal(events[3].failed, true);
  assert.equal(new Set(events.map((event) => event.operationId)).size, 1);
});

test('diagnostic rotation retains one older log and write errors do not break updates', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-timings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'timings.jsonl');
  const record = createUpdateDiagnostics(file, { maxBytes: 1 });
  record('navo', { status: 'checking' });
  record('navo', { status: 'available' });
  await record.flush();
  assert.equal(JSON.parse(fs.readFileSync(`${file}.1`, 'utf8')).phase, 'checking');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).phase, 'available');
  let failures = 0;
  const bad = createUpdateDiagnostics(path.join(file, 'invalid'), { onError: () => failures++ });
  bad('navo', { status: 'checking' });
  await bad.flush();
  assert.equal(failures, 1);
});

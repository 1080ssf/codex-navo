'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { CodexSessionMonitor, SessionState } = require('../lib/session-monitor');
const { NotificationService } = require('../lib/notification-service');

test('session state follows a Codex task from start to completion', () => {
  const state = new SessionState(path.join('sessions', '00000000-0000-4000-8000-000000000001.jsonl'));
  state.apply({ type: 'session_meta', timestamp: '2026-08-12T01:00:00Z', payload: { id: 'thread-1', cwd: 'C:\\work\\Navo' } });
  state.apply({ type: 'event_msg', timestamp: '2026-08-12T01:00:01Z', payload: { type: 'task_started', turn_id: 'turn-1' } });
  state.apply({ type: 'event_msg', timestamp: '2026-08-12T01:00:02Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 20, total_tokens: 140 } } } });
  const terminal = state.apply({ type: 'event_msg', timestamp: '2026-08-12T01:00:03Z', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'done' } });
  assert.equal(state.value.project, 'Navo');
  assert.equal(state.value.status, 'completed');
  assert.deepEqual(state.value.usage, { input: 120, cachedInput: 80, output: 20, reasoning: 0, total: 140 });
  assert.equal(terminal.type, 'completed');
});

test('current task usage accumulates total-token deltas instead of jumping between model calls', () => {
  const state = new SessionState(path.join('sessions', '00000000-0000-4000-8000-000000000099.jsonl'));
  state.apply({ type: 'event_msg', timestamp: '2026-08-12T01:00:00Z', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10, total_tokens: 110 },
    total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100, total_tokens: 1100 },
  } } });
  state.apply({ type: 'event_msg', timestamp: '2026-08-12T01:01:00Z', payload: { type: 'task_started', turn_id: 'turn-current' } });
  state.apply({ type: 'event_msg', timestamp: '2026-08-12T01:01:10Z', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 120, cached_input_tokens: 8, output_tokens: 20, total_tokens: 140 },
    total_token_usage: { input_tokens: 1120, cached_input_tokens: 808, output_tokens: 120, total_tokens: 1240 },
  } } });
  state.apply({ type: 'event_msg', timestamp: '2026-08-12T01:01:20Z', payload: { type: 'token_count', info: {
    last_token_usage: { input_tokens: 130, cached_input_tokens: 120, output_tokens: 30, total_tokens: 160 },
    total_token_usage: { input_tokens: 1250, cached_input_tokens: 928, output_tokens: 150, total_tokens: 1400 },
  } } });
  assert.deepEqual(state.snapshot().usage, { input: 250, cachedInput: 128, output: 50, reasoning: 0, total: 300 });
});

test('session monitor incrementally reads a local session and resolves its index title', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'sessions', '2026', '08', '12');
  fs.mkdirSync(folder, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000002';
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Local checkpoint' })}\n`);
  fs.writeFileSync(path.join(folder, `${id}.jsonl`), [
    { type: 'session_meta', timestamp: '2026-08-12T01:00:00Z', payload: { id, cwd: 'C:\\work\\Switchboard' } },
    { type: 'event_msg', timestamp: '2026-08-12T01:00:01Z', payload: { type: 'task_started', turn_id: 'turn-2' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const monitor = new CodexSessionMonitor({ codexHome: root, intervalMs: 60_000 });
  t.after(() => monitor.stop());
  await monitor.start();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.counts.running, 1);
  assert.equal(snapshot.tasks[0].threadName, 'Local checkpoint');
  assert.equal(snapshot.tasks[0].project, 'Switchboard');
});

test('session monitor demotes abandoned running logs to history', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-stale-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'sessions', '2026', '01', '01');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, '00000000-0000-4000-8000-000000000099.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'task_started' } })}\n`);
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(file, old, old);
  const monitor = new CodexSessionMonitor({ codexHome: root, intervalMs: 60_000, activeWindowMs: 15 * 60 * 1000 });
  t.after(() => monitor.stop());
  await monitor.start();
  const snapshot = monitor.snapshot();
  assert.equal(snapshot.counts.running, 0);
  assert.equal(snapshot.tasks[0].status, 'idle');
  assert.equal(snapshot.tasks[0].statusLabel, '\u5386\u53f2\u4f1a\u8bdd');
});

test('session monitor follows the Codex catalog and can archive and delete a conversation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-session-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'sessions', '2026', '08', '14');
  fs.mkdirSync(folder, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000077';
  const orphanId = '00000000-0000-4000-8000-000000000078';
  const file = path.join(folder, `rollout-2026-08-14T00-00-00-${id}.jsonl`);
  const orphan = path.join(folder, `rollout-2026-08-14T00-00-01-${orphanId}.jsonl`);
  const records = [
    { type: 'session_meta', timestamp: '2026-08-14T00:00:00Z', payload: { id, cwd: 'C:\\work\\CatalogProject' } },
    { type: 'event_msg', timestamp: '2026-08-14T00:00:01Z', payload: { type: 'task_complete' } },
  ];
  fs.writeFileSync(file, `${records.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(orphan, `${JSON.stringify({ type: 'session_meta', payload: { id: orphanId } })}\n`);
  fs.writeFileSync(path.join(root, 'session_index.jsonl'), `${JSON.stringify({ id, thread_name: 'Visible catalog title' })}\n`);
  fs.writeFileSync(path.join(root, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { project1: { name: 'Visible project name', rootPaths: ['C:\\work\\CatalogProject'] } },
    'thread-project-assignments': { [id]: { projectId: 'project1' } },
  }));
  const database = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, model TEXT, model_provider TEXT, archived INTEGER, archived_at INTEGER, rollout_path TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER, updated_at INTEGER)');
  database.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'C:\\work\\CatalogProject', 'Catalog title', '', '', 'gpt-5.6-sol', '', 0, null, file, 1, 1, 1);
  database.close();
  const monitor = new CodexSessionMonitor({ codexHome: root, intervalMs: 60_000 });
  t.after(() => monitor.stop());
  await monitor.start();
  assert.deepEqual(monitor.snapshot().tasks.map((task) => task.id), [id]);
  assert.equal(monitor.snapshot().tasks[0].threadName, 'Visible catalog title');
  assert.equal(monitor.snapshot().tasks[0].project, 'Visible project name');
  const archived = await monitor.archiveThread(id);
  assert.equal(archived.tasks[0].archived, true);
  assert.ok(archived.tasks[0].file.includes('archived_sessions'));
  const verifyArchive = new DatabaseSync(path.join(root, 'state_5.sqlite'), { readOnly: true });
  const archiveRow = verifyArchive.prepare('SELECT archived, rollout_path FROM threads WHERE id=?').get(id);
  verifyArchive.close();
  assert.equal(archiveRow.archived, 1);
  assert.ok(archiveRow.rollout_path.includes('archived_sessions'));
  const deleted = await monitor.deleteThread(id);
  assert.equal(deleted.tasks.length, 0);
  const verifyDelete = new DatabaseSync(path.join(root, 'state_5.sqlite'), { readOnly: true });
  assert.equal(verifyDelete.prepare('SELECT count(*) AS total FROM threads WHERE id=?').get(id).total, 0);
  verifyDelete.close();
});

test('failed conversations can be hidden from the list and then deleted locally', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-clear-failed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'sessions', '2026', '08', '14');
  const dismissedFile = path.join(root, 'dismissed.json');
  fs.mkdirSync(folder, { recursive: true });
  const ids = ['00000000-0000-4000-8000-000000000081', '00000000-0000-4000-8000-000000000082'];
  const files = ids.map((id, index) => {
    const file = path.join(folder, `rollout-${index}-${id}.jsonl`);
    fs.writeFileSync(file, `${[
      { type: 'session_meta', timestamp: '2026-08-14T00:00:00Z', payload: { id, cwd: 'C:\\work\\Failed' } },
      { type: 'event_msg', timestamp: '2026-08-14T00:00:01Z', payload: { type: index ? 'turn_aborted' : 'error' } },
    ].map(JSON.stringify).join('\n')}\n`);
    return file;
  });
  const database = new DatabaseSync(path.join(root, 'state_5.sqlite'));
  database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, first_user_message TEXT, model TEXT, model_provider TEXT, archived INTEGER, archived_at INTEGER, rollout_path TEXT, recency_at_ms INTEGER, updated_at_ms INTEGER, updated_at INTEGER)');
  const insert = database.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  ids.forEach((id, index) => insert.run(id, 'C:\\work\\Failed', `Failed ${index}`, '', '', 'gpt-5.6-sol', '', 0, null, files[index], index + 1, index + 1, index + 1));
  database.close();
  const monitor = new CodexSessionMonitor({ codexHome: root, dismissedFile, intervalMs: 60_000 });
  t.after(() => monitor.stop());
  await monitor.start();
  assert.equal(monitor.snapshot().counts.failed, 2);
  const hidden = await monitor.clearFailed('list');
  assert.equal(hidden.counts.failed, 0);
  assert.equal(JSON.parse(fs.readFileSync(dismissedFile, 'utf8')).length, 2);
  const deleted = await monitor.clearFailed('delete');
  assert.equal(deleted.counts.total, 0);
  const verify = new DatabaseSync(path.join(root, 'state_5.sqlite'), { readOnly: true });
  assert.equal(verify.prepare('SELECT count(*) AS total FROM threads').get().total, 0);
  verify.close();
});

test('notification service queues a local event and deduplicates terminal events', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-notify-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'notifications.json');
  const service = new NotificationService({
    file,
    readJson: () => ({}),
    writeJsonAtomic: (target, value) => fs.writeFileSync(target, JSON.stringify(value)),
    fetch: async () => ({ ok: true, json: async () => ({ code: 0 }) }),
  });
  service.save({ notificationText: 'My exact notification', sound: 'none' });
  const event = { type: 'completed', task: { id: 'thread-1', turnId: 'turn-1', project: 'Navo', threadName: 'Build', completedAt: new Date().toISOString() } };
  const first = await service.notify(event);
  const second = await service.notify(event);
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(service.listEvents(0).length, 1);
  assert.equal(service.listEvents(0)[0].message, 'My exact notification');
});

test('notification service ignores historical terminal events replayed by a session rescan', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-notify-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.parse('2026-08-16T00:20:00.000Z');
  const service = new NotificationService({
    file: path.join(root, 'notifications.json'),
    readJson: () => ({}),
    writeJsonAtomic: (target, value) => fs.writeFileSync(target, JSON.stringify(value)),
    now: () => now,
  });
  const historical = await service.notify({
    type: 'completed',
    task: { id: 'old-thread', turnId: 'old-turn', completedAt: '2026-08-15T20:00:00.000Z' },
  });
  const missingTimestamp = await service.notify({
    type: 'completed',
    task: { id: 'unknown-thread', turnId: 'unknown-turn' },
  });
  assert.equal(historical.skipped, true);
  assert.equal(historical.reason, 'stale-terminal-event');
  assert.equal(missingTimestamp.skipped, true);
  assert.equal(service.listEvents(0).length, 0);
});

test('notification channels send the user-authored message without an added preset', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-notify-message-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  const service = new NotificationService({
    file: path.join(root, 'notifications.json'),
    readJson: () => ({}),
    writeJsonAtomic: (target, value) => fs.writeFileSync(target, JSON.stringify(value)),
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ code: 0 }) };
    },
  });
  service.save({
    notificationText: 'Custom message: {project}\n{title}',
    feishuEnabled: true,
    feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
  });
  await service.notify({ type: 'completed', task: { id: 'thread-2', turnId: 'turn-2', project: 'Navo', threadName: 'Build', completedAt: new Date().toISOString() } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.content.text, 'Custom message: {project}\n{title}');
});

test('legacy notification variables migrate to the plain default message', () => {
  const service = new NotificationService({
    file: 'unused.json',
    readJson: () => ({ notificationText: '{project} · {title}：{status}' }),
    writeJsonAtomic: () => {},
  });
  assert.equal(service.publicSettings().notificationText, '有任务已处理完毕。');
  assert.equal(service.messageFor({}), '有任务已处理完毕。');
});

test('notification settings accept additional and imported sounds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-notification-sound-'));
  const service = new NotificationService({
    file: path.join(root, 'settings.json'), readJson: () => ({}),
    writeJsonAtomic(file, value) { fs.writeFileSync(file, JSON.stringify(value)); },
  });
  const dataUrl = 'data:audio/wav;base64,UklGRg==';
  assert.equal(service.save({ sound: 'glass' }).sound, 'glass');
  for (const sound of ['notice', 'question', 'error', 'pluck', 'click']) assert.equal(service.save({ sound }).sound, sound);
  const imported = service.save({ sound: 'custom', customSound: dataUrl });
  assert.equal(imported.customSound, dataUrl);
  assert.equal(imported.sound, 'custom:legacy');
  const named = service.save({
    sound: 'custom:bell1234',
    customSounds: [{ id: 'custom:bell1234', name: 'My Bell', dataUrl }],
  });
  assert.deepEqual(named.customSounds.map((item) => [item.id, item.name]), [['custom:bell1234', 'My Bell']]);
  assert.equal(named.customSound, dataUrl);
});

test('session and notification pages are separate sidebar destinations', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const sessionsIndex = html.indexOf('data-sidebar-section="sessions"');
  const notificationsIndex = html.indexOf('data-sidebar-section="notifications"');
  assert.ok(sessionsIndex >= 0);
  assert.ok(notificationsIndex > sessionsIndex);
  assert.match(html, /data-app-page="sessions"/);
  assert.match(html, /data-app-page="notifications"/);
  assert.match(html, /id="session-list"/);
  assert.match(html, /id="notification-form"/);
  assert.doesNotMatch(html, /id="notification-template"|内置文案/);
  assert.match(html, /textarea name="notificationText"[^>]+required/);
  assert.doesNotMatch(html, /<option value="custom">导入音频<\/option>/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
function serverFunction(name) {
  const start = serverSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  return serverSource.slice(start, serverSource.indexOf('\n}', start) + 2);
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const now = Date.parse('2026-09-12T04:00:00Z');
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
function serverRuntime() {
  const context = vm.createContext({ Date: FixedDate });
  vm.runInContext(['floatingQuotaSync', 'recentActiveFloatingTask', 'combinedFloatingQuotaWindows'].map(serverFunction).join('\n'), context);
  return context;
}

test('quota freshness uses successful reads, never a new snapshot or failed-attempt timestamp', () => {
  const context = serverRuntime();
  const old = '2026-09-11T04:00:00.000Z';
  const current = '2026-09-12T03:59:30.000Z';
  const account = { quota: { refreshedAt: old }, quotaCheckedAt: new Date(now).toISOString(), quotaError: 'offline' };
  const failed = context.floatingQuotaSync([account]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastSucceededAt, old);
  assert.equal(failed.lastAttemptedAt, new Date(now).toISOString());
  assert.equal(failed.partial, false);
  delete account.quotaError;
  assert.equal(context.floatingQuotaSync([account]).status, 'stale');
  account.quotaRefreshSucceededAt = current;
  assert.equal(context.floatingQuotaSync([account]).status, 'fresh');
  assert.equal(context.floatingQuotaSync([account]).lastSucceededAt, current);
  assert.equal(context.floatingQuotaSync([{ quotaCheckedAt: current }]).lastSucceededAt, null);
  assert.equal(context.floatingQuotaSync([{ quotaCheckedAt: current }]).status, 'never');
  assert.equal(context.floatingQuotaSync([{ quotaError: 'first read failed', quotaCheckedAt: current }]).status, 'failed');
  assert.equal(context.floatingQuotaSync([]).status, 'never');
});

test('pool reports its oldest successful read and partial sync without inventing missing timestamps', () => {
  const context = serverRuntime();
  const older = '2026-09-12T03:59:00.000Z';
  const newer = '2026-09-12T03:59:50.000Z';
  const pool = [{ quota: { refreshedAt: newer } }, { quota: { refreshedAt: older } }, {}];
  let sync = context.floatingQuotaSync(pool);
  assert.equal(sync.lastSucceededAt, older);
  assert.equal(sync.status, 'stale');
  assert.equal(sync.partial, true);
  assert.equal(sync.syncedAccountCount, 2);
  assert.equal(sync.accountCount, 3);
  pool[1].quotaError = 'not synchronized';
  sync = context.floatingQuotaSync(pool);
  assert.equal(sync.status, 'failed');
  assert.equal(sync.syncedAccountCount, 1);
  assert.equal(sync.failedAccountCount, 1);
  assert.equal(sync.lastSucceededAt, older);
});

test('recent task selection ignores children, archived tasks and processes that have exited', () => {
  const context = serverRuntime();
  const tasks = [
    { id: 'older-root', status: 'running', lastUpdatedAt: '2026-09-12T03:58:00Z' },
    { id: 'newer-root', status: 'waiting_input', lastUpdatedAt: '2026-09-12T03:59:00Z' },
    { id: 'child', isSubagent: true, status: 'running', lastUpdatedAt: '2026-09-12T04:00:00Z' },
    { id: 'child-by-parent', parentThreadId: 'older-root', status: 'running', lastUpdatedAt: '2026-09-12T04:00:00Z' },
    { id: 'archived', archived: true, status: 'running', lastUpdatedAt: '2026-09-12T04:00:00Z' },
  ];
  assert.equal(context.recentActiveFloatingTask(tasks, true).id, 'newer-root');
  tasks[0].lastUpdatedAt = '2026-09-12T04:00:01Z';
  assert.equal(context.recentActiveFloatingTask(tasks, true).id, 'older-root');
  assert.equal(context.recentActiveFloatingTask(tasks, false), null);
  assert.deepEqual(tasks.map((task) => task.id), ['older-root', 'newer-root', 'child', 'child-by-parent', 'archived']);
});

test('floating payload replaces task identity, turn and token totals as one root-task snapshot across account switches', () => {
  const context = serverRuntime();
  const account = { id: 'a', label: 'Account A', quota: { refreshedAt: '2026-09-12T03:59:30Z', windows: [] } };
  const tasks = [
    { id: 't1', turnId: 'turn-1', threadName: 'First task', status: 'running', lastUpdatedAt: '2026-09-12T03:59:00Z', usage: { input: 10, cachedInput: 3, output: 1 } },
    { id: 't2', turnId: 'turn-2', threadName: 'Second task', status: 'running', lastUpdatedAt: '2026-09-12T03:58:00Z', usage: { input: 20, cachedInput: 8, output: 4 } },
  ];
  let pid = 1;
  let activeAccountId = 'a';
  Object.assign(context, {
    accounts: [account, { id: 'b', label: 'Account B' }],
    detectCodexDesktopSnapshot: () => ({ pid }), publicApiServiceState: () => ({ keys: [] }), activeCodexAccountId: () => activeAccountId,
    usageTracker: { sync() {}, summary: () => ({ accounts: { a: { inputTokens: 1000 }, b: { inputTokens: 2000 } } }) },
    sessionMonitor: { snapshot: () => ({ tasks }) },
  });
  vm.runInContext(serverFunction('floatingWindowState'), context);
  let data = context.floatingWindowState();
  assert.equal(data.task.selection, 'recent-active-root');
  assert.equal(data.task.id, 't1');
  assert.deepEqual(plain(data.task.usage), { input: 10, cachedInput: 3, output: 1 });
  tasks[1].lastUpdatedAt = '2026-09-12T04:00:00Z';
  activeAccountId = 'b';
  data = context.floatingWindowState();
  assert.equal(data.account.id, 'b');
  assert.equal(data.usage.input, 2000);
  assert.equal(data.task.title, 'Second task');
  assert.equal(data.task.id, 't2');
  assert.equal(data.task.turnId, 'turn-2');
  assert.deepEqual(plain(data.task.usage), { input: 20, cachedInput: 8, output: 4 });
  pid = 0;
  assert.equal(context.floatingWindowState().task, null);
});

test('dual quota bars retain source durations and earliest reset while ignoring unknown values', () => {
  const context = serverRuntime();
  const windows = context.combinedFloatingQuotaWindows([
    { quota: { windows: [
      { windowDurationMins: 10080, remainingPercent: 80, resetsAt: 800 },
      { windowDurationMins: 300, remainingPercent: 40, resetsAt: null },
    ] } },
    { quota: { windows: [
      { windowDurationMins: 300, remainingPercent: 20, resetsAt: 100 },
      { windowDurationMins: 10080, remainingPercent: 60, resetsAt: 700 },
      { windowDurationMins: 60, remainingPercent: null, resetsAt: 1 },
    ] } },
  ]);
  assert.deepEqual(plain(windows).map(({ windowDurationMins, remainingPercent, resetsAt }) => ({ windowDurationMins, remainingPercent, resetsAt })), [
    { windowDurationMins: 300, remainingPercent: 30, resetsAt: 100 },
    { windowDurationMins: 10080, remainingPercent: 70, resetsAt: 700 },
  ]);
});

function element() {
  const item = { textContent: '', innerHTML: '', dataset: {}, className: '', listeners: {},
    setAttribute(name, value) { this[name] = value; }, addEventListener(name, callback) { this.listeners[name] = callback; } };
  item.classList = {
    contains: (name) => item.className.split(' ').includes(name),
    add: (name) => { item.className = [...new Set([...item.className.split(' ').filter(Boolean), name])].join(' '); },
    remove: (name) => { item.className = item.className.split(' ').filter((value) => value !== name).join(' '); },
    toggle: (name, value) => value ? item.classList.add(name) : item.classList.remove(name),
  };
  return item;
}

async function clientRuntime() {
  const elements = new Map();
  const i18n = [];
  for (const match of fs.readFileSync(path.join(root, 'public/floating.html'), 'utf8').matchAll(/<\w+\b([^>]*)>/g)) {
    const id = match[1].match(/\bid="([^"]+)"/)?.[1];
    const key = match[1].match(/\bdata-i18n="([^"]+)"/)?.[1];
    const item = element();
    if (id) elements.set(id, item);
    if (key) { item.dataset.i18n = key; i18n.push(item); }
  }
  let fetchHandler = async (url) => ({ ok: true, json: async () => ({ ok: true, data: url === '/api/bootstrap' ? { csrfToken: 'fixture' } : {} }) });
  const context = vm.createContext({
    Date: FixedDate, Intl, navigator: { languages: ['en-US'] },
    localStorage: { getItem: () => null, setItem() {} },
    document: { documentElement: {}, body: { dataset: {} }, getElementById: (id) => elements.get(id),
      querySelectorAll: (selector) => selector === '[data-i18n]' ? i18n : [] },
    window: { addEventListener() {}, codexFloating: { getSettings: async () => ({}) } },
    fetch: (...args) => fetchHandler(...args), setInterval() {},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/floating.js'), 'utf8'), context);
  await new Promise(setImmediate);
  return { context, elements, fetch: (handler) => { fetchHandler = handler; } };
}

function clientData() {
  return { account: { id: 'a', label: 'A', type: 'account', quotaWindows: [],
    quotaSync: { status: 'stale', lastSucceededAt: '2026-09-11T04:00:00Z', accountCount: 1, syncedAccountCount: 1 } },
  usage: { input: 0, cachedInput: 0 }, task: null, updatedAt: '2026-09-12T04:00:00Z' };
}

test('client labels snapshot versus quota age in both languages and distinguishes no input from zero cache', async () => {
  const { context, elements } = await clientRuntime();
  const data = clientData();
  for (const locale of ['zh-CN', 'en-US']) {
    context.updateLocale(locale);
    context.render(data);
    assert.equal(elements.get('usage-cache-rate').textContent, '—');
    assert.match(elements.get('updated-at').textContent, locale === 'zh-CN' ? /状态快照/ : /Status snapshot/);
    assert.match(elements.get('quota-sync').textContent, locale === 'zh-CN' ? /1天前.*旧数据/ : /1d ago.*Older data/);
    assert.match(elements.get('recent-task-label').textContent, locale === 'zh-CN' ? /最近活动任务/ : /Recent active task/);
    assert.match(elements.get('recent-task-label').title, locale === 'zh-CN' ? /不代表.*聚焦/ : /not the focused/);
    context.render({ ...data, usage: { input: 10, cachedInput: 0 } });
    assert.equal(elements.get('usage-cache-rate').textContent, '0.0%');
  }
  context.render({ ...data, account: { id: 'b', quotaSync: { status: 'never' } }, updatedAt: null });
  assert.equal(elements.get('quota-sync').textContent, 'Quota not read yet');
  assert.equal(elements.get('updated-at').textContent, 'Waiting for local data');
});

test('client root-task changes replace every counter and no-task snapshots clear previous values', async () => {
  const { context, elements } = await clientRuntime();
  const data = clientData();
  const first = { id: 't1', turnId: 'turn-1', title: 'First root', status: 'running', usage: { input: 100, cachedInput: 20, output: 3 } };
  const second = { id: 't2', turnId: 'turn-2', title: 'Second root', status: 'waiting_input', usage: { input: 7, cachedInput: 0, output: 1 } };
  context.render({ ...data, task: first });
  context.render({ ...data, task: second });
  assert.equal(elements.get('task-title').textContent, 'Second root');
  assert.equal(elements.get('task-title').title, 'Second root');
  assert.equal(elements.get('task-title').dataset.taskId, 't2');
  assert.equal(elements.get('task-title').dataset.turnId, 'turn-2');
  assert.deepEqual(['task-input', 'task-cache', 'task-output'].map((id) => elements.get(id).textContent), ['7', '0', '1']);
  context.render(data);
  assert.deepEqual(['task-input', 'task-cache', 'task-output'].map((id) => elements.get(id).textContent), ['—', '—', '—']);
  assert.equal(elements.get('task-title').dataset.taskId, '');
});

test('client service outages mark task status unavailable without faking quota freshness', async () => {
  const runtime = await clientRuntime();
  const data = clientData();
  runtime.context.render({ ...data, task: { id: 't1', title: 'Root', status: 'running', usage: { input: 10 } } });
  const quotaBefore = runtime.elements.get('quota-sync').textContent;
  runtime.fetch(async () => { throw new Error('offline'); });
  await runtime.context.refresh();
  assert.equal(runtime.elements.get('updated-at').textContent, 'Waiting for local service');
  assert.equal(runtime.elements.get('task-state').textContent, 'Status unavailable');
  assert.equal(runtime.elements.get('task-progress').className, 'task-progress idle');
  assert.equal(runtime.elements.get('quota-sync').textContent, quotaBefore);
});

test('manual quota failures survive snapshot polls until a newer success or account change', async () => {
  const runtime = await clientRuntime();
  const data = clientData();
  runtime.context.render(data);
  runtime.fetch(async (url) => url === '/api/bootstrap'
    ? { ok: true, json: async () => ({ ok: true, data: { csrfToken: 'fixture' } }) }
    : { ok: false, status: 502, json: async () => ({ ok: false, error: 'temporary failure' }) });
  await runtime.elements.get('quota-refresh').listeners.click();
  runtime.context.render({ ...data, updatedAt: '2026-09-12T04:00:01Z' });
  assert.match(runtime.elements.get('quota-sync').textContent, /Read failed.*Older data/);
  assert.equal(runtime.elements.get('quota-refresh').disabled, false);
  assert.equal(runtime.elements.get('quota-refresh').classList.contains('loading'), false);
  const recovered = { ...data, account: { ...data.account, quotaSync: { status: 'fresh', lastSucceededAt: '2026-09-12T04:00:00Z' } } };
  runtime.context.render(recovered);
  assert.doesNotMatch(runtime.elements.get('quota-sync').textContent, /Read failed|Older data/);
  runtime.context.render({ ...data, account: { id: 'other', quotaSync: { status: 'never' } } });
  assert.equal(runtime.elements.get('quota-sync').textContent, 'Quota not read yet');
});

test('client keeps quota bar order and unknown reset time instead of showing the Unix epoch', async () => {
  const { context, elements } = await clientRuntime();
  context.renderQuotaWindows([
    { windowDurationMins: 10080, remainingPercent: 0, resetsAt: null },
    { windowDurationMins: 300, remainingPercent: 25, resetsAt: 1790000000 },
  ]);
  const markup = elements.get('quota-windows').innerHTML;
  assert.ok(markup.indexOf('5 hour quota') < markup.indexOf('Weekly'));
  assert.match(markup, /Reset time unknown/);
  assert.doesNotMatch(markup, /1970/);
  assert.equal((markup.match(/<progress/g) || []).length, 2);
});

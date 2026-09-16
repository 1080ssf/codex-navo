const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness(options = {}) {
  const storage = options.storage || new Map();
  const calls = [];
  const timers = [], selected = options.selected || [];
  const results = { innerHTML: '' };
  const catalog = { innerHTML: '' }, error = { hidden: true, textContent: '' };
  const body = { innerHTML: '', prepend() {} };
  const dialog = { open: true, querySelectorAll(selector) { return selector.includes('tools-target') ? selected.map(value=>({value})) : []; }, querySelector(selector) { return selector === '[name="tools-allow-busy"]' ? { checked: options.allowBusy === true } : selector === '.tools-results' ? results : selector === '.tools-catalog' ? catalog : selector === '.tools-error' ? error : body; } };
  const context = vm.createContext({
    window: {}, document: { querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => ({}) },
    state: { accounts: options.accounts || [], apiService: { keys: [] } }, render() {},
    escapeHtml: s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    navoUsesChinese: () => options.chinese !== false,
    confirm: () => options.confirm !== false,
    crypto: { randomUUID: () => '12345678-1234-4234-8234-123456789abc' },
    sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    setTimeout(fn,ms) { timers.push(ms); }, clearTimeout() {},
    api: async (url, request) => { calls.push({ url, body: JSON.parse(request?.body || '{}') }); if (options.api) return options.api(url,request); if (options.transportError) throw new Error('transport interrupted'); return { id: 'job-1', status: 'completed', items: [] }; }
  });
  let source = fs.readFileSync(path.join(__dirname, '../public/account-tools.js'), 'utf8');
  source = source.replace('window.NavoAccountTools = { decorate };', 'window.NavoAccountTools = { decorate, creditCopy, creditMarkup, status, start, consume, renderJob, renderCredits, refreshCredits, modelBody, poll, handle, resetCatalog, setup(d,j,m="credits",c=[]) { dialog=d; job=j; mode=m; targetId="account-a"; catalog=c; creditsState={credits:{availableCount:2,credits:null}}; } };');
  vm.runInContext(source, context);
  return { tools: context.window.NavoAccountTools, calls, storage, dialog, results, body, catalog, error, timers, selected };
}

test('live model probes require confirmation and remove presentation-only fields', async () => {
  const denied = harness({ confirm: false });
  await denied.tools.start([{ targetId: 'account-a', model: 'model-a' }]);
  assert.equal(denied.calls.length, 0);
  const accepted = harness();
  await accepted.tools.start([{ targetId: 'api-member:k:a', model: 'model-a', targetLabel: 'private display label' }]);
  assert.deepEqual(accepted.calls[0].body, { items: [{ targetId: 'api-member:k:a', model: 'model-a' }], confirmed: true, allowBusy: false });
});

test('reset transport failures persist the original idempotency key across reloads', async () => {
  const first = harness({ transportError: true }); first.tools.setup(first.dialog);
  await assert.rejects(first.tools.consume({ dataset: {} }), /transport/);
  await assert.rejects(first.tools.consume({ dataset: {} }), /transport/);
  assert.equal(first.calls[0].body.clientOperationId, first.calls[1].body.clientOperationId);
  const second = harness({ transportError: true, storage: first.storage }); second.tools.setup(second.dialog);
  await assert.rejects(second.tools.consume({ dataset: {} }), /transport/);
  assert.equal(second.calls[0].body.clientOperationId, first.calls[0].body.clientOperationId);
  assert.equal(second.calls[0].body.creditId, undefined);
});

test('active-account probes require an explicit UI opt-in', async () => {
  const h = harness({ allowBusy: true }); h.tools.setup(h.dialog);
  await h.tools.start([{ targetId: 'account-a', model: 'model-a' }]);
  assert.equal(h.calls[0].body.allowBusy, true);
});

test('reset dismissal does not send a request', async () => {
  const h = harness({ confirm: false }); h.tools.setup(h.dialog);
  await h.tools.consume({ dataset: {} }); assert.equal(h.calls.length, 0);
});

test('results read backend state, show HTTP failure and escape upstream content', () => {
  const h = harness(); h.tools.setup(h.dialog, { status: 'completed', items: [{ state: 'service_unavailable', model: '<script>', targetId: 'account-a', httpStatus: 503, error: '<img>', attemptedAccountIds: ['a', 'b'] }] });
  h.tools.renderJob();
  assert.match(h.results.innerHTML, /服务不可用/); assert.match(h.results.innerHTML, /HTTP 503/);
  assert.match(h.results.innerHTML, /&lt;script>/); assert.doesNotMatch(h.results.innerHTML, /<img>/);
});

test('diagnostic state labels support English and Chinese', () => {
  assert.equal(harness({ chinese: false }).tools.status('model_mismatch'), 'Model mismatch');
  assert.equal(harness().tools.status('quota_exhausted'), '额度耗尽');
});

test('reset credit fields and dates follow the application language', () => {
  const card = { title: 'Full reset (Weekly + 5 hr)', status: 'available', resetType: 'codexRateLimits', description: "Thanks for using Codex! You've been granted one free rate limit reset.", expiresAt: '2026-10-04T00:50:06.000Z' };
  const zh = harness().tools.creditMarkup(card, 0, false);
  assert.match(zh, /完整重置（周额度 \+ 5 小时额度）/);
  assert.match(zh, /状态：可用/);
  assert.match(zh, /已获赠一次免费的额度重置/);
  assert.match(zh, /到期时间（本地）/);
  assert.doesNotMatch(zh, /available|codexRateLimits|Thanks|\.000Z/);
  const en = harness({ chinese: false }).tools.creditMarkup(card, 0, false);
  assert.match(en, /Full reset/); assert.match(en, /Status: Available/);
  assert.match(harness().tools.creditMarkup({ title: '<script>', expiresAt: 'invalid' }, 0, false), /&lt;script>/);
});

test('diagnostic controls isolate checkbox sizing and provide tooltip content', () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/styles.css'), 'utf8');
  assert.match(css, /\.navo-account-tools-dialog input\[type="checkbox"\] \{[^}]*width: 16px;[^}]*padding: 0;/);
  const source = fs.readFileSync(path.join(__dirname, '../public/account-tools.js'), 'utf8');
  assert.match(source, /toolbar\.dataset\.tooltip =/);
  assert.match(source, /class="tools-option-text"/);
});

test('unknown reset descriptions retain their original wording with a localized explanation', () => {
  const card = { title: 'Future weekly grant', description: 'New upstream terms', status: 'unknown' };
  for (const chinese of [true, false]) {
    const markup = harness({ chinese }).tools.creditMarkup(card, 0, false);
    assert.match(markup, /Future weekly grant/);
    assert.match(markup, /New upstream terms/);
    assert.match(markup, chinese ? /保留官方原文/ : /original wording/);
    assert.match(markup, /disabled/);
  }
});

const creditData = () => ({credits:{availableCount:1,credits:[{id:'card-a',status:'available',expiresAt:'2099-01-01T00:00:00Z'}]},operation:null});

test('refresh recreates usable credit buttons after the old button is detached', async () => {
  const h=harness({api:async()=>creditData()});h.tools.setup(h.dialog);
  await h.tools.handle('refresh-credits',{disabled:false,isConnected:false});
  assert.match(h.body.innerHTML,/data-credit-index="0"/);
  assert.doesNotMatch(h.body.innerHTML,/data-credit-index="0" disabled/);
  await h.tools.handle('refresh-credits',{disabled:false,isConnected:false});
  assert.doesNotMatch(h.body.innerHTML,/data-credit-index="0" disabled/);
});

test('expired, used, unknown and invalid-expiry credits are not offered for redemption', () => {
  const h=harness();
  for(const card of [{status:'expired'},{status:'used'},{status:'mystery'},{status:'available',expiresAt:'2000-01-01'},{status:'available',expiresAt:'invalid'}]) {
    assert.match(h.tools.creditMarkup(card,0,false),/ disabled/);
  }
  assert.doesNotMatch(h.tools.creditMarkup({status:'available'},0,false),/ disabled/);
});

test('fresh definite preflight rejection clears pending, but an uncertain prior attempt survives retry rejection', async () => {
  const storage=new Map();let definite=true;
  const h=harness({storage,api:async url=>{
    if(url.endsWith('/consume')) throw Object.assign(new Error('rejected'),definite?{status:409,operationStatus:'not_submitted'}:{});
    return creditData();
  }});h.tools.setup(h.dialog);
  await assert.rejects(h.tools.consume({dataset:{}}),/rejected/);await h.tools.refreshCredits();
  assert.doesNotMatch(h.body.innerHTML,/上次操作结果待确认/);
  definite=false;await assert.rejects(h.tools.consume({dataset:{}}),/rejected/);
  definite=true;await assert.rejects(h.tools.consume({dataset:{}}),/rejected/);await h.tools.refreshCredits();
  assert.match(h.body.innerHTML,/上次操作结果待确认/);
});

test('successful redemption remains visible when follow-up quota refresh fails', async () => {
  const h=harness({api:async url=>{if(url.endsWith('/consume')) return {outcome:'reset',quotaSynced:false};throw new Error('quota offline');}});h.tools.setup(h.dialog);
  await h.tools.handle('consume',{dataset:{},isConnected:false});
  assert.match(h.body.innerHTML,/已使用，额度同步中/);assert.match(h.error.textContent,/quota offline/);
  assert.doesNotMatch(h.body.innerHTML,/使用一张/);
});

test('opening another model target removes the previous catalog', () => {
  const h=harness();h.tools.setup(h.dialog,null,'models',[{targetId:'account-a',model:'gpt-6-astra'}]);
  h.tools.modelBody('account-b');assert.doesNotMatch(h.catalog.innerHTML,/account-a|gpt-6-astra/);
});

test('a catalog reply from an old selection cannot overwrite the current target', async () => {
  let reply;const h=harness({selected:['account-a'],api:()=>new Promise(resolve=>{reply=resolve;})});h.tools.setup(h.dialog,null,'models');
  const work=h.tools.handle('catalog',{isConnected:false});
  h.selected.splice(0,1,'account-b');h.tools.resetCatalog();
  reply([{targetId:'account-a',models:[{id:'model-a'}]}]);await work;
  assert.equal(h.catalog.innerHTML,'');
});

test('missing job stops polling, clears the recovery ID and permits a new job', async () => {
  const h=harness({api:async url=>{if(url.includes('/jobs/')) throw Object.assign(new Error('gone'),{status:404});return {id:'new-job',status:'completed',items:[]};}});
  h.storage.set('navo-model-job','old-job');h.tools.setup(h.dialog,{id:'old-job',status:'running',items:[]},'models');
  await h.tools.poll('old-job');assert.equal(h.storage.get('navo-model-job'),'');assert.equal(h.timers.length,0);
  await h.tools.start([{targetId:'account-a',model:'model-a'}]);
  assert.ok(h.calls.some(call=>call.url==='/api/model-diagnostics/start'));
});

test('temporary polling errors back off instead of clearing a live job', async () => {
  const h=harness({api:async()=>{throw Object.assign(new Error('offline'),{status:503});}});h.tools.setup(h.dialog,{id:'job',status:'running',items:[]},'models');
  await h.tools.poll('job');await h.tools.poll('job');assert.deepEqual(h.timers,[2000,4000]);
  await assert.rejects(h.tools.start([{targetId:'account-a',model:'model-a'}]),/当前检测尚未结束/);
});

test('catalogs render incrementally while another target remains pending', async () => {
  let completeSlow;
  const h=harness({selected:['a','b'],accounts:[{id:'a',label:'Fast account'},{id:'b',label:'Slow account'}],api:async(url,request)=>{
    const id=JSON.parse(request.body).targetIds[0];
    if(id==='b') return new Promise(resolve=>{completeSlow=resolve;});
    return [{targetId:'a',models:[{id:'fast-model'}]}];
  }});h.tools.setup(h.dialog,null,'models');
  const work=h.tools.handle('catalog',{isConnected:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(h.catalog.innerHTML,/fast-model/);assert.match(h.catalog.innerHTML,/Fast account/);assert.match(h.catalog.innerHTML,/1\/2/);
  completeSlow([{targetId:'b',models:[{id:'slow-model'}]}]);await work;
  assert.match(h.catalog.innerHTML,/slow-model/);assert.match(h.catalog.innerHTML,/2\/2/);
});

test('result headings use account names and local dates, with original errors only in details', () => {
  const h=harness({accounts:[{id:'a',label:'Named account'}]});
  h.tools.setup(h.dialog,{status:'completed',items:[{targetId:'a',model:'test-model',state:'service_unavailable',checkedAt:'2026-01-01T01:02:03.000Z',error:'Original failure'}]},'models');h.tools.renderJob();
  assert.match(h.results.innerHTML,/<h4>Named account<\/h4>/);assert.doesNotMatch(h.results.innerHTML,/\.000Z/);
  assert.match(h.results.innerHTML,/<details>[\s\S]*Original failure[\s\S]*<\/details>/);
});

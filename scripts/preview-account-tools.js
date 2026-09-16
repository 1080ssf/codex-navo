// Isolated UI fixture: no production settings, credentials, upstream or writes.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..', 'public');
const quota = { planType: 'plus', refreshedAt: new Date().toISOString(), windows: [
  { label: '5 小时额度', windowDurationMins: 300, remainingPercent: 95, resetsAt: Date.now()/1000+10000 },
  { label: 'Weekly', windowDurationMins: 10080, remainingPercent: 24, resetsAt: Date.now()/1000+450000 },
], resetCredits: { availableCount: 1, credits: [{ id: 'fixture-credit', status: 'available', title: 'Full reset (Weekly + 5 hr)', resetType: 'codexRateLimits', description: "Thanks for using Codex! You've been granted one free rate limit reset.", expiresAt: '2099-10-01T00:00:00Z' }, { id:'expired-preview', status:'expired', title:'Full reset (Weekly + 5 hr)', expiresAt:'2000-01-01T00:00:00Z' }] } };
const accounts = [
  ...Array.from({ length: 3 }, (_, i) => ({ id: `preview-long-${i}`, label: `long-account-name-for-layout-check-${i}@example.test`, quota, enabled: true })),
  { id: 'preview-regular', label: 'demo-account@example.test', quota, codexInitialized: true, enabled: true,
    planExpiresAt: '2026-09-20T00:00:00Z', network: { mode: 'proxy', sourceId:'preview-source', nodeName:'US standalone preview', displayName:'美国 VPS · 演示线路', label: '美国 VPS · 演示线路' } },
  { id: 'preview-temporary', label: 'Temporary preview', accountKind: 'relay', quota: { ...quota, planType: 'self_serve_business_prolite' },
    codexInitialized: true, enabled: true, planExpiryStatus: 'credential_unavailable', network: { mode: 'direct' } },
];
const usage = { totals: { inputTokens: 200000000, cachedInputTokens: 192000000, outputTokens: 600000, totalTokens: 200600000,
  requests: 1600, pricedRequests: 100, unpricedRequests: 1500, estimatedCostUsd: 12 }, accounts: {} };
const apiService = { keys: [{ id: 'preview-key', name: 'API preview', enabled: true, accountIds: accounts.map(a=>a.id),
  modelAllowlist: [], backingAccounts: accounts, quota: { remainingPercent: 59 }, network: { mode: 'direct' }, usage: {} }], providers: [{id:'preview-pool',type:'navo-pool',name:'Preview pool',models:['gpt-6-astra','gpt-5.6-sol'],defaultModel:'gpt-6-astra'}], config: { enabled: true, port: 18300 } };
const networkSettings = { core: { available: true, installed: true, version: 'preview' }, sources: [
  {id:'preview-source',name:'美国 VPS · 演示线路',kind:'manual',nodes:[{name:'US standalone preview',protocol:'socks5',server:'192.0.2.1',port:1080,status:'available',connectDelay:45,delay:45}]},
  {id:'preview-subscription',name:'订阅节点 · Preview subscription',kind:'subscription',nodes:Array.from({length:12},(_,i)=>({name:`🇺🇸 US ${String(i+1).padStart(2,'0')} · Preview`,protocol:'hysteria2',status:i===2?'connection-failed':'available',connectDelay:30+i*7,delay:30+i*7}))}
], assignments: {} };
const languages = [{id:'zh-CN',label:'简体中文'},{id:'en-US',label:'English'}];
const cliState = {status:'ready',checkedAt:new Date().toISOString(),configuredPath:'',selected:{source:'npm',version:'1.2.3'},candidates:[{source:'npm',path:'C:\\Example\\Codex\\codex.exe',status:'ready',version:'1.2.3',durationMs:155,exitCode:0},{source:'path',path:'C:\\Example\\Preview\\codex.exe',status:'prerelease',version:'2.0.0-alpha.1',durationMs:133,exitCode:0}]};
const desktopFixture = `window.codexUpdater = {
  getState:async()=>({status:'current',currentVersion:'1.2.146',checkedAt:new Date().toISOString()}),
  onState:()=>{},getCodexState:async()=>({status:'current',installed:true,version:'26.9.1',latestVersion:'26.9.1',checkedAt:new Date().toISOString(),updateAvailable:false}),
  checkCodex:async()=>({status:'current',installed:true,version:'26.9.1',latestVersion:'26.9.1',checkedAt:new Date().toISOString(),updateAvailable:false}),
  check:async()=>({status:'current',currentVersion:'1.2.146'}),onCodexState:()=>{}
};
(() => {
  let settings={enabled:true,theme:'glass',opacity:92,pinned:false}; const listeners=[];
  window.codexFloating={getSettings:async()=>({...settings}),onSettings:fn=>listeners.push(fn),onLocale:()=>{},setExpanded:async()=>{},resize:async height=>({width:400,height}),
    updateSettings:async patch=>{settings={...settings,...patch};listeners.forEach(fn=>fn({...settings}));return {...settings};},
    show:async()=>({...settings,enabled:true}),hide:async()=>({...settings,enabled:false})};
})();`;
const scenarios = ['default','network-mixed','network-empty','wake-failed','floating-stale','floating-partial','floating-none','floating-switch','floating-offline','launch-running','launch-complete','launch-error','backups-empty','backups-legacy','backups-error'];
function createFixture(name) {
  const fixture = {accounts:structuredClone(accounts),apiService:structuredClone(apiService),networkSettings:structuredClone(networkSettings),
    wakeSettings:{enabled:false,mode:'daily',dailyTime:'09:00',prompt:'Reply OK.',model:'gpt-6-astra',reasoningEffort:'low'},
    startedAt:new Date().toISOString(),floatingReads:0,launchProgress:{active:false,stage:'idle'}};
  if(name==='network-empty') fixture.networkSettings.sources=[];
  if(name==='network-mixed') {
    const states=['available','checking','unsupported-region','cloudflare-protected','blocked','rate-limited','connection-failed','tls-failed'];
    fixture.networkSettings.sources[1].nodes.forEach((node,i)=>{node.status=states[i%states.length];node.error=['connection-failed','tls-failed'].includes(node.status)?'Preview only: long connection failure details / 这是用于检查错误换行的假数据。':'';});
  }
  if(name==='wake-failed') fixture.accounts.find(a=>a.id==='preview-regular').wake={lastWakeStatus:'failed',lastWakeError:'Preview only: upstream connection timed out / 假数据：连接超时',running:false};
  if(name.startsWith('launch-')) {
    const stage=name.slice(7);
    fixture.launchProgress={active:stage==='running',stage:stage==='running'?'opening':stage,percent:stage==='running'?92:stage==='complete'?100:35,
      startedAt:fixture.startedAt,completedAt:stage==='complete'?fixture.startedAt:null,label:'demo-account@example.test',
      message:stage==='running'?'正在等待 Codex 窗口…':stage==='complete'?'Codex 已打开':'Preview only: launch failed / 假数据：启动失败'};
    if(stage==='complete') fixture.accounts.find(account=>account.id==='preview-regular').codexActive=true;
  }
  return fixture;
}
function fixtureFloating(fixture,name) {
  const stale=name==='floating-stale'||name==='floating-partial';
  const quotaAt=stale?new Date(Date.now()-7200000).toISOString():quota.refreshedAt;
  const data={account:{id:'preview-regular',label:'Demo account · example.test',type:'account',planType:'plus',quotaWindows:quota.windows,
    quotaSync:{status:stale?'stale':'fresh',lastSucceededAt:quotaAt,lastAttemptedAt:fixture.startedAt,accountCount:1,syncedAccountCount:1}},
    usage:{input:25600,cachedInput:24000,output:1500,estimatedCostUsd:1.25},task:{id:'preview-task',turnId:'preview-turn',title:'隔离的预览任务 · Preview task',status:'running',project:'Preview project',usage:{input:8000,cachedInput:7500,output:100}},updatedAt:new Date().toISOString()};
  if(name==='floating-partial') Object.assign(data.account,{id:'preview-key',type:'api',label:'Partial pool / 部分同步账号池',quotaSync:{...data.account.quotaSync,status:'failed',partial:true,accountCount:3,syncedAccountCount:2,failedAccountCount:1}});
  if(name==='floating-none') {data.account={id:null,type:'none',label:'Codex not running',quotaWindows:[],quotaSync:{status:'never'}};data.task=null;data.usage={input:0,cachedInput:0,output:0};}
  if(name==='floating-switch'&&fixture.floatingReads++%2) data.task={id:'preview-task-b',turnId:'preview-turn-b',title:'另一根任务 · Second root task',status:'waiting_input',project:'Second preview project',usage:{input:94500,cachedInput:92000,output:800}};
  return data;
}
function createPreviewServer() { const fixtures=new Map();return http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (data) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data })); };
  const reject = (status, error, details = {}) => { res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error,...details})); };
  let requested=url.searchParams.get('fixture');
  if(!requested&&req.headers.referer) {try {requested=new URL(req.headers.referer).searchParams.get('fixture');} catch {}}
  const scenario=scenarios.includes(requested)?requested:'default';
  if(!fixtures.has(scenario)) fixtures.set(scenario,createFixture(scenario));
  const fixture=fixtures.get(scenario);
  const {accounts,apiService,networkSettings,wakeSettings}=fixture;
  let body = {};
  try { let raw=''; for await(const chunk of req) { raw+=chunk; if(raw.length>1024*1024) return reject(413,'Preview request is too large'); } if(raw) body=JSON.parse(raw); }
  catch { return reject(400,'Invalid preview JSON'); }
  if (url.pathname === '/api/bootstrap') return json({ accounts, apiService, usage, csrfToken:'preview-only', operators: ['preview'], mockLaunch: true, appVersion: 'preview', codexRunning:accounts.some(account=>account.codexActive)||Boolean(apiService.activeKeyId), wakeSettings, wakeModelOptions:[{slug:'gpt-6-astra',displayName:'GPT 6 Astra (fixture)',reasoningEfforts:['low','medium','high','xhigh'],defaultReasoningEffort:'low'}], proxySettings:{enabled:false}, networkSettings });
  if (url.pathname === '/api/usage') return json(usage);
  if (url.pathname === '/api/api-service') return json(apiService);
  if (url.pathname === '/api/api-service/keys' && req.method === 'POST') return json({secret:'sk-navo-PREVIEW-ONLY-NOT-A-VALID-KEY-000000000000000000000000',state:apiService});
  if (url.pathname === '/api/network-state') return json(networkSettings);
  if (url.pathname === '/api/wake-settings' && req.method === 'POST') {Object.assign(wakeSettings,body);return json(wakeSettings);}
  if (/^\/api\/accounts\/[^/]+\/wake$/.test(url.pathname)||url.pathname==='/api/wake-all'||/^\/api\/api-service\/keys\/[^/]+\/wake$/.test(url.pathname)) return reject(403,'Preview only: wake requests are never sent / 预览不发送唤醒请求');
  if (url.pathname === '/api/api-service/models/detect') return json((body.accountIds||[]).length?[{id:'gpt-6-astra',label:'GPT 6 Astra',supportedAccounts:body.accountIds.length,totalAccounts:body.accountIds.length},{id:'gpt-5.6-sol',label:'GPT 5.6 Sol',supportedAccounts:1,totalAccounts:body.accountIds.length}]:[]);
  const nodeTest=url.pathname.match(/^\/api\/network\/sources\/([^/]+)\/(test|test-all|refresh)$/);
  if(nodeTest) {
    const source=networkSettings.sources.find(source=>source.id===nodeTest[1]);
    if(!source) return reject(404,'Preview source not found');
    const node=source.nodes.find(node=>node.name===body.nodeName)||source.nodes[0];
    const ok=['available','cloudflare-protected'].includes(node?.status);
    return json({networkSettings,source,ok,message:ok?'Preview only: connection available / 假数据：连接可用':'Preview only: connection failed / 假数据：连接失败',connectLatencyMs:node?.connectDelay,
      available:source.nodes.filter(node=>node.status==='available').length,unsupported:source.nodes.filter(node=>node.status==='unsupported-region').length,failed:source.nodes.filter(node=>!['available','unsupported-region'].includes(node.status)).length});
  }
  if (/^\/api\/(?:accounts\/[^/]+|api-service\/keys\/[^/]+)\/network$/.test(url.pathname)) {
    const target=url.pathname.includes('/accounts/')?accounts.find(a=>url.pathname.includes(`/${a.id}/`)):apiService.keys.find(key=>url.pathname.includes(`/${key.id}/`));
    const source=networkSettings.sources.find(source=>source.id===body.sourceId);
    if(target) target.network={mode:body.mode,sourceId:source?.id,nodeName:body.nodeName,displayName:source?.kind==='manual'?source.name:body.nodeName,label:source?.name||'Direct'};
    return json({networkSettings});
  }
  if (/^\/api\/(?:accounts\/[^/]+|api-service\/keys\/[^/]+)\/launch$/.test(url.pathname)) {
    const failed=scenario==='launch-error';
    fixture.launchProgress={...fixture.launchProgress,active:false,stage:failed?'error':'complete',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),percent:failed?35:100,label:'Preview account',message:failed?'Preview only: launch failed / 假数据：启动失败':'Codex 已打开'};
    if(!failed&&body.launchType!=='browser') {
      if(url.pathname.includes('/api-service/')) apiService.activeKeyId='preview-key';
      else {const account=accounts.find(account=>url.pathname.includes(`/${account.id}/`));if(account) account.codexActive=true;}
    }
    return failed?reject(502,fixture.launchProgress.message):json(url.pathname.includes('/api-service/')?apiService:accounts.find(a=>a.id==='preview-regular'));
  }
  if (url.pathname === '/api/codex-launch-options') return json({languages,defaultLanguage:'zh-CN',projects:[{id:'preview-project',label:'布局检查 · Layout preview',roots:['C:\\Example\\Project'],threads:[{id:'preview-thread',title:'用于测试长会话标题的隔离样本 · Long task title',cwd:'C:\\Example\\Project',sizeBytes:102400}]}],threadCount:1,oversizedThreadCount:0});
  if (url.pathname === '/api/codex-rollout-backups') return scenario==='backups-error'?reject(503,'Preview only: backup metadata unavailable / 假数据：备份信息暂不可用'):json(scenario==='backups-empty'?[]:[{id:'preview.jsonl.bak',conversationFile:'rollout-preview-with-long-title-00000000000000.jsonl',createdAt:'2026-09-15T00:00:00Z',beforeBytes:700*1024*1024,afterBytes:200*1024*1024,backupBytes:700*1024*1024,durationMs:2500,checksumAvailable:scenario!=='backups-legacy'}]);
  if (url.pathname === '/api/codex-rollout-backups/storage') return json({backupRootBytes:scenario==='backups-empty'?0:700*1024*1024,backupCount:scenario==='backups-empty'?0:1,freeBytes:100*1024*1024*1024});
  if (url.pathname === '/api/codex-rollout-backups/restore') return reject(403,'Preview only: no files are restored / 预览不恢复文件');
  if (url.pathname === '/api/floating-status' || url.pathname === '/api/floating-status/refresh') return scenario==='floating-offline'?reject(503,'Preview offline'):json(fixtureFloating(fixture,scenario));
  if (url.pathname === '/api/sessions') return json({connected:false,tasks:[],counts:{running:0,waiting:0,completed:0,failed:0,total:0}});
  if (url.pathname === '/api/codex-launch-progress') return json(fixture.launchProgress);
  if (url.pathname === '/api/notification-events') return json([]);
  if (url.pathname === '/api/notification-settings') return json({enabled:false,systemNotification:false,sound:'none',volume:0,customSounds:[],notifyCompleted:true,notifyFailed:true,notifyWaiting:false});
  if (url.pathname === '/api/cli-state' || url.pathname === '/api/cli-diagnostics') return json(cliState);
  if (url.pathname === '/api/cli-settings') return json({...cliState,configuredPath:String(body.path||'')});
  if (url.pathname.endsWith('/reset-credits')) return json({ credits: quota.resetCredits, quota, operation: null });
  if (url.pathname.endsWith('/consume')) return reject(403,'预览不会兑换重置卡 / Preview never redeems credits',{operationStatus:'not_submitted'});
  if (url.pathname === '/api/model-diagnostics/catalog') return json((body.targetIds||[]).map(id=>({targetId:id,models:[{id:'gpt-6-astra',accountId:id},{id:'gpt-5.6-sol',accountId:id}]})));
  if (url.pathname.startsWith('/api/model-diagnostics/jobs/')) return reject(404,'Preview job no longer exists');
  if (url.pathname === '/api/model-diagnostics/start') return reject(403,'预览不会发送模型请求 / Preview never sends model requests');
  if (url.pathname.startsWith('/api/')) return reject(404,'Endpoint is not implemented in the isolated preview');
  if (url.pathname === '/preview') {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end(`<!doctype html><html><head><title>Navo isolated preview scenarios</title></head><body><h1>隔离假数据 / Isolated fixtures</h1><p>仅内存状态；不会启动 Codex、探测真实网络、发模型请求或恢复文件。</p><ul>${scenarios.map(name=>`<li><a href="/?fixture=${name}">${name} · Main</a> | <a href="/floating.html?fixture=${name}">Floating</a></li>`).join('')}</ul></body></html>`);
  }
  if (url.pathname === '/preview-desktop.js') { res.setHeader('Content-Type','text/javascript');return res.end(desktopFixture); }
  const file = path.resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.statusCode=404; return res.end(); }
  res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)] || 'application/octet-stream');
  if(file===path.join(root,'index.html')) return res.end(fs.readFileSync(file,'utf8').replace('<script src="/app.js"','<script src="/preview-desktop.js"></script><script src="/app.js"'));
  if(file===path.join(root,'floating.html')) return res.end(fs.readFileSync(file,'utf8').replace('<script src="/floating.js"','<script src="/preview-desktop.js"></script><script src="/floating.js"'));
  fs.createReadStream(file).pipe(res);
}); }
if (require.main === module) createPreviewServer().listen(0, '127.0.0.1', function () { console.log(`Preview http://127.0.0.1:${this.address().port}`); });
module.exports = { createPreviewServer };

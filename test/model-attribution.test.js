const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ModelDiagnostics, inspectProbeResponse } = require('../lib/model-diagnostics');
const root = path.join(__dirname, '..');

test('attribution route schedules three confirmed requests with account locks and permits active accounts', async () => {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const from = source.indexOf("    if (request.method === 'POST' && url.pathname === '/api/model-attribution/run')");
  const to = source.indexOf('    const diagnosticJobMatch', from);
  let calls = 0;
  const route = vm.runInNewContext(`(async (request,response,url)=>{${source.slice(from,to)}})`, {
    readBody: async req => req.body, sendJson: (_, status, body) => ({status, body}), sendError: (_, status, error) => ({status,error}),
    diagnosticTarget: () => ({members:[{id:'real-a'}]}), crypto: {randomUUID:()=>String(++calls)},
    modelDiagnostics: {start:items=>items}
  });
  const body = {confirmed:true,targetId:'api-key:test',model:'gpt-6-astra',challenges:Array.from({length:3},()=>({prompt:'number challenge '.repeat(10),expected_count:300}))};
  const run = body => route({method:'POST',body},{},{pathname:'/api/model-attribution/run'});
  assert.equal((await run({...body,confirmed:false})).status,400);
  assert.equal(calls,0);
  assert.equal((await run({...body,challenges:[]})).status,400);
  const result = await run(body);
  assert.equal(result.status,200);
  assert.equal(result.body.data.length,3);
  for (const item of result.body.data) { assert.equal(item.allowBusy,true);assert.equal(item.lockIds[0],'real-a');assert.equal(item.expected_count,300); }
  assert.equal(new Set(result.body.data.map(item=>item.requestId)).size,3);
});

test('done-only SSE responses yield text without duplicates; incomplete model mismatch is not a sample', async () => {
  const sse = events => new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));
  const out = await inspectProbeResponse(sse([
    {type:'response.output_text.done',text:'12 34 56'},
    {type:'response.output_item.done',item:{content:[{type:'output_text',text:'12 34 56'}]}},
    {type:'response.completed',response:{status:'completed',output:[]}}
  ]));
  assert.equal(out.outputText,'12 34 56');assert.equal(out.state,'available');
  const incomplete = await inspectProbeResponse(sse([{type:'response.created',response:{model:'other'}},{type:'response.output_text.delta',delta:'1 2 3'}]),{expectedModel:'requested'});
  assert.equal(incomplete.state,'incomplete');
});

function ui(api) {
  const body = {innerHTML:''};
  const dialog = {open:true,innerHTML:'',querySelector:()=>body,querySelectorAll:()=>[{value:'b'}]};
  const tasks = [], calls = [];
  const ctx = {window:{},document:{addEventListener(){},querySelectorAll:()=>[],querySelector:()=>null},
    state:{accounts:[{id:'a',label:'Account A'},{id:'b',label:'Account B'}]},navoUsesChinese:()=>true,escapeHtml:String,
    sessionStorage:{getItem:()=>null},setTimeout:fn=>tasks.push(fn),clearTimeout(){},
    api:async(url,options)=>{calls.push({url,body:JSON.parse(options?.body||'{}')});return api(url,options);}};
  const src = fs.readFileSync(path.join(root,'public/account-tools.js'),'utf8').replace('window.NavoAccountTools = { decorate };',
    'window.NavoAccountTools = { handle, attributionRun, attributionPoll, attributionLoadModels, set(s,d) { attributionState=s; dialog=d; mode="attribution"; }, get:()=>attributionState };');
  vm.runInNewContext(src,ctx);
  return {tools:ctx.window.NavoAccountTools,dialog,body,tasks,calls};
}
test('top toolbar uses selected account and loads dropdown without generating a request', async () => {
  const h = ui(async()=>[{models:[{id:'model-a'},{id:'model-b'}]}]);
  h.tools.set({runtime:null,loading:false},h.dialog);
  await h.tools.handle('attribution',{});
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.targetIds[0],'b');
  assert.match(h.body.innerHTML,/<select name="attribution-model"/);
  assert.match(h.body.innerHTML,/model-a/);assert.match(h.body.innerHTML,/model-b/);
  assert.doesNotMatch(h.body.innerHTML,/<input|<pre|attribution-new|attribution-copy/);
});
test('double click submits once; failures show HTTP status instead of entering fingerprint analysis', async () => {
  let resolve;let analyses=0;
  const h=ui(async url=>url==='/api/model-attribution/run'?new Promise(r=>resolve=r):{id:'job',status:'completed',items:[{state:'rate_limited',httpStatus:429},{state:'cooldown'}]});
  h.tools.set({targetId:'b',model:'model-b',models:['model-b'],loading:false,runtime:{generateChallenges:()=>[1,2,3],analyzeGlobalOutputs:()=>analyses++}},h.dialog);
  const first=h.tools.attributionRun();await Promise.resolve();await h.tools.attributionRun();
  assert.equal(h.calls.filter(c=>c.url==='/api/model-attribution/run').length,1);
  resolve({id:'job',status:'running',items:[]});await first;
  await new Promise(r=>setImmediate(r));
  assert.equal(analyses,0);assert.match(h.body.innerHTML,/429/);assert.equal(h.tools.get().loading,false);
});
test('completed samples only reach local inference; closing dialog does not lose the pending job', async () => {
  let outputs;
  const h=ui(async()=>({id:'job',status:'completed',items:[{state:'available',outputText:'1 2 3',expected_count:300},{state:'incomplete',outputText:'partial'},{state:'failed'}]}));
  h.dialog.open=false;
  h.tools.set({loading:true,job:{id:'job'},runtime:{analyzeGlobalOutputs:o=>{outputs=o;return {results:[],used_outputs:1,probability:0.5};}}},h.dialog);
  await h.tools.attributionPoll();assert.equal(outputs.length,1);assert.equal(outputs[0].text,'1 2 3');assert.equal(h.tools.get().loading,false);
});
test('bundled reference bank and algorithm produce finite closed-set probabilities', async () => {
  const core=await import('data:text/javascript;base64,'+fs.readFileSync(path.join(root,'public/modeltrace/fingerprint-core.js')).toString('base64'));
  const bank=JSON.parse(fs.readFileSync(path.join(root,'public/modeltrace/data/unified_bank.json'),'utf8'));
  const result=core.analyzeGlobalOutputs([{expected_count:300,text:Array.from({length:300},(_,i)=>1+i%355).join(' ')}],bank);
  assert.equal(result.used_outputs,1);assert.ok(result.results.length>1);
  assert.ok(Math.abs(result.results.reduce((sum,r)=>sum+r.probability,0)-1)<1e-9);
  assert.throws(()=>core.analyzeGlobalOutputs([{text:'No valid response'}],bank));
});

test('three upstream model fields are aggregated separately from fingerprint probability', () => {
  const items = [{ actualModel: 'gpt-6-astra' }, { actualModel: 'gpt-6-astra' }, { actualModel: 'gpt-5.6-sol' }];
  const counts = new Map(items.map(item => [item.actualModel, 0]));
  items.forEach(item => counts.set(item.actualModel, counts.get(item.actualModel) + 1));
  const actual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  assert.deepEqual(actual, ['gpt-6-astra', 2]);
  assert.notEqual(actual[0], 'fingerprint probability');
});

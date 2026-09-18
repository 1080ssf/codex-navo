const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  const changes=[];let reads=0;
  const makeSession=name=>({setProxy:async value=>changes.push({name,...value}),closeAllConnections:async()=>changes.push({name,closed:true})});
  const navo=makeSession('navo'),codex=makeSession('codex');
  const context=vm.createContext({autoUpdater:{netSession:navo},session:{fromPartition:()=>codex},
    requestLocalJson:async()=>{reads++;return {proxyUrl:'http://127.0.0.1:18302',nodeName:'Configured proxy'};}});
  const source=fs.readFileSync(path.join(__dirname,'../desktop-src/main.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('const configuredUpdateRoutes ='),source.indexOf('async function ensureServer(')),context);
  return {context,navo,codex,changes,reads:()=>reads,run:(target,signal)=>context.configureUpdaterNetwork(target,signal)};
}

test('Codex checks and downloads always use explicit direct mode without preparing a proxy',async()=>{
  const h=harness();h.context.requestLocalJson=async()=>{throw Error('Must not prepare proxy for Codex');};
  const route=await h.run(h.codex);
  assert.equal(route.proxyUrl,'');assert.equal(route.nodeName,'直连');
  assert.deepEqual(h.changes,[{name:'codex',mode:'direct'},{name:'codex',closed:true}]);
  await h.run(h.codex);assert.equal(h.changes.length,2,'reuse explicit session routing');
});

test('Navo GitHub checks and downloads require the configured proxy, including retries',async()=>{
  const h=harness();await h.run(h.navo);await h.run(h.navo);
  assert.equal(h.reads(),2);assert.equal(h.changes[0].mode,'fixed_servers');
  assert.equal(h.changes[0].proxyRules,'http://127.0.0.1:18302');
  h.context.requestLocalJson=async()=>({proxyUrl:'http://127.0.0.1:18303'});
  await h.run(h.navo);assert.equal(h.changes[2].proxyRules,'http://127.0.0.1:18303');
  assert.equal(h.changes.some(change=>change.mode==='direct'),false);
});

test('missing or failed Navo proxy never silently falls back to direct GitHub',async()=>{
  const h=harness();h.context.requestLocalJson=async()=>({});
  await assert.rejects(h.run(h.navo),/No proxy is available/);
  h.context.requestLocalJson=async()=>{throw Error('Proxy preparation failed');};
  await assert.rejects(h.run(h.navo),/Proxy preparation failed/);
  assert.equal(h.changes.length,0);
});

test('cancelled preparation does not reconfigure a session',async()=>{
  const h=harness(),controller=new AbortController();
  h.context.requestLocalJson=async()=>{controller.abort(new Error('cancelled'));return {proxyUrl:'http://127.0.0.1:18302'};};
  await assert.rejects(h.run(h.navo,controller.signal),/cancelled/);
  assert.equal(h.changes.length,0);
});

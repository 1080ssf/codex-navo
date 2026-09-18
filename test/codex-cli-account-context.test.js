const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

test('a managed CLI retains the supplied account home and proxy in quota/model/reset/warmup operations', async () => {
  const calls=[];
  const context={ module:{exports:{}},process,setTimeout,clearTimeout,Buffer,require:name=>{
    if(name!=='node:child_process')return require(name);
    return {spawn:(executable,args,options)=>{
      calls.push({executable,args,options});
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
      child.exitCode=0;child.signalCode=null;
      queueMicrotask(()=>child.emit('error',new Error('fixture: stop before any account request')));
      return child;
    }};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/codex-quota.js'),'utf8'),context);
  const api=context.module.exports;
  const executable='C:\\Navo\\data\\cli-runtime\\stable-1.2.3-test\\codex.exe';
  const accountHome='C:\\Navo\\profiles\\account-original';
  const environment={HTTPS_PROXY:'http://127.0.0.1:18301',CODEX_HOME:'ignored-inherited-home',CUSTOM:'keep'};
  for(const operation of [()=>api.readCodexQuota(executable,accountHome,1000,environment),
    ()=>api.readCodexModels(executable,accountHome,1000,environment),
    ()=>api.consumeCodexResetCredit(executable,accountHome,{idempotencyKey:'fixture-only',timeoutMs:1000},environment),
    ()=>api.warmCodexAppServer(executable,accountHome,1000,environment)]) {
    await assert.rejects(operation(),/fixture: stop/);
  }
  assert.equal(calls.length,4);
  for(const call of calls){
    assert.equal(call.executable,executable);assert.equal(call.options.env.CODEX_HOME,accountHome);
    assert.equal(call.options.env.HTTPS_PROXY,environment.HTTPS_PROXY);assert.equal(call.options.env.CUSTOM,'keep');
    assert.equal(call.options.windowsHide,true);assert.ok(call.args.includes('app-server'));assert.ok(!call.args.includes('--stdio'));
  }
  assert.equal(environment.CODEX_HOME,'ignored-inherited-home','the caller environment is not mutated');
});

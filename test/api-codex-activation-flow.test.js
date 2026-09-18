const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {withTaskProxy}=require('../lib/codex-launch-network');

function harness(options={}) {
  const events=[],writes=[];
  const home='fixture-account-home', env={CODEX_HOME:home,OPENAI_API_KEY:'fixture-key',HTTPS_PROXY:'http://127.0.0.1:18301'};
  const state={language:options.localeFailure?'zh-CN':'en-US',threadIds:[],projectIds:[]};
  const context={path,process:{env:{}},Date,Boolean,String,fs:{existsSync:()=>false,readFileSync:()=> 'model_provider="codex_navo"\n',writeFileSync:(_file,text)=>writes.push(text)},
    findRunningCodexDesktopPid:()=>0,beginCodexLaunchTransaction:()=>events.push('begin'),endCodexLaunchTransaction:()=>events.push('end'),
    setCodexLaunchProgress:value=>events.push(`progress:${value.percent}`),prepareApiKeyNetwork:async()=>({}),
    restoreStoppedLaunchStateBeforeCatalog:()=>{},repairSharedCodexPreferences:()=>{},listCodexLaunchOptions:()=>({}),normalizeLaunchSelection:()=>state,
    SHARED_CODEX_HOME:home,ACTIVE_API_CODEX_FILE:'fixture-active',readJson:()=>null,
    apiServiceManager:{issueLaunchSecret:()=>({record:{modelAllowlist:['model']},secret:'fixture-key'}),accountPool:()=>({})},
    prepareApiKeyCodexHome:()=>({codexHomeDir:home,status:'launching'}),findCodexDesktop:()=>({executable:'fixture.exe',appUserModelId:options.noId?'':'OpenAI.Codex_test!App'}),
    apiKeyTaskEnvironment:async()=>env,apiCodexEnvironment:()=>env,prepareStableApiCodexProxy:async()=>18301,stableApiCodexProxyEnvironment:()=>env,
    warmCodexAppServer:async()=>{events.push('warm');return {elapsedMs:1};},findCodexCli:async()=> 'fixture-cli.exe',reserveLoopbackPort:async()=>12345,
    spawnDetached:async()=>{events.push('direct');if(options.directSuccess)return 42;throw Object.assign(new Error('spawn failed'),{code:options.code||'EPERM'});},
    activatePackagedApp:async(id,args,environment)=>{
      events.push('activation');assert.equal(environment,env);assert.ok(args.includes('--proxy-server=http://127.0.0.1:18301'));
      if(options.activationFailure)throw new Error('activation failed');return 42;
    },
    waitForCodexDesktop:async()=>{events.push('wait');return options.noWindow?null:42;},
    applyDesktopLocaleBridge:async()=>{throw new Error('optional locale failure');},
    detectCodexDesktopSnapshot:()=>({pid:options.noWindow?null:42}),codexProcessIdentity:value=>value,
    writeJsonAtomic:(_file,value)=>{events.push(`record:${value.status}`);},audit:()=>{},withTaskProxy,
    isProcessAlive:()=>false,restoreApiKeyCodexHome:()=>events.push('restore'),
  };
  const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  const start=source.indexOf('async function launchApiKeyCodex('),end=source.indexOf('\nfunction stopApiKeyCodex',start);
  vm.runInNewContext(source.slice(start,end)+'\nthis.launch=launchApiKeyCodex;',context);
  return {events,writes,launch:()=>context.launch('fixture-key-id')};
}

test('API permission failure takes system activation with proxy arguments and retains auth until a window is confirmed',async()=>{
  const h=harness();assert.equal(await h.launch(),42);
  assert.ok(h.events.indexOf('warm')<h.events.indexOf('direct'));
  assert.ok(h.events.indexOf('activation')<h.events.indexOf('wait'));
  assert.ok(h.events.indexOf('wait')<h.events.indexOf('record:running'));
  assert.ok(!h.events.includes('restore'));assert.equal(h.events.filter(e=>e==='end').length,1);
  assert.match(h.writes[0],/HTTPS_PROXY = "http:\/\/127.0.0.1:18301"/);assert.doesNotMatch(h.writes[0],/fixture-key/);
});
test('direct API startup does not invoke activation or edit fallback proxy settings',async()=>{
  const h=harness({directSuccess:true});assert.equal(await h.launch(),42);assert.ok(!h.events.includes('activation'));assert.equal(h.writes.length,0);
});
test('API activation errors and absent windows restore the original state only after checking for delayed startup',async()=>{
  const h=harness({activationFailure:true,noWindow:true});await assert.rejects(h.launch(),/activation failed/);
  assert.ok(h.events.indexOf('wait')<h.events.indexOf('restore'));assert.equal(h.events.filter(e=>e==='end').length,1);
});
test('API non-permission failures or missing app identifiers do not blindly activate an unrelated app',async()=>{
  for(const options of [{code:'ENOENT'},{noId:true}]){const h=harness(options);await assert.rejects(h.launch(),/spawn failed/);assert.ok(!h.events.includes('activation'));assert.ok(h.events.includes('restore'));}
});
test('optional locale failure does not turn an activated API desktop into a failed launch',async()=>{
  const h=harness({localeFailure:true});assert.equal(await h.launch(),42);assert.ok(!h.events.includes('restore'));
});

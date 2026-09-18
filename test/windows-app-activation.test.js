const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {activatePackagedApp,activationScript,quoteArgument}=require('../lib/windows-app-activation');

test('Windows activation keeps proxy/language arguments and never embeds the API key in its script',async()=>{
  const env={OPENAI_API_KEY:'fixture-secret',CODEX_HOME:'fixture-home'};
  const args=['--proxy-server=http://127.0.0.1:18301','--lang=zh-CN','--remote-debugging-port=12345'];
  const pid=await activatePackagedApp('OpenAI.Codex_test!App',args,env,{spawnProcess:(exe,argv,options)=>{
    assert.equal(exe,'powershell.exe');assert.equal(options.windowsHide,true);assert.equal(options.env,env);
    const script=Buffer.from(argv.at(-1),'base64').toString('utf16le');
    assert.doesNotMatch(script,/fixture-secret/);assert.match(script,/ActivateApplication/);
    const encoded=script.match(/FromBase64String\('([^']+)'\)/)[1];
    const payload=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
    for(const arg of args)assert.ok(payload.args.includes(arg));
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    queueMicrotask(()=>{child.stdout.write('1234\r\n');child.emit('close',0);});return child;
  }});
  assert.equal(pid,1234);
});

test('invalid activation identifiers and failed activations cannot report success',async()=>{
  assert.throws(()=>activationScript('bad;command',[]),/应用标识/);
  await assert.rejects(activatePackagedApp('OpenAI.Codex_test!App',[],{}, {spawnProcess:()=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    queueMicrotask(()=>child.emit('close',1));return child;
  }}),/系统激活失败/);
});

test('activation command-line quoting keeps spaces, embedded quotes and trailing slashes intact',()=>{
  assert.equal(quoteArgument('two words'),'"two words"');
  assert.equal(quoteArgument('a"b'),'"a\\"b"');
  assert.equal(quoteArgument('C:\\path\\'),'"C:\\path\\\\"');
});

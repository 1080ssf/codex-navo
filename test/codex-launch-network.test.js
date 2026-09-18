const test=require('node:test');
const assert=require('node:assert/strict');
const {withTaskProxy,removeTaskProxy}=require('../lib/codex-launch-network');
test('brokered launch proxy overrides retain other task environment and never copy API credentials',()=>{
  const result=withTaskProxy('[shell_environment_policy.set]\nKEEP="value"\nHTTP_PROXY="old"\n',{HTTP_PROXY:'http://127.0.0.1:18301',OPENAI_API_KEY:'do-not-copy'});
  assert.match(result,/KEEP="value"/);assert.match(result,/HTTP_PROXY = "http:\/\/127.0.0.1:18301"/);
  assert.doesNotMatch(result,/old|do-not-copy|OPENAI_API_KEY/);
  const restored=removeTaskProxy(result);assert.match(restored,/KEEP="value"/);assert.doesNotMatch(restored,/18301|HTTP_PROXY/);
});
test('inline task environment tables preserve quoted commas and unrelated values without duplicate table definitions',()=>{
  const result=withTaskProxy('[shell_environment_policy]\ninherit="all"\nset = { KEEP="a,b", HTTPS_PROXY="old" }\n[desktop]\nx=true\n',{HTTPS_PROXY:'http://127.0.0.1:18301'});
  assert.match(result,/KEEP="a,b"/);assert.doesNotMatch(result,/\[shell_environment_policy.set\]|old/);
  assert.match(result,/\[desktop\]/);assert.match(result,/HTTPS_PROXY = "http:\/\/127.0.0.1:18301"/);
});

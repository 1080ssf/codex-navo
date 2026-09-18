const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {chatgptAuth,canSaveChatgptAuth,chatgptEnvironment,chatgptConfig}=require('../lib/codex-launch-auth');
const {prepareLaunchView,restoreLaunchView}=require('../lib/codex-launch-view');
const auth=id=>({auth_mode:'api',OPENAI_API_KEY:'stale-key',tokens:{account_id:id,access_token:'a'.repeat(30),refresh_token:'r'.repeat(30)}});

test('regular launch rejects API-only credentials and strips stale API-key login mode from OAuth data',()=>{
  assert.throws(()=>chatgptAuth({OPENAI_API_KEY:'x'.repeat(30)}),/重新授权/);
  const original=auth('account-a');const normalized=chatgptAuth(original);
  assert.equal(normalized.auth_mode,'chatgpt');assert.equal(normalized.OPENAI_API_KEY,null);
  assert.equal(original.OPENAI_API_KEY,'stale-key');assert.equal(normalized.tokens.account_id,'account-a');
});

test('regular credential writeback refuses API logins and another ChatGPT account',()=>{
  assert.equal(canSaveChatgptAuth(auth('a'),{OPENAI_API_KEY:'x'.repeat(30)}),false);
  assert.equal(canSaveChatgptAuth(auth('a'),auth('b')),false);
  assert.equal(canSaveChatgptAuth(auth('a'),auth('a')),true);
  assert.equal(canSaveChatgptAuth(auth(''),auth('')),false);
});

test('ordinary launch environment removes inherited API identity but retains its proxy and home',()=>{
  const env={CODEX_HOME:'account-home',HTTPS_PROXY:'http://127.0.0.1:18301',OPENAI_API_KEY:'stale',openai_base_url:'https://example.test',OTHER:'keep'};
  assert.deepEqual(chatgptEnvironment(env),{CODEX_HOME:'account-home',HTTPS_PROXY:env.HTTPS_PROXY,OTHER:'keep'});
  assert.equal(env.OPENAI_API_KEY,'stale');
});

test('ordinary config selects built-in ChatGPT, overriding API providers and profile auth overrides',()=>{
  const output=chatgptConfig('model_provider="codex_navo"\ncli_auth_credentials_store="keyring"\nforced_login_method="api"\n[model_providers.codex_navo]\nexperimental_bearer_token="stale"\n[profiles.work]\nmodel_provider="codex_navo"\nmodel="gpt-6-astra"\n[desktop]\nlocale="en-US"');
  assert.match(output,/model_provider = "openai"/);assert.match(output,/forced_login_method = "chatgpt"/);
  assert.doesNotMatch(output,/codex_navo|stale|keyring/);assert.match(output,/model="gpt-6-astra"/);assert.match(output,/\[desktop\]/);
});

test('regular launch temporarily replaces API identity config and restores original bytes on exit',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'navo-auth-mode-test-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const original='model_provider="codex_navo"\n[model_providers.codex_navo]\nbase_url="http://localhost:18300/v1"\n';
  fs.writeFileSync(path.join(root,'config.toml'),original);
  const record=prepareLaunchView(root,path.join(root,'backup'),{language:'en-US',threadIds:[],projectIds:[]},{manageConfig:true,modelProvider:'openai'});
  assert.match(fs.readFileSync(path.join(root,'config.toml'),'utf8'),/forced_login_method = "chatgpt"/);
  restoreLaunchView(record);assert.equal(fs.readFileSync(path.join(root,'config.toml'),'utf8'),original);
});

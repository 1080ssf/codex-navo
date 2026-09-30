const assert = require('node:assert/strict');
const test = require('node:test');
const { exportCliProxyApi, exportSub2Api } = require('../lib/auth-export');

function auth() {
  return { tokens: {
    access_token: 'access-token-value-that-is-long-enough',
    refresh_token: 'refresh-token-value-that-is-long-enough',
    id_token: 'id-token-value', account_id: 'acct-export', client_id: 'client-export',
  } };
}

test('Sub2API 导出使用标准 accounts/credentials 结构', () => {
  const value = exportSub2Api(auth(), { label: '测试账号', emailHint: 'test@example.com' });
  assert.equal(value.type, 'sub2api-data');
  assert.equal(value.accounts[0].name, '测试账号');
  assert.equal(value.accounts[0].credentials.account_id, 'acct-export');
  assert.equal(value.accounts[0].credentials.email, 'test@example.com');
});

test('CPA 导出使用 CLIProxyAPI 可识别的 codex 结构', () => {
  const value = exportCliProxyApi(auth(), { label: '测试账号', emailHint: 'test@example.com' });
  assert.equal(value.type, 'codex');
  assert.equal(value.name, '测试账号');
  assert.equal(value.account_note, 'test@example.com');
  assert.equal(value.access_token, auth().tokens.access_token);
});

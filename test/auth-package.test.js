const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authIdentity,
  createAuthPackage,
  readAuthPackage,
} = require('../lib/auth-package');

function fixtureAuth(accountId = 'acct-test-001') {
  return {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: 'access-token-value-that-is-long-enough',
      refresh_token: 'refresh-token-value-that-is-long-enough',
      id_token: 'header.payload.signature',
      account_id: accountId,
    },
  };
}

test('授权包以单文件保存完整账号授权', () => {
  const payload = {
    manifest: { type: 'codex-navo-account-transfer', schemaVersion: 1 },
    account: { label: '测试账号', emailHint: 'te***@example.com' },
    files: { 'auth.json': fixtureAuth() },
  };
  const authorizationPackage = createAuthPackage(payload);
  assert.equal(authorizationPackage.type, 'codex-navo-auth-package');
  assert.equal(authorizationPackage.version, 2);
  assert.match(JSON.stringify(authorizationPackage), /access-token-value/);
  assert.deepEqual(readAuthPackage(authorizationPackage), payload);
});

test('被意外修改或截断的授权包会被完整性校验拒绝', () => {
  const authorizationPackage = createAuthPackage({ account: {}, files: { 'auth.json': fixtureAuth() } });
  authorizationPackage.payload.account.label = '被修改';
  assert.throws(() => readAuthPackage(authorizationPackage), /已损坏|不完整/);
});

test('相同 Codex 账号可以通过不暴露凭证的指纹识别', () => {
  assert.equal(authIdentity(fixtureAuth('same-account')), authIdentity(fixtureAuth('same-account')));
  assert.notEqual(authIdentity(fixtureAuth('same-account')), authIdentity(fixtureAuth('another-account')));
});

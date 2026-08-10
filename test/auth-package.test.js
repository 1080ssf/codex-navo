const test = require('node:test');
const assert = require('node:assert/strict');
const {
  authAccessExpiry,
  authIdentity,
  createAuthPackage,
  readAuthPackage,
  validateAuthPayload,
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

test('授权包可同时携带 Codex 授权和标准化网页会话', () => {
  const payload = {
    manifest: { type: 'codex-navo-account-transfer', schemaVersion: 2 },
    account: { label: '双端账号' },
    files: {
      'auth.json': fixtureAuth(),
      'web-session.json': {
        version: 1,
        cookies: [{
          name: '__Secure-next-auth.session-token',
          value: 'web-session-value',
          domain: '.chatgpt.com',
          path: '/',
          secure: true,
          httpOnly: true,
        }],
      },
    },
  };
  assert.deepEqual(readAuthPackage(createAuthPackage(payload)), payload);
});

test('旧版只含 auth.json 的授权包继续兼容，其他站点 Cookie 被拒绝', () => {
  const codexOnly = { account: {}, files: { 'auth.json': fixtureAuth() } };
  assert.deepEqual(readAuthPackage(createAuthPackage(codexOnly)), codexOnly);
  assert.throws(() => createAuthPackage({
    account: {},
    files: {
      'auth.json': fixtureAuth(),
      'web-session.json': {
        cookies: [{ name: 'session', value: 'value', domain: '.example.com', path: '/' }],
      },
    },
  }), /网页会话 Cookie 内容无效/);
});

test('temporary auth requires explicit opt-in and remains exportable', () => {
  const auth = fixtureAuth();
  auth.tokens.id_token = `${Buffer.from(JSON.stringify({ alg: 'none', cpa_synthetic: true })).toString('base64url')}.payload.synthetic`;
  auth.tokens.refresh_token = 'placeholder';
  assert.throws(() => validateAuthPayload(auth), /OAuth refresh token|Codex/);
  assert.equal(validateAuthPayload(auth, { allowTemporary: true }), auth);
  const payload = { account: {}, files: { 'auth.json': auth } };
  assert.deepEqual(readAuthPackage(createAuthPackage(payload)), payload);
});

test('临时授权可以读取 Access Token 到期时间而不暴露令牌', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url');
  const auth = fixtureAuth();
  auth.tokens.access_token = `header.${payload}.signature`;
  assert.equal(authAccessExpiry(auth), '2033-05-18T03:33:20.000Z');
});

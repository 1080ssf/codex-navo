const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRelayAccountPackage } = require('../lib/relay-account-import');

function token(payload) {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

test('imports every account from a Sub2API package', () => {
  const access = token({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-sub2' } });
  const imported = parseRelayAccountPackage({
    type: 'sub2api-data',
    accounts: [{ name: 'Sub2 Account', credentials: { access_token: access, refresh_token: 'refresh-token-long-enough-for-testing', email: 'sub2@example.com' } }],
  });
  assert.equal(imported.length, 1);
  assert.equal(imported[0].format, 'sub2api');
  assert.equal(imported[0].temporary, false);
  assert.equal(imported[0].auth.tokens.account_id, 'acct-sub2');
});

test('normalizes CPA, 9router, Codex auth, and Codex-Manager shapes', () => {
  const access = token({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-shape' } });
  const refresh = 'refresh-token-long-enough-for-testing';
  const cases = [
    { type: 'codex', access_token: access, refresh_token: refresh, account_id: 'acct-cpa' },
    { provider: 'codex', accessToken: access, refreshToken: refresh, id: 'acct-router', providerSpecificData: {} },
    { auth_mode: 'chatgpt', tokens: { access_token: access, refresh_token: refresh, account_id: 'acct-auth' } },
    { tokens: { access_token: access, refresh_token: refresh, account_id: 'acct-manager' }, meta: { label: 'Manager' } },
  ];
  assert.deepEqual(cases.map((item) => parseRelayAccountPackage(item)[0].format), ['cpa', '9router', 'codex-auth', 'codex-manager']);
});

test('access-only packages become expiring temporary relay credentials', () => {
  const access = token({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-temp' } });
  const imported = parseRelayAccountPackage({ access_token: access, email: 'temporary@example.com' })[0];
  assert.equal(imported.temporary, true);
  assert.equal(imported.auth.tokens.refresh_token, access);
  assert.equal(imported.expiresAt, '2033-05-18T03:33:20.000Z');
});

test('rejects packages without an account id and duplicates inside one package', () => {
  const accessWithoutAccount = token({ exp: 2_000_000_000 });
  assert.throws(() => parseRelayAccountPackage({ access_token: accessWithoutAccount }), /Account ID/);
  const access = token({ exp: 2_000_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'duplicate' } });
  assert.throws(() => parseRelayAccountPackage([{ access_token: access }, { access_token: access }]), /重复账号/);
});

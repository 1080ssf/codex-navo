const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectJsonMetadata,
  fetchPublicMetadata,
  isPrivateAddress,
  redactUrl,
  validatePublicUrl,
} = require('../scripts/mail-metadata-collector');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('公网元数据采集器拒绝私网和回环地址', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('192.168.1.10'), true);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  await assert.rejects(validatePublicUrl('http://localhost/mail'), /不允许访问/);
});

test('JSON 元数据排除正文、验证码、令牌和主题', () => {
  const metadata = collectJsonMetadata([{
    message_id: 'message-001',
    receivedAt: '2026-08-09T12:00:00Z',
    status: 'unread',
    subject: 'Your code is 123456',
    body: 'verification code 123456',
    access_token: 'secret-value',
  }]);
  const output = JSON.stringify(metadata);
  assert.match(output, /identityFingerprint|receivedAt|status/);
  assert.doesNotMatch(output, /123456|secret-value|subject|body|access_token|message-001/);
});

test('公网响应只输出脱敏端点和非敏感结构信息', async () => {
  const response = new Response(JSON.stringify([{
    id: 'private-message-id',
    received: '2026-08-09T12:00:00Z',
    state: 'read',
    otp: '654321',
    content: 'secret content',
  }]), { status: 200, headers: { 'content-type': 'application/json' } });
  const metadata = await fetchPublicMetadata('https://example.com/mail/user@example.com?token=secret', {
    lookup: publicLookup,
    fetchImpl: async () => response,
  });
  const output = JSON.stringify(metadata);
  assert.equal(metadata.httpStatus, 200);
  assert.equal(metadata.format, 'json');
  assert.doesNotMatch(output, /user@example\.com|token=secret|654321|secret content|private-message-id/);
});

test('端点脱敏邮箱、查询参数和长路径令牌', () => {
  const safe = redactUrl('https://example.com/mail/user@example.com/abcdefghijklmnopqrstuvwxyz?auth=secret');
  assert.doesNotMatch(safe, /user@example\.com|abcdefghijklmnopqrstuvwxyz|auth=secret/);
});

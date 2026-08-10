const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const {
  MailOtpSession,
  assertMailboxEndpointUrl,
  assertLoopbackUrl,
  extractMailboxOtpCandidates,
  fetchMailboxOtpCandidates,
  redactEndpoint,
  resolveMailboxContentUrl,
} = require('../lib/mail-otp');
const { parseArguments, startMockMailbox } = require('../scripts/mail-otp-mock-server');
const { parseArguments: parseCheckArguments, resolveOptions, resultSummary } = require('../scripts/mail-otp-check');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('解析 JSON、HTML 和纯文本中的中英文六位验证码', () => {
  const json = extractMailboxOtpCandidates(JSON.stringify({ messageId: 'a', verification_code: '123456' }), { contentType: 'application/json' });
  const html = extractMailboxOtpCandidates('<html><body>您的验证码是：<b>234567</b>。</body></html>', { contentType: 'text/html' });
  const text = extractMailboxOtpCandidates('Your verification code is (345678).', { contentType: 'text/plain' });
  assert.equal(json[0].code, '123456');
  assert.equal(html[0].code, '234567');
  assert.equal(text[0].code, '345678');
  assert.ok(json[0].score >= 25);
  assert.ok(html[0].score >= 25);
  assert.ok(text[0].score >= 25);
});

test('标点包围的六位数字可识别，七位及更长数字不会被截取', () => {
  assert.deepEqual(extractMailboxOtpCandidates('验证码：[456789]。').map((item) => item.code), ['456789']);
  assert.deepEqual(extractMailboxOtpCandidates('验证码 1234567，参考号 9876543210'), []);
});

test('可打印 Base64 邮件正文会被额外扫描', () => {
  const encoded = Buffer.from('Your ChatGPT verification code is 654321.').toString('base64');
  const candidates = extractMailboxOtpCandidates({ payload: encoded });
  assert.equal(candidates[0].code, '654321');
  assert.ok(candidates[0].score >= 12);
});

test('稳定去重标识优先使用消息 ID、时间，缺失时使用上下文哈希', () => {
  const byIdA = extractMailboxOtpCandidates({ messageId: 'same', otp: '111222', body: 'first' })[0];
  const byIdB = extractMailboxOtpCandidates({ messageId: 'same', otp: '111222', body: 'changed' })[0];
  const byTimeA = extractMailboxOtpCandidates({ receivedAt: '2026-08-09T10:00:00Z', otp: '222333' })[0];
  const byTimeB = extractMailboxOtpCandidates({ receivedAt: '2026-08-09T10:00:00Z', otp: '222333' })[0];
  const contextA = extractMailboxOtpCandidates('verification code 333444')[0];
  const contextB = extractMailboxOtpCandidates('verification code 333444')[0];
  assert.equal(byIdA.stableKey, byIdB.stableKey);
  assert.equal(byTimeA.stableKey, byTimeB.stableKey);
  assert.equal(contextA.stableKey, contextB.stableKey);
});

test('基线中的旧码被忽略，高置信新码第一次出现即提交', async () => {
  let call = 0;
  const session = new MailOtpSession('http://127.0.0.1:1/mock', {
    intervalMs: 1,
    waitMs: 250,
    fetchCandidates: async () => {
      call += 1;
      return extractMailboxOtpCandidates(call === 1
        ? { messageId: 'old', verification_code: '111111' }
        : { messageId: 'new', verification_code: '222222' });
    },
  });
  await session.captureBaseline();
  let submitted = '';
  const result = await session.waitForCode({
    state: 'waiting-for-email-otp',
    submitCode: async (code) => { submitted = code; },
  });
  assert.equal(result.status, 'submitted');
  assert.equal(submitted, '222222');
});

test('基线读取失败时停止自动化，未进入等待状态时不发起轮询', async () => {
  let calls = 0;
  const failed = new MailOtpSession('http://127.0.0.1:1/mock', {
    fetchCandidates: async () => { calls += 1; throw new Error('mock failure'); },
  });
  await assert.rejects(failed.captureBaseline(), /mock failure/);
  await assert.rejects(failed.waitForCode({
    state: 'waiting-for-email-otp',
    submitCode: async () => {},
  }), /先成功建立验证码基线/);
  assert.equal(calls, 1);

  const waiting = new MailOtpSession('http://127.0.0.1:1/mock', {
    fetchCandidates: async () => { calls += 1; return []; },
  });
  await waiting.captureBaseline();
  await assert.rejects(waiting.waitForCode({
    state: 'starting',
    submitCode: async () => {},
  }), /尚未进入等待/);
  assert.equal(calls, 2);
});

test('低置信候选连续出现两次后才提交', async () => {
  let call = 0;
  const low = extractMailboxOtpCandidates({ messageId: 'low', note: 'reference 333333 pending' })[0];
  assert.ok(low.score < 12);
  const session = new MailOtpSession('http://127.0.0.1:1/mock', {
    intervalMs: 1,
    waitMs: 250,
    fetchCandidates: async () => (++call === 1 ? [] : [low]),
  });
  await session.captureBaseline();
  let submissions = 0;
  const result = await session.waitForCode({
    state: 'waiting-for-email-otp',
    submitCode: async () => { submissions += 1; },
  });
  assert.equal(result.status, 'submitted');
  assert.equal(call, 3);
  assert.equal(submissions, 1);
});

test('轮询每次刷新都会报告次数和候选数量', async () => {
  let call = 0;
  const polls = [];
  const session = new MailOtpSession('http://127.0.0.1:1/mock', {
    intervalMs: 1,
    waitMs: 250,
    fetchCandidates: async () => (++call === 1 ? [] : extractMailboxOtpCandidates({ otp: '717171' })),
  });
  await session.captureBaseline();
  await session.waitForCode({
    state: 'waiting-for-email-otp',
    onPoll: (status) => polls.push(status),
    submitCode: async () => {},
  });
  assert.deepEqual(polls, [{ attempt: 1, candidateCount: 1 }]);
});

test('验证码通过现有 stdin 形态写入模拟交互登录子进程', async () => {
  let call = 0;
  const childStdin = new PassThrough();
  childStdin.setEncoding('utf8');
  let received = '';
  childStdin.on('data', (chunk) => { received += chunk; });
  const session = new MailOtpSession('http://127.0.0.1:1/mock', {
    intervalMs: 1,
    waitMs: 250,
    fetchCandidates: async () => (++call === 1 ? [] : extractMailboxOtpCandidates({ otp: '444555' })),
  });
  await session.captureBaseline();
  const result = await session.waitForCode({
    state: 'waiting-for-email-otp',
    submitCode: async (code) => childStdin.write(`${code}\n`),
  });
  assert.equal(result.status, 'submitted');
  assert.equal(received, '444555\n');
});

test('轮询超时不终止登录任务并保留人工输入', async () => {
  const session = new MailOtpSession('http://127.0.0.1:1/mock', {
    intervalMs: 2,
    waitMs: 8,
    fetchCandidates: async () => [],
  });
  await session.captureBaseline();
  let manualStillAvailable = true;
  let timeoutMessage = '';
  const result = await session.waitForCode({
    state: 'waiting-for-email-otp',
    submitCode: async () => { manualStillAvailable = false; },
    onTimeout: (message) => { timeoutMessage = message; },
  });
  assert.equal(result.status, 'timeout');
  assert.equal(manualStillAvailable, true);
  assert.match(timeoutMessage, /人工输入/);
});

test('HTML 查询页面只跟随同源 JSON 邮件数据接口', async (t) => {
  const mailbox = await listen((request, response) => {
    if (request.url === '/query?token=secret') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><head><meta name="mail-data-url" content="/api/latest"></head></html>');
      return;
    }
    if (request.url === '/api/latest') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ messageId: 'new-mail', body: 'Your verification code is 555666.' }));
      return;
    }
    response.writeHead(404).end();
  });
  t.after(mailbox.close);
  const candidates = await fetchMailboxOtpCandidates(`${mailbox.origin}/query?token=secret`);
  assert.equal(candidates[0].code, '555666');
});

test('邮箱查看链接会转换为同源 mail-api 数据地址并禁用缓存', async (t) => {
  let requestUrl = '';
  let cacheControl = '';
  const mailbox = await listen((request, response) => {
    requestUrl = request.url;
    cacheControl = request.headers['cache-control'] || '';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ messages: [{
      message_id: 'fresh-message',
      received_time: '2026-08-09T10:00:00Z',
      verification_code: '606060',
    }] }));
  });
  t.after(mailbox.close);
  const viewer = `${mailbox.origin}/latest?email=test%40example.com&auth_code=key-value----tail`;
  const resolved = resolveMailboxContentUrl(viewer);
  assert.equal(resolved.href, `${mailbox.origin}/mail-api/key-value/test%40example.com?folder=inbox`);
  const candidates = await fetchMailboxOtpCandidates(viewer);
  assert.equal(candidates[0].code, '606060');
  assert.equal(requestUrl, '/mail-api/key-value/test%40example.com?folder=inbox');
  assert.equal(cacheControl, 'no-cache');
});

test('公网接口仅允许 HTTPS，邮件数据接口仍必须同源', async (t) => {
  assert.throws(() => assertLoopbackUrl('https://example.com/mail'), /仅允许本机 Mock/);
  assert.equal(assertMailboxEndpointUrl('https://example.com/mail').href, 'https://example.com/mail');
  assert.throws(() => assertMailboxEndpointUrl('http://example.com/mail'), /必须使用 HTTPS/);
  assert.throws(() => assertMailboxEndpointUrl('https://192.168.1.2/mail'), /地址无效/);
  const mailbox = await listen((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<meta name="mail-data-url" content="https://example.com/api">');
  });
  t.after(mailbox.close);
  await assert.rejects(fetchMailboxOtpCandidates(mailbox.origin), /同源|仅允许/);
});

test('本机与公网验证码接口都进入自动提交模式，并标记公网来源', () => {
  const publicSession = new MailOtpSession('https://example.com/mail', { fetchCandidates: async () => [] });
  const localSession = new MailOtpSession('http://127.0.0.1:48080/mail', { fetchCandidates: async () => [] });
  assert.equal(publicSession.isPublicEndpoint, true);
  assert.equal(localSession.isPublicEndpoint, false);
  assert.equal('requiresConfirmation' in publicSession, false);
});

test('错误信息脱敏接口鉴权参数、邮箱和长令牌，且不包含完整验证码', async () => {
  const endpoint = 'http://127.0.0.1:1/mail/user@example.com?auth_code=secret-token-value-123456';
  const safe = redactEndpoint(endpoint);
  assert.doesNotMatch(safe, /user@example\.com|secret-token|123456/);
  assert.match(safe, /<email>|<redacted>/);

  const messages = [];
  const session = new MailOtpSession(endpoint, {
    intervalMs: 1,
    waitMs: 5,
    fetchCandidates: async () => { throw new Error(`failed ${endpoint}`); },
  });
  session.baselineReady = true;
  const result = await session.waitForCode({
    state: 'waiting-for-email-otp',
    submitCode: async () => {},
    onError: (message) => messages.push(message),
  });
  assert.equal(result.status, 'timeout');
  assert.ok(messages.length > 0);
  assert.doesNotMatch(messages.join(' '), /user@example\.com|secret-token|123456/);
});

test('本机 Mock 工具提供可重复读取的查询页与邮件数据接口', async (t) => {
  const fixture = require.resolve('./fixtures/mail-otp.json');
  const mock = await startMockMailbox({ fixture, port: 0 });
  t.after(() => new Promise((resolve) => mock.server.close(resolve)));
  const candidates = await fetchMailboxOtpCandidates(mock.endpoint);
  assert.equal(candidates[0].code, '123456');
  assert.deepEqual(parseArguments(['--fixture', fixture, '--port', '48080']), { fixture, port: 48080 });
});

test('终端脚本只允许本地样本显式显示测试码', () => {
  assert.deepEqual(parseCheckArguments(['--fixture', 'sample.json', '--show-code']), {
    fixture: 'sample.json', endpoint: '', watch: false, showCode: true,
  });
  assert.throws(() => parseCheckArguments(['--endpoint', 'http://127.0.0.1:1', '--show-code']), /只能用于本地样本/);
  const summary = resultSummary([{ code: '123456', score: 40 }], { showCode: true });
  assert.deepEqual(summary.codes, ['123456']);
});

test('终端脚本无参数时提示输入本机接口并进入轮询模式', async () => {
  const options = await resolveOptions([], async () => 'http://127.0.0.1:48080/query');
  assert.deepEqual(options, {
    fixture: '', endpoint: 'http://127.0.0.1:48080/query', watch: true, showCode: false,
  });
});

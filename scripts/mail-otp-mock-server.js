const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;

function parseArguments(argumentsList) {
  const result = { fixture: '', port: 0 };
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === '--fixture') result.fixture = argumentsList[++index] || '';
    else if (argumentsList[index] === '--port') result.port = Number.parseInt(argumentsList[++index] || '0', 10);
  }
  if (!result.fixture) throw new Error('请通过 --fixture 指定本地 JSON、HTML 或文本样本');
  if (!Number.isInteger(result.port) || result.port < 0 || result.port > 65_535) throw new Error('端口必须位于 0 到 65535 之间');
  return result;
}

function fixtureContentType(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.json') return 'application/json; charset=utf-8';
  if (['.html', '.htm'].includes(extension)) return 'text/html; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

function readFixture(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('Mock 样本不是文件');
  if (stat.size > MAX_FIXTURE_BYTES) throw new Error('Mock 样本不能超过 2 MB');
  return fs.readFileSync(file);
}

function createMockMailboxServer(options) {
  const fixture = path.resolve(options.fixture);
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end('Method Not Allowed');
      return;
    }
    if (request.url === '/query') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta name="mail-data-url" content="/latest"><title>Local mailbox mock</title>');
      return;
    }
    if (request.url === '/latest') {
      try {
        const body = readFixture(fixture);
        response.writeHead(200, { 'Content-Type': fixtureContentType(fixture) });
        response.end(body);
      } catch {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Mock fixture unavailable');
      }
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  });
  return server;
}

async function startMockMailbox(options) {
  const fixture = path.resolve(options.fixture);
  readFixture(fixture);
  const server = createMockMailboxServer({ fixture });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', resolve);
  });
  return {
    server,
    endpoint: `http://127.0.0.1:${server.address().port}/query`,
    fixture,
  };
}

if (require.main === module) {
  startMockMailbox(parseArguments(process.argv.slice(2)))
    .then(({ endpoint, fixture }) => {
      process.stdout.write(`本机邮箱 Mock 已启动\n接口地址：${endpoint}\n样本文件：${fixture}\n按 Ctrl+C 停止。\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { createMockMailboxServer, parseArguments, startMockMailbox };

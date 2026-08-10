const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { HIGH_CONFIDENCE_SCORE, extractMailboxOtpCandidates, fetchMailboxOtpCandidates } = require('../lib/mail-otp');

const MAX_BYTES = 2 * 1024 * 1024;

function parseArguments(values) {
  const result = { fixture: '', endpoint: '', watch: false, showCode: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--fixture') result.fixture = values[++index] || '';
    else if (values[index] === '--endpoint') result.endpoint = values[++index] || '';
    else if (values[index] === '--watch') result.watch = true;
    else if (values[index] === '--show-code') result.showCode = true;
  }
  if (Boolean(result.fixture) === Boolean(result.endpoint)) {
    throw new Error('请且仅请指定 --fixture 或 --endpoint');
  }
  if (result.watch && !result.endpoint) throw new Error('--watch 只能与 --endpoint 一起使用');
  if (result.showCode && !result.fixture) throw new Error('--show-code 只能用于本地样本文件');
  return result;
}

function readFixture(file) {
  const resolved = path.resolve(file);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('样本路径不是文件');
  if (stat.size > MAX_BYTES) throw new Error('样本文件不能超过 2 MB');
  const extension = path.extname(resolved).toLowerCase();
  const contentType = extension === '.json' ? 'application/json'
    : ['.html', '.htm'].includes(extension) ? 'text/html' : 'text/plain';
  return extractMailboxOtpCandidates(fs.readFileSync(resolved), { contentType });
}

function resultSummary(candidates, options = {}) {
  const high = candidates.filter((candidate) => candidate.score >= HIGH_CONFIDENCE_SCORE).length;
  const result = {
    detected: candidates.length > 0,
    candidateCount: candidates.length,
    highConfidenceCount: high,
    lowConfidenceCount: candidates.length - high,
  };
  if (options.showCode) result.codes = [...new Set(candidates.map((candidate) => candidate.code))];
  return result;
}

async function run(options) {
  if (options.watch) {
    const { MailOtpSession } = require('../lib/mail-otp');
    const session = new MailOtpSession(options.endpoint);
    const baseline = await session.captureBaseline();
    process.stdout.write(`${JSON.stringify({ status: 'baseline-ready', candidateCount: baseline.candidateCount })}\n`);
    const result = await session.waitForCode({
      state: 'waiting-for-email-otp',
      submitCode: async () => {},
      onError: (message) => process.stderr.write(`${message}\n`),
      onTimeout: (message) => process.stderr.write(`${message}\n`),
    });
    return { status: result.status, detected: result.status === 'submitted' };
  }
  const candidates = options.fixture
    ? readFixture(options.fixture)
    : await fetchMailboxOtpCandidates(options.endpoint);
  return resultSummary(candidates, { showCode: options.showCode });
}

async function resolveOptions(values, ask = null) {
  if (values.length) return parseArguments(values);
  const prompt = ask || (async (question) => {
    const terminal = readline.createInterface({ input: stdin, output: stdout });
    try { return await terminal.question(question); }
    finally { terminal.close(); }
  });
  const endpoint = String(await prompt('请输入本机 Mock 邮件接口地址：')).trim();
  if (!endpoint) throw new Error('接口地址不能为空');
  return { fixture: '', endpoint, watch: true, showCode: false };
}

if (require.main === module) {
  resolveOptions(process.argv.slice(2))
    .then(run)
    .then((summary) => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      process.exitCode = summary.detected ? 0 : 2;
    })
    .catch((error) => {
      process.stderr.write(`检测失败：${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { parseArguments, readFixture, resolveOptions, resultSummary, run };

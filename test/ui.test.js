const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('添加账号弹窗的关闭按钮不会触发必填校验', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const cancelButtons = [...html.matchAll(/<button[^>]*value="cancel"[^>]*>/g)].map((match) => match[0]);
  assert.equal(cancelButtons.length, 2);
  assert.equal(cancelButtons.every((button) => /\bformnovalidate\b/.test(button)), true);
});

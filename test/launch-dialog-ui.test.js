const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first);
  return source.slice(first, last);
}
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function element() {
  const children = new Map(), handlers = new Map();
  return {
    innerHTML: '', open: false, isConnected: true,
    appendChild() {}, remove() { this.isConnected = false; },
    showModal() { this.open = true; }, close() { this.open = false; },
    querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
    querySelectorAll: () => [],
    addEventListener: (name, callback) => handlers.set(name, callback),
    emit: name => handlers.get(name)?.(),
  };
}

async function renderDialog(locale, catalog) {
  const nodes = new Map(), calls = [];
  const context = vm.createContext({
    state: { appLocale: locale }, navoUsesChinese: () => locale === 'zh-CN', escapeHtml,
    document: {
      createElement(tag) { const node = element(); nodes.set(tag, node); return node; },
      body: { appendChild() {} },
    },
    api: async (url, options) => {
      calls.push({ url, options });
      assert.equal(url, '/api/codex-launch-options');
      assert.equal(options, undefined);
      return { languages: [{ id: 'zh-CN', label: '简体中文' }, { id: 'en-US', label: 'English' }], defaultLanguage: 'zh-CN', ...catalog };
    },
    syncModalScrollLock() {},
  });
  vm.runInContext(section('function tr(zh, en)', 'function parseModelList('), context);
  const opening = context.openCodexLaunchDialog();
  await new Promise(resolve => setImmediate(resolve));
  const form = nodes.get('form'), dialog = nodes.get('dialog');
  assert.ok(dialog.open, 'The production dialog must finish mounting');
  const html = form.innerHTML;
  form.querySelector('[data-launch-cancel]').emit('click');
  assert.equal(await opening, null);
  assert.equal(dialog.isConnected, false);
  assert.deepEqual(calls, [{ url: '/api/codex-launch-options', options: undefined }], 'No launch, optimization, backup or restore request is made');
  return html;
}

const project = count => ({
  id: `project-${count}`, label: `Fixture ${count}`, roots: [String.raw`C:\Example\中文项目 <fixture> & ${count}`],
  threads: Array.from({ length: count }, (_, index) => ({ id: `thread-${count}-${index}`, title: `Fixture thread ${index}`, cwd: 'C:/Example', sizeBytes: 1024 })),
});

test('launch project counts render directly in both languages and preserve escaped project paths', async () => {
  const projects = [project(0), project(1), project(2)];
  for (const locale of ['zh-CN', 'en-US']) {
    const html = await renderDialog(locale, { projects, threadCount: 3, oversizedThreadCount: 0 });
    const summaries = [...html.matchAll(/<strong>Fixture \d<\/strong><small>([^<]*)<\/small>/g)].map(match => match[1]);
    assert.deepEqual(summaries, projects.map(record => {
      const count = record.threads.length;
      const label = locale === 'zh-CN' ? `${count} 个会话` : `${count} ${count === 1 ? 'conversation' : 'conversations'}`;
      return `${label} · ${escapeHtml(record.roots[0])}`;
    }));
  }
});

test('history optimization help covers zero and oversized counts in both languages without enabling it', async () => {
  for (const locale of ['zh-CN', 'en-US']) {
    for (const count of [0, 1, 3]) {
      const html = await renderDialog(locale, { projects: [], threadCount: 0, oversizedThreadCount: count });
      const match = html.match(/<div class="launch-optimize">[\s\S]*?<small>([^<]*)<\/small>/);
      assert.ok(match);
      if (locale === 'zh-CN') {
        assert.equal(match[1], `${count ? `${count} 个超大会话可检查。` : '当前没有超过 500 MB 的会话。'}仅处理含有效恢复检查点的会话；异常、旧格式或含回滚记录时会跳过，并保留原文件备份。`);
      } else {
        assert.equal(match[1], `${count ? `${count} oversized ${count === 1 ? 'conversation can' : 'conversations can'} be checked.` : 'No conversation currently exceeds 500 MB.'} Only conversations with a valid recovery checkpoint are processed. Invalid, legacy, or rolled-back histories are skipped and the original file is backed up.`);
        assert.doesNotMatch(match[1], /[\u3400-\u9fff]/);
      }
      const checkbox = html.match(/<input\b[^>]*name="optimizeOversized"[^>]*>/)?.[0];
      assert.ok(checkbox);
      assert.doesNotMatch(checkbox, /\bchecked\b/);
    }
  }
});

test('launch dialog keeps its header and footer outside the scrollable content including backups', async () => {
  const html = await renderDialog('en-US', { projects: [project(2)], threadCount: 2, oversizedThreadCount: 1 });
  const stack = [], rootClasses = [], voidTags = new Set(['input', 'br', 'hr', 'img']);
  let backupInsideContent = false;
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9]*)\b[^<>]*>/gi)) {
    const tag = match[1].toLowerCase(), markup = match[0];
    if (markup.startsWith('</')) {
      assert.equal(stack.pop()?.tag, tag, 'Rendered launch markup must remain balanced');
      continue;
    }
    const className = markup.match(/\bclass="([^"]*)"/)?.[1] || '';
    if (!stack.length) rootClasses.push(className);
    if (/\bdata-launch-backup-panel\b/.test(markup)) backupInsideContent = stack.some(node => node.className === 'launch-dialog-content');
    if (!voidTags.has(tag)) stack.push({ tag, className });
  }
  assert.equal(stack.length, 0);
  assert.deepEqual(rootClasses, ['dialog-head', 'launch-dialog-content', 'dialog-actions']);
  assert.equal(backupInsideContent, true);
});

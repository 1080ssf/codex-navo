const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing UI section: ${start}`);
  return source.slice(first, last);
}
const escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function element(attributes = {}, children = []) {
  const values = new Map(Object.entries(attributes)), classes = new Set();
  return {
    nodeType: 1, children, innerHTML: '', textContent: '', dataset: {}, hidden: false,
    getAttribute: name => values.get(name) || null,
    setAttribute: (name, value) => values.set(name, value),
    removeAttribute: name => values.delete(name),
    matches: () => false,
    querySelector() { if (!this.child) this.child = element(); return this.child; },
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
  };
}

function harness(locale = 'en-US', initial = {}) {
  const roots = new Map(), observations = [];
  let mutationCallback;
  const elements = new Proxy({}, { get(_target, key) { if (!roots.has(key)) roots.set(key, element()); return roots.get(key); } });
  const context = vm.createContext({
    state: {
      accounts: [], apiService: { keys: [] }, accountGroups: {}, expandedUsage: new Set(),
      viewMode: 'list', appLocale: locale, ...initial,
    },
    navoUsesChinese: () => context.state.appLocale === 'zh-CN',
    elements, window: {}, escapeHtml,
    renderProtocolDialogProgress() {}, applyViewMode() {}, renderUsage() {}, renderApiService() {},
    sortedAccounts: (_active, accounts) => accounts,
    formatPlan: plan => plan, formatUsdBalance: () => '', renderAccountUsage: () => '',
    renderUsageStrip: () => '', apiUsageInSelectedRangeForKey: () => ({}), setLaunchControlsDisabled() {},
    Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1 },
    document: {
      body: element(), documentElement: element(),
      querySelectorAll: selector => selector === '[data-sidebar-section]'
        ? [elements.sidebarAccountButton, elements.networkSettingsButton] : [],
      createTreeWalker(root) {
        const flatten = node => (node.children || []).flatMap(child => [child, ...flatten(child)]);
        const descendants = flatten(root);
        return { nextNode: () => descendants.shift() };
      },
    },
    MutationObserver: class {
      constructor(callback) { mutationCallback = callback; }
      observe(_root, options) { observations.push(options); }
    },
    queueMicrotask() {},
  });
  vm.runInContext([
    section('const englishUi =', 'const sidebarStorageKey'),
    section('function tr(zh, en)', 'function formatLaunchSize'),
    section('function formatReset(', 'function renderApiService()'),
    section('function renderApiAccountCards()', 'function editingSurfaceActive()'),
    section('function nodeTestText(', 'function renderNetworkSources()'),
    section('function accountRouteValue(', 'function populateAccountRouteSelect('),
    section('function setSidebarActive(', 'function showAppPage('),
    section('async function loadNotificationSettings()', 'function playNotificationSound('),
  ].join('\n'), context);
  return {
    elements, observations, context,
    run: code => vm.runInContext(code, context),
    translate(root) { context.root = root; vm.runInContext('translateUi(root)', context); },
    mutation: records => mutationCallback(records),
  };
}

const account = (id, overrides = {}) => ({
  id, label: `Fixture ${id}`, codexInitialized: true,
  quota: { windows: [{ windowDurationMins: 300, label: '5 小时额度', remainingPercent: 72, resetsAt: 0 }] },
  ...overrides,
});

test('account summary renders language-correct split text nodes without relying on mutation translation', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const h = harness(locale, {
      accounts: Array.from({ length: 5 }, (_, index) => account(String(index), { codexActive: index === 0 })),
      apiService: { keys: [{ id: 'api', name: 'Fixture API' }], activeKeyId: 'api' },
    });
    h.run('render()');
    if (locale === 'zh-CN') {
      assert.match(h.elements.summary.innerHTML, /<strong>5<\/strong> 个账号 · 1 个 Navo API/);
      assert.match(h.elements.summary.innerHTML, /<strong>2<\/strong> 使用中/);
    } else {
      assert.match(h.elements.summary.innerHTML, /<strong>5<\/strong> accounts · 1 Navo API/);
      assert.match(h.elements.summary.innerHTML, /<strong>2<\/strong> active/);
      assert.doesNotMatch(h.elements.summary.innerHTML, /[\u3400-\u9fff]/);
    }
  }
});

test('single-account summaries and dynamic network tooltips render directly in English', () => {
  const h = harness('en-US', { accounts: [account('one', { network: { mode: 'proxy', displayName: '美国 VPS' } })] });
  h.run('render()');
  assert.match(h.elements.summary.innerHTML, /<strong>1<\/strong> account<\/span>/);
  assert.doesNotMatch(h.elements.summary.innerHTML, /Navo API/);
  assert.equal(h.elements.networkSettingsButton.dataset.tooltip, '1 account uses a proxy');
  h.context.state.accounts = [];
  h.run('render()');
  assert.equal(h.elements.networkSettingsButton.dataset.tooltip, 'Network and nodes');
});

test('network navigation indicates only the current page, not whether accounts use proxies', () => {
  const h = harness('en-US');
  h.elements.sidebarAccountButton.dataset.sidebarSection = 'accounts';
  h.elements.networkSettingsButton.dataset.sidebarSection = 'network';
  for (const page of ['accounts', 'network']) {
    h.context.page = page;
    h.run('setSidebarActive(page)');
    for (const proxied of [true, false]) {
      h.context.state.accounts = [account('one', { network: { mode: proxied ? 'proxy' : 'direct' } })];
      h.elements.networkSettingsButton.setAttribute('aria-pressed', 'true');
      h.run('render()');
      assert.equal(h.elements.networkSettingsButton.getAttribute('aria-pressed'), null);
      assert.equal(h.elements.networkSettingsButton.getAttribute('aria-current'), page === 'network' ? 'page' : null);
      assert.equal(h.elements.sidebarAccountButton.getAttribute('aria-current'), page === 'accounts' ? 'page' : null);
    }
  }
});

test('plan expiration labels and tooltips render in the selected language and preserve upstream errors', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const h = harness(locale, { accounts: [account('one', { quota: { planType: 'plus', windows: [] } })] });
    const badge = () => {
      h.run('render()');
      const match = h.elements.accounts.innerHTML.match(/<span class="expiry-badge" title="([^"]*)">([^<]*)<\/span>/);
      assert.ok(match);
      return { title: match[1], label: match[2] };
    };
    const chinese = locale === 'zh-CN';
    assert.deepEqual(badge(), {
      title: chinese ? '正在自动读取官方套餐到期时间' : 'Automatically checking the official plan expiration date',
      label: chinese ? '到期 自动检测中' : 'Expiration: checking',
    });
    h.context.state.accounts[0].planExpiryCheckedAt = '2026-09-15T00:00:00Z';
    h.context.state.accounts[0].planExpiryError = 'upstream <fixture> & 未知 503';
    assert.deepEqual(badge(), {
      title: 'upstream &lt;fixture&gt; &amp; 未知 503',
      label: chinese ? '到期 暂未读取' : 'Expiration unavailable',
    });
    const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
    h.context.state.accounts[0].planExpiresAt = expiresAt.toISOString();
    assert.deepEqual(badge(), {
      title: `${chinese ? '套餐到期：' : 'Plan expires: '}${expiresAt.toLocaleDateString(locale)}`,
      label: chinese ? '剩余 1 天' : '1 day left',
    });
  }
});

test('node status and composed connection summaries are directly bilingual, including zero and fallback delays', () => {
  const states = [
    ['available', '可用', 'Available'],
    ['unsupported-region', 'ChatGPT 不支持', 'ChatGPT unsupported'],
    ['challenge-required', '可连接（CF 保护）', 'Reachable (CF protected)'],
    ['cloudflare-protected', '可连接（CF 保护）', 'Reachable (CF protected)'],
    ['blocked', '站点拒绝', 'Site rejected'], ['rate-limited', '访问限流', 'Rate limited'],
    ['connection-failed', '连接失败', 'Connection failed'], ['tls-failed', 'TLS 中断', 'TLS interrupted'],
    ['checking', '检测中…', 'Checking…'],
  ];
  for (const locale of ['zh-CN', 'en-US']) {
    const h = harness(locale), chinese = locale === 'zh-CN';
    for (const [status, zh, en] of states) {
      h.context.node = { status };
      const label = chinese ? zh : en;
      assert.equal(h.run('nodeTestText(node)'), label);
      assert.equal(h.run('nodeRouteText(node)'), label);
      for (const delayField of ['connectDelay', 'delay']) {
        for (const delay of [0, 45]) {
          h.context.node = { status, [delayField]: delay };
          assert.equal(h.run('nodeRouteText(node)'), `${chinese ? '连接' : 'Connection'} ${delay} ms · ${label}`);
        }
      }
    }
    assert.equal(h.run('nodeTestText({})'), chinese ? '未检测' : 'Not tested');
    assert.equal(h.run("nodeTestText({status: 'upstream-unknown'})"), chinese ? '已检测' : 'Tested');
    assert.equal(h.run("nodeRouteText({status: 'upstream-unknown', connectDelay: 45})"), chinese ? '连接 45 ms · ChatGPT 未完成' : 'Connection 45 ms · ChatGPT check incomplete');
    assert.equal(h.run("nodeRouteText({status: 'upstream-unknown', delay: 45})"), chinese ? '连接 45 ms · 已检测' : 'Connection 45 ms · Tested');
    assert.equal(h.run("nodeRouteText({status: 'upstream-unknown'})"), chinese ? '未检测' : 'Not tested');
  }
});

test('account route records localize status without translating standalone or subscription names', () => {
  const h = harness('en-US', { networkSettings: { sources: [
    { id: 'standalone', kind: 'node', name: '美国 VPS 次待定价', nodes: [{ name: 'Fixture IP', protocol: 'socks5', connectDelay: 45, status: 'available' }] },
    { id: 'subscription', kind: 'subscription', name: 'Fixture subscription', nodes: [{ name: '香港 01 <fixture>', protocol: 'hy2', connectDelay: 0, status: 'checking' }] },
  ] } });
  const standalone = h.run("accountRouteRecord(accountRouteValue('standalone', 'Fixture IP'))");
  assert.equal(standalone.label, '美国 VPS 次待定价');
  assert.equal(standalone.detail, 'socks5 · Connection 45 ms · Available');
  const subscription = h.run("accountRouteRecord(accountRouteValue('subscription', '香港 01 <fixture>'))");
  assert.equal(subscription.label, '香港 01 <fixture>');
  assert.equal(subscription.detail, 'hy2 · Connection 0 ms · Checking…');
});

test('notification sound and volume have bilingual accessible names even when settings cannot load', async () => {
  const h = harness('zh-CN'), calls = [];
  const controls = { sound: element(), volume: element() };
  h.elements.notificationForm.elements = controls;
  h.context.fillNotificationForm = settings => calls.push(settings);
  for (const locale of ['zh-CN', 'en-US']) {
    h.context.state.appLocale = locale;
    const expected = locale === 'zh-CN'
      ? ['通知提示音', '通知音量'] : ['Notification sound', 'Notification volume'];
    for (const fail of [false, true]) {
      h.context.api = async url => {
        assert.equal(url, '/api/notification-settings');
        assert.equal(controls.sound.getAttribute('aria-label'), expected[0]);
        assert.equal(controls.volume.getAttribute('aria-label'), expected[1]);
        if (fail) throw new Error('Fixture only: unavailable');
        return { sound: 'none', volume: 0.55 };
      };
      await assert.doesNotReject(h.run('loadNotificationSettings()'));
    }
  }
  assert.equal(calls.length, 2, 'Only successful settings reads populate the form');
});

test('quota labels derive both languages from duration instead of server-side Chinese labels', () => {
  const en = harness('en-US'), zh = harness('zh-CN');
  for (const [minutes, chinese, english] of [
    [300, '5 小时额度', '5-hour quota'], [10080, '周额度', 'Weekly quota'],
    [1440, '1 天额度', '1-day quota'], [120, '2 小时额度', '2-hour quota'],
  ]) {
    const value = `{ windowDurationMins: ${minutes}, label: '来自服务端的中文' }`;
    assert.equal(en.run(`quotaLabel(${value})`), english);
    assert.equal(zh.run(`quotaLabel(${value})`), chinese);
  }
  assert.equal(en.run("quotaLabel({windowDurationMins: 10, label: '短时额度'})"), 'Short-term quota');
});

test('quota progress names and unknown reset times follow the selected language without altering values', () => {
  const h = harness('en-US');
  h.context.example = account('one', { quota: { windows: [
    { windowDurationMins: 300, label: '5 小时额度', remainingPercent: 72, resetsAt: 0 },
    { windowDurationMins: 10080, label: '周额度', remainingPercent: 98, resetsAt: 0 },
  ] } });
  const markup = h.run('renderQuota(example)');
  assert.match(markup, /aria-label="5-hour quota remaining" value="72"/);
  assert.match(markup, /aria-label="Weekly quota remaining" value="98"/);
  assert.match(markup, /Reset time unknown/);
  assert.doesNotMatch(markup, /[\u3400-\u9fff]/);
  h.context.state.appLocale = 'zh-CN';
  assert.match(h.run('renderQuota(example)'), /aria-label="5 小时额度剩余" value="72"/);
});

test('CSS tooltips are translated on root elements and descendants and when dynamically changed', () => {
  const h = harness('en-US');
  const button = element({ 'data-tooltip': '刷新全部账号额度', 'aria-label': '刷新全部账号额度' });
  const nested = element({ 'data-tooltip': '网络与节点' });
  button.children.push(nested);
  h.translate(button);
  assert.equal(button.getAttribute('data-tooltip'), 'Refresh all account quotas');
  assert.equal(nested.getAttribute('data-tooltip'), 'Network and nodes');
  assert.ok(h.observations[0].attributeFilter.includes('data-tooltip'));
  button.setAttribute('data-tooltip', '3 个账号使用代理');
  h.mutation([{ type: 'attributes', target: button, attributeName: 'data-tooltip' }]);
  assert.equal(button.getAttribute('data-tooltip'), '3 accounts use a proxy');
  h.context.state.appLocale = 'zh-CN';
  button.setAttribute('data-tooltip', '刷新全部账号额度');
  h.mutation([{ type: 'attributes', target: button, attributeName: 'data-tooltip' }]);
  assert.equal(button.getAttribute('data-tooltip'), '刷新全部账号额度');
});

test('proxy prefixes translate arbitrary route names while retaining those names verbatim', () => {
  const h = harness('en-US');
  for (const name of ['美国 VPS', '🇭🇰 香港01 CloudFront', 'Office SS / HY2', '123', '<fixture> & route', '我的线路 次待定价']) {
    h.context.text = `代理 · ${name}`;
    assert.equal(h.run('translateText(text)'), `Proxy · ${name}`);
    h.context.text = `Proxy · ${name}`;
    assert.equal(h.run('translateText(text)'), `Proxy · ${name}`);
  }
});

test('ordinary-account and API cards translate only the proxy prefix and escape the route name', () => {
  const routeName = '美国 VPS <fixture> & 01';
  const h = harness('en-US', {
    accounts: [account('one', { network: { mode: 'proxy', displayName: routeName, label: '代理 · 美国 VPS' } })],
    apiService: { keys: [{ id: 'api', name: 'Fixture API', network: { mode: 'proxy', displayName: routeName } }] },
  });
  h.run('render()');
  const badges = [...h.elements.accounts.innerHTML.matchAll(/<span class="network-badge"[^>]*>(.*?)<\/span>/g)].map(match => match[1]);
  assert.deepEqual(badges, ['Proxy · 美国 VPS &lt;fixture&gt; &amp; 01', 'Proxy · 美国 VPS &lt;fixture&gt; &amp; 01']);
});

test('account onboarding and task-wide routing help have complete English translations', () => {
  const h = harness('en-US');
  const copy = h.run("translateText('创建独立账号环境，并在 Chrome 中完成官方登录与 Codex OAuth。')");
  assert.match(copy, /Create an isolated account environment/);
  for (const text of [
    '网页登录、Codex OAuth 和 Codex 任务使用此线路',
    '网页登录、Codex OAuth 和 Codex 任务使用此线路。',
    '保存后，该账号的网页登录、Codex OAuth 和 Codex 任务使用此线路；后台额度刷新和唤醒按全局择优线路执行。',
  ]) {
    h.context.text = text;
    const result = h.run('translateText(text)');
    assert.match(result, /Codex tasks/);
    assert.doesNotMatch(result, /GitHub|[\u3400-\u9fff]/);
  }
});

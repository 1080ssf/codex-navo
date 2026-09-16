const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing production UI section: ${start}`);
  return source.slice(first, last);
}

function element() {
  const attributes = new Map(), classes = new Set(), listeners = new Map();
  return {
    textContent: '', hidden: false, disabled: false, style: {},
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
    addEventListener: (event, callback) => listeners.set(event, callback),
    dispatch: event => listeners.get(event)?.(),
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains: name => classes.has(name),
    },
  };
}

// Execute the real UI renderer, click handler and poll function with fake time
// and fixture-only API responses. No server, account or Codex process is used.
function harness(locale = 'en-US') {
  const roots = new Map(), timers = new Map(), calls = [], controls = [element(), element()];
  let now = Date.parse('2026-09-16T00:00:00Z'), timerId = 0;
  const elements = new Proxy({}, { get(_target, key) { if (!roots.has(key)) roots.set(key, element()); return roots.get(key); } });
  elements.codexLaunchStatus.hidden = true;
  const context = vm.createContext({
    elements,
    state: { launchProgress: null, launchProgressDismissed: false, launchProgressStartedAt: '', launchProgressCompleteKey: '' },
    navoUsesChinese: () => locale === 'zh-CN',
    Date: class extends Date { static now() { return now; } },
    document: { querySelectorAll: () => controls },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id),
    async api(url, options) {
      calls.push({ url, options });
      assert.equal(url, '/api/codex-launch-progress');
      assert.equal(options, undefined, 'Polling must never mutate or cancel a launch');
      if (context.pollError) throw context.pollError;
      return context.nextProgress;
    },
  });
  vm.runInContext([
    section('function setLaunchControlsDisabled(', 'function openApiFormDialog('),
    section("elements.codexLaunchStatusClose?.addEventListener('click'", 'pollCodexLaunchProgress();'),
  ].join('\n'), context);
  return {
    elements, controls, calls, context, timers,
    now: () => now,
    run: code => vm.runInContext(code, context),
    render(progress) { context.nextProgress = progress; vm.runInContext('renderCodexLaunchProgress(nextProgress)', context); },
    dismiss: () => elements.codexLaunchStatusClose.dispatch('click'),
    advance(milliseconds) {
      const target = now + milliseconds;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id); now = timer.at; timer.callback();
      }
      now = target;
    },
  };
}

function progress(h, overrides = {}) {
  return {
    active: true, kind: 'account', label: 'Fixture account', stage: 'opening',
    message: '正在打开 Codex…', percent: 92, startedAt: new Date(h.now() - 1000).toISOString(),
    ...overrides,
  };
}

test('launch progress supports both entry points and disables duplicate launch actions', () => {
  for (const [locale, title] of [['zh-CN', '正在启动 Codex'], ['en-US', 'Launching Codex']]) {
    const h = harness(locale);
    for (const kind of ['account', 'api']) {
      h.context.kind = kind;
      h.run("beginLaunchUi(kind, 'Fixture only')");
      assert.equal(h.elements.codexLaunchStatus.hidden, false);
      assert.equal(h.elements.codexLaunchStatusTitle.textContent, title);
      assert.equal(h.elements.codexLaunchStatusAccount.textContent, 'Fixture only');
      assert.equal(h.elements.codexLaunchStatusPercent.textContent, '6%');
      for (const control of h.controls) {
        assert.equal(control.disabled, true);
        assert.equal(control.getAttribute('aria-busy'), 'true');
      }
    }
    assert.equal(h.calls.length, 0, 'Local launch feedback itself never starts Codex');
  }
});

test('dismissing progress keeps launch and polling active without reopening the same launch', async () => {
  const h = harness(), running = progress(h);
  h.render(running);
  h.dismiss();
  assert.equal(h.elements.codexLaunchStatus.hidden, true);
  assert.equal(h.context.state.launchProgress.active, true);
  assert.ok(h.controls.every(control => control.disabled));
  h.context.nextProgress = { ...running, percent: 98 };
  await h.run('pollCodexLaunchProgress()');
  assert.equal(h.elements.codexLaunchStatus.hidden, true);
  assert.equal(h.context.state.launchProgress.percent, 98);
  assert.equal(h.calls.length, 1);
  h.render({ ...running, active: false, stage: 'complete', percent: 100, completedAt: new Date(h.now()).toISOString() });
  assert.equal(h.elements.codexLaunchStatus.hidden, true);
  assert.ok(h.controls.every(control => !control.disabled));
  assert.equal(h.timers.size, 0);
});

test('dismissing local preparation stays dismissed when the first server launch identity arrives', async () => {
  for (const kind of ['account', 'api']) {
    for (const stage of ['opening', 'complete']) {
      const h = harness();
      h.run('beginLaunchUi')(kind, 'Fixture account');
      h.dismiss();
      h.context.nextProgress = progress(h, { kind, stage, active: stage !== 'complete', percent: stage === 'complete' ? 100 : 92 });
      await h.run('pollCodexLaunchProgress()');
      assert.equal(h.elements.codexLaunchStatus.hidden, true);
      assert.equal(h.context.state.launchProgressDismissed, true);
      assert.equal(h.context.state.launchProgressStartedAt, h.context.nextProgress.startedAt);
      assert.equal(h.context.state.launchProgressPendingStart, null);
      assert.ok(h.controls.every(control => control.disabled === (stage !== 'complete')));
      assert.equal(h.timers.size, 0);
      assert.equal(h.calls.length, 1, 'Only the progress GET was performed');
    }
  }
});

test('a genuinely different launch is shown after the dismissed local identity was adopted', () => {
  const h = harness();
  h.run('beginLaunchUi')('account', 'Fixture account');
  h.dismiss();
  const first = progress(h);
  h.render(first);
  assert.equal(h.elements.codexLaunchStatus.hidden, true);
  h.advance(1000);
  h.render(progress(h));
  assert.equal(h.elements.codexLaunchStatus.hidden, false, 'A new startedAt is a new launch even for the same account');
  assert.equal(h.context.state.launchProgressDismissed, false);
  h.dismiss();
  h.run('beginLaunchUi')('api', 'Next fixture');
  assert.equal(h.elements.codexLaunchStatus.hidden, false, 'An explicit new local launch also restores progress');

  const other = harness();
  other.run('beginLaunchUi')('account', 'Fixture account');
  other.dismiss();
  other.render(progress(other, { kind: 'api', label: 'Different fixture' }));
  assert.equal(other.elements.codexLaunchStatus.hidden, false, 'A different server launch must not inherit an unrelated dismissal');
});

test('complete progress auto-hides after 1.8 seconds and repeated polls cannot extend or resurrect it', () => {
  const h = harness();
  const complete = progress(h, { active: false, stage: 'complete', percent: 100, completedAt: new Date(h.now()).toISOString() });
  h.render(complete);
  assert.equal(h.elements.codexLaunchStatus.hidden, false);
  assert.equal(h.elements.codexLaunchStatusTitle.textContent, 'Codex is open');
  assert.ok(h.controls.every(control => !control.disabled));
  const timer = [...h.timers.keys()][0];
  h.advance(1000);
  h.render(complete);
  assert.deepEqual([...h.timers.keys()], [timer]);
  h.advance(799);
  assert.equal(h.elements.codexLaunchStatus.hidden, false);
  h.advance(1);
  assert.equal(h.elements.codexLaunchStatus.hidden, true);
  h.render(complete);
  assert.equal(h.elements.codexLaunchStatus.hidden, true);
  assert.equal(h.timers.size, 0);
});

test('completion timestamps account for time already elapsed and missing timestamps still auto-hide', () => {
  for (const elapsed of [800, 5000, null]) {
    const h = harness();
    h.render(progress(h, {
      active: false, stage: 'complete', percent: 100,
      completedAt: elapsed === null ? undefined : new Date(h.now() - elapsed).toISOString(),
    }));
    const remaining = elapsed === null ? 1800 : Math.max(0, 1800 - elapsed);
    assert.equal([...h.timers.values()][0].at - h.now(), remaining);
    h.advance(remaining);
    assert.equal(h.elements.codexLaunchStatus.hidden, true);
  }
});

test('a new launch cancels the previous hide timer and restores dismissed progress', () => {
  const h = harness(), old = progress(h, { active: false, stage: 'complete', completedAt: new Date(h.now()).toISOString() });
  h.render(old);
  h.advance(100);
  h.run("beginLaunchUi('api', 'Next fixture')");
  assert.equal(h.timers.size, 0);
  assert.equal(h.elements.codexLaunchStatus.hidden, false);
  h.advance(5000);
  assert.equal(h.elements.codexLaunchStatus.hidden, false);
  h.render(progress(h));
  h.dismiss();
  h.advance(1000);
  h.render(progress(h));
  assert.equal(h.elements.codexLaunchStatus.hidden, false, 'A different server launch identity should appear');
});

test('100 percent is not treated as completion while the launch is active and failures remain dismissible', () => {
  const h = harness();
  h.render(progress(h, { percent: 200 }));
  assert.equal(h.elements.codexLaunchStatusPercent.textContent, '100%');
  assert.equal(h.elements.codexLaunchStatusBar.style.width, '100%');
  assert.equal(h.timers.size, 0);
  h.advance(10000);
  assert.equal(h.elements.codexLaunchStatus.hidden, false);
  h.render(progress(h, { active: false, stage: 'error', message: 'Fixture failure' }));
  assert.equal(h.elements.codexLaunchStatusTitle.textContent, 'Codex launch failed');
  assert.equal(h.elements.codexLaunchStatus.classList.contains('error'), true);
  assert.ok(h.controls.every(control => !control.disabled));
  assert.equal(h.timers.size, 0);
  h.dismiss();
  assert.equal(h.elements.codexLaunchStatus.hidden, true);
});

test('poll failures preserve the current UI state and never trigger launch or cancellation requests', async () => {
  const h = harness();
  h.render(progress(h));
  h.context.pollError = new Error('Fixture only: offline');
  await assert.doesNotReject(h.run('pollCodexLaunchProgress()'));
  assert.equal(h.elements.codexLaunchStatusPercent.textContent, '92%');
  assert.equal(h.elements.codexLaunchStatus.hidden, false);
  assert.ok(h.controls.every(control => control.disabled));
  assert.equal(h.calls.length, 1);
});

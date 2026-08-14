'use strict';

const elements = Object.fromEntries([
  'account-name', 'account-type', 'quota-value', 'quota-bar', 'usage-input', 'usage-cache', 'usage-cache-rate', 'usage-output',
  'task-state', 'task-title', 'task-project', 'task-activity', 'task-progress', 'task-input', 'task-cache',
  'task-output', 'settings-toggle', 'settings-panel', 'widget-hide', 'opacity-input', 'opacity-value', 'updated-at',
  'pin-toggle', 'quota-refresh',
].map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]));

const storedLocale = localStorage.getItem('codex-navo-app-locale');
const systemLocale = navigator.languages?.[0] || navigator.language || 'en-US';
function normalizedLocale(value) { return String(value || '').toLowerCase() === 'zh-cn' ? 'zh-CN' : 'en'; }
let locale = normalizedLocale(storedLocale || systemLocale);
let latestData = null;
const messages = {
  en: {
    currentAccount: 'Current account', loading: 'Loading...', availableQuota: 'Available quota', input: 'Input',
    cache: 'Cache', cacheRate: 'Cache rate', output: 'Output', currentTask: 'Current task', waitingTask: 'Waiting', noActiveTask: 'No active task',
    monitoringSessions: 'Codex Navo is monitoring local sessions', taskProgress: 'Task progress', idle: 'Idle',
    taskInput: 'Task input', taskCache: 'Task cache', taskOutput: 'Task output', windowStyle: 'Window style',
    glass: 'Glass', midnight: 'Midnight', paper: 'Paper', opacity: 'Opacity', waitingData: 'Waiting for local data',
    dragHint: 'Drag the header to move', shortcutHint: 'Ctrl+Alt+N to bring forward', settings: 'Floating window settings', hide: 'Hide floating window', pin: 'Keep on top', unpin: 'Stop keeping on top',
    notRunning: 'Codex not running', externalCodex: 'External Codex', external: 'EXTERNAL', account: 'ACCOUNT', offline: 'OFFLINE',
    running: 'Running', waitingInput: 'Waiting for input', waitingApproval: 'Waiting for approval', updated: 'Updated',
    waitingService: 'Waiting for local service', untitledSession: 'Untitled session', refreshQuota: 'Refresh quota', refreshFailed: 'Quota refresh failed',
  },
  'zh-CN': {
    currentAccount: '\u5f53\u524d\u8d26\u53f7', loading: '\u8bfb\u53d6\u4e2d...', availableQuota: '\u53ef\u7528\u989d\u5ea6', input: '\u8f93\u5165',
    cache: '\u7f13\u5b58', cacheRate: '\u7f13\u5b58\u7387', output: '\u8f93\u51fa', currentTask: '\u5f53\u524d\u4efb\u52a1', waitingTask: '\u7b49\u5f85\u4efb\u52a1', noActiveTask: '\u6682\u65e0\u6b63\u5728\u8fdb\u884c\u7684\u4efb\u52a1',
    monitoringSessions: 'Codex Navo \u4f1a\u6301\u7eed\u76d1\u63a7\u672c\u673a\u4f1a\u8bdd', taskProgress: '\u5f53\u524d\u4efb\u52a1\u8fdb\u5ea6', idle: '\u7a7a\u95f2',
    taskInput: '\u4efb\u52a1\u8f93\u5165', taskCache: '\u4efb\u52a1\u7f13\u5b58', taskOutput: '\u4efb\u52a1\u8f93\u51fa', windowStyle: '\u60ac\u6d6e\u7a97\u6837\u5f0f',
    glass: '\u73bb\u7483', midnight: '\u6df1\u8272', paper: '\u6d45\u8272', opacity: '\u900f\u660e\u5ea6', waitingData: '\u7b49\u5f85\u672c\u5730\u6570\u636e',
    dragHint: '\u62d6\u52a8\u9876\u90e8\u53ef\u79fb\u52a8', shortcutHint: 'Ctrl+Alt+N \u5feb\u901f\u5524\u51fa', settings: '\u60ac\u6d6e\u7a97\u8bbe\u7f6e', hide: '\u9690\u85cf\u60ac\u6d6e\u7a97', pin: '\u7f6e\u9876\u60ac\u6d6e\u7a97', unpin: '\u53d6\u6d88\u7f6e\u9876',
    notRunning: 'Codex \u672a\u8fd0\u884c', externalCodex: '\u5916\u90e8 Codex', external: '\u5916\u90e8', account: '\u666e\u901a\u8d26\u53f7', offline: '\u79bb\u7ebf',
    running: '\u8fd0\u884c\u4e2d', waitingInput: '\u7b49\u5f85\u8f93\u5165', waitingApproval: '\u7b49\u5f85\u6388\u6743', updated: '\u66f4\u65b0',
    waitingService: '\u7b49\u5f85\u672c\u5730\u670d\u52a1', untitledSession: '\u672a\u547d\u540d\u4f1a\u8bdd', refreshQuota: '\u5237\u65b0\u989d\u5ea6', refreshFailed: '\u989d\u5ea6\u5237\u65b0\u5931\u8d25',
  },
};

function t(key) { return messages[locale][key] || messages.en[key] || key; }

function applyLocale() {
  document.documentElement.lang = locale;
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  elements.settings_toggle.title = t('settings');
  elements.settings_toggle.setAttribute('aria-label', t('settings'));
  elements.widget_hide.title = t('hide');
  elements.widget_hide.setAttribute('aria-label', t('hide'));
  elements.quota_refresh.title = t('refreshQuota');
  elements.quota_refresh.setAttribute('aria-label', t('refreshQuota'));
}

function taskStatusLabel(status) {
  return ({ running: t('running'), waiting_input: t('waitingInput'), waiting_approval: t('waitingApproval') })[status] || t('waitingTask');
}

let currentSettings = { theme: 'glass', opacity: 92, pinned: true };

function compactNumber(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 1000) return number.toLocaleString(locale);
  const [divisor, suffix] = number >= 1_000_000_000
    ? [1_000_000_000, 'B']
    : number >= 1_000_000 ? [1_000_000, 'M'] : [1_000, 'K'];
  return `${Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(number / divisor)}${suffix}`;
}

function applySettings(settings = {}) {
  currentSettings = { ...currentSettings, ...settings };
  const theme = ['glass', 'midnight', 'paper'].includes(settings.theme) ? settings.theme : 'glass';
  const opacity = Math.max(35, Math.min(100, Number(settings.opacity) || 92));
  const pinned = settings.pinned !== false;
  document.body.dataset.theme = theme;
  elements.opacity_input.value = String(opacity);
  elements.opacity_value.textContent = `${opacity}%`;
  document.querySelectorAll('[data-theme-value]').forEach((button) => button.classList.toggle('active', button.dataset.themeValue === theme));
  elements.pin_toggle.classList.toggle('active', pinned);
  elements.pin_toggle.title = t(pinned ? 'unpin' : 'pin');
  elements.pin_toggle.setAttribute('aria-label', t(pinned ? 'unpin' : 'pin'));
}

function render(data = {}) {
  latestData = data;
  const account = data.account || {};
  const usage = data.usage || {};
  const quota = account.quotaRemaining === null || account.quotaRemaining === undefined ? Number.NaN : Number(account.quotaRemaining);
  const accountLabel = account.label === 'External Codex' ? t('externalCodex') : account.label === 'Codex not running' ? t('notRunning') : account.label;
  elements.account_name.textContent = accountLabel || t('notRunning');
  elements.account_type.textContent = account.type === 'api' ? 'API CODEX' : account.type === 'account' ? t('account') : account.type === 'external' ? t('external') : t('offline');
  elements.quota_value.textContent = Number.isFinite(quota) ? `${quota.toFixed(quota % 1 ? 1 : 0)}%` : '—';
  elements.quota_bar.style.width = Number.isFinite(quota) ? `${Math.max(0, Math.min(100, quota))}%` : '0%';
  elements.usage_input.textContent = compactNumber(usage.input);
  elements.usage_cache.textContent = compactNumber(usage.cachedInput);
  elements.usage_cache_rate.textContent = Number(usage.input) > 0 ? `${Math.min(100, Math.max(0, Number(usage.cachedInput) / Number(usage.input) * 100)).toFixed(1)}%` : '0%';
  elements.usage_output.textContent = compactNumber(usage.output);

  const task = data.task;
  elements.task_progress.className = `task-progress ${task ? (task.status.startsWith('waiting') ? 'waiting' : 'running') : 'idle'}`;
  elements.task_state.textContent = task ? taskStatusLabel(task.status) : t('waitingTask');
  elements.task_title.textContent = task?.title === 'Untitled session' ? t('untitledSession') : task?.title || t('noActiveTask');
  elements.task_project.textContent = task?.project || t('monitoringSessions');
  elements.task_activity.textContent = task ? taskStatusLabel(task.status) : t('idle');
  elements.task_input.textContent = task ? compactNumber(task.usage?.input) : '—';
  elements.task_cache.textContent = task ? compactNumber(task.usage?.cachedInput) : '—';
  elements.task_output.textContent = task ? compactNumber(task.usage?.output) : '—';
  const updated = new Date(data.updatedAt || Date.now());
  elements.updated_at.textContent = `${t('updated')} ${updated.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;
}

function updateLocale(value) {
  locale = normalizedLocale(value);
  applyLocale();
  applySettings(currentSettings);
  if (latestData) render(latestData);
}

async function refresh() {
  try {
    const response = await fetch('/api/floating-status', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    render(payload.data);
  } catch {
    elements.updated_at.textContent = t('waitingService');
  }
}

let csrfToken = '';
async function ensureCsrfToken() {
  if (csrfToken) return csrfToken;
  const response = await fetch('/api/bootstrap', { cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  csrfToken = payload.data.csrfToken;
  return csrfToken;
}

elements.settings_toggle.addEventListener('click', () => {
  elements.settings_panel.hidden = !elements.settings_panel.hidden;
  window.codexFloating?.setExpanded(!elements.settings_panel.hidden);
});
elements.widget_hide.addEventListener('click', () => window.codexFloating?.hide());
elements.quota_refresh.addEventListener('click', async () => {
  if (elements.quota_refresh.classList.contains('loading')) return;
  elements.quota_refresh.classList.add('loading');
  elements.quota_refresh.disabled = true;
  try {
    const response = await fetch('/api/floating-status/refresh', {
      method: 'POST', headers: { 'X-CSRF-Token': await ensureCsrfToken() },
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    render(payload.data);
  } catch (error) {
    elements.updated_at.textContent = `${t('refreshFailed')}: ${error.message}`;
  } finally {
    elements.quota_refresh.classList.remove('loading');
    elements.quota_refresh.disabled = false;
  }
});
elements.pin_toggle.addEventListener('click', async () => {
  applySettings(await window.codexFloating?.updateSettings({ pinned: currentSettings.pinned === false }));
});
document.querySelectorAll('[data-theme-value]').forEach((button) => button.addEventListener('click', async () => {
  applySettings(await window.codexFloating?.updateSettings({ theme: button.dataset.themeValue }));
}));
elements.opacity_input.addEventListener('input', () => { elements.opacity_value.textContent = `${elements.opacity_input.value}%`; });
elements.opacity_input.addEventListener('change', async () => {
  applySettings(await window.codexFloating?.updateSettings({ opacity: Number(elements.opacity_input.value) }));
});

(async () => {
  applyLocale();
  applySettings(await window.codexFloating?.getSettings?.());
  window.codexFloating?.onSettings?.(applySettings);
  window.codexFloating?.onLocale?.(updateLocale);
  window.addEventListener('storage', (event) => {
    if (event.key === 'codex-navo-app-locale') updateLocale(event.newValue || systemLocale);
  });
  await refresh();
  setInterval(refresh, 2000);
})();

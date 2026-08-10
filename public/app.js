const state = { accounts: [], csrfToken: '', timer: null, quotaRefreshing: false, wakeSettings: {}, wakeModelOptions: [], usage: null, importPackageText: '', accountImportPackageText: '', protocolDialogAccountId: '', protocolDialogPromptKind: '' };
let toolsStatusTimer = null;
const elements = {
  accounts: document.querySelector('#accounts'),
  summary: document.querySelector('#account-summary'),
  dialog: document.querySelector('#account-dialog'),
  form: document.querySelector('#account-form'),
  accountDialogStatus: document.querySelector('#account-dialog-status'),
  accountImportPanel: document.querySelector('#account-import-panel'),
  accountImportPackageFile: document.querySelector('#account-import-package-file'),
  accountImportFileName: document.querySelector('#account-import-file-name'),
  accountSubmit: document.querySelector('#account-submit'),
  protocolProgress: document.querySelector('#protocol-dialog-progress'),
  protocolProgressTitle: document.querySelector('#protocol-progress-title'),
  protocolProgressCopy: document.querySelector('#protocol-progress-copy'),
  protocolProgressInput: document.querySelector('#protocol-progress-input'),
  protocolProgressCancel: document.querySelector('#protocol-progress-cancel'),
  protocolProgressRetry: document.querySelector('#protocol-progress-retry'),
  protocolProgressClose: document.querySelector('#protocol-progress-close'),
  toast: document.querySelector('#toast'),
  currentCodex: document.querySelector('#current-codex'),
  closeExternalCodex: document.querySelector('#close-external-codex'),
  sortMenu: document.querySelector('#sort-menu'),
  sortTrigger: document.querySelector('#sort-trigger'),
  sortLabel: document.querySelector('#sort-label'),
  sortPopover: document.querySelector('#sort-popover'),
  viewSwitcher: document.querySelector('#view-switcher'),
  refreshAllQuotas: document.querySelector('#refresh-all-quotas'),
  wakeAll: document.querySelector('#wake-all'),
  wakeSettingsButton: document.querySelector('#wake-settings-button'),
  wakeDialog: document.querySelector('#wake-dialog'),
  wakeForm: document.querySelector('#wake-form'),
  wakeModelHelp: document.querySelector('#wake-model-help'),
  accountToolsButton: document.querySelector('#account-tools-button'),
  accountToolsDialog: document.querySelector('#account-tools-dialog'),
  healthList: document.querySelector('#health-list'),
  checkAllHealth: document.querySelector('#check-all-health'),
  toolsStatus: document.querySelector('#tools-status'),
  exportAccount: document.querySelector('#export-account'),
  exportAuthPackage: document.querySelector('#export-auth-package'),
  importPackageFile: document.querySelector('#import-package-file'),
  importFileName: document.querySelector('#import-file-name'),
  importAuthPackage: document.querySelector('#import-auth-package'),
  updateChip: document.querySelector('#update-chip'),
  updateDialog: document.querySelector('#update-dialog'),
  updateDialogTitle: document.querySelector('#update-dialog-title'),
  updateDialogCopy: document.querySelector('#update-dialog-copy'),
  updateProgress: document.querySelector('#update-progress'),
  updateProgressBar: document.querySelector('#update-progress-bar'),
  updateProgressLabel: document.querySelector('#update-progress-label'),
  updateNotes: document.querySelector('#update-notes'),
  updatePrimaryAction: document.querySelector('#update-primary-action'),
  usageOverview: document.querySelector('#usage-overview'),
  usageLedger: document.querySelector('#usage-ledger'),
  usageUpdated: document.querySelector('#usage-updated'),
  usageRange: document.querySelector('#usage-range'),
};


let applicationUpdate = {
  status: 'idle',
  currentVersion: '',
  availableVersion: '',
  percent: 0,
  releaseNotes: '',
  error: '',
};

function renderApplicationUpdate() {
  if (!window.codexUpdater) {
    elements.updateChip.hidden = true;
    return;
  }

  const status = applicationUpdate.status;
  const currentVersion = applicationUpdate.currentVersion || '';
  const availableVersion = applicationUpdate.availableVersion || '';
  const percent = Math.max(0, Math.min(100, Number(applicationUpdate.percent) || 0));
  const labels = {
    idle: currentVersion ? `v${currentVersion}` : '检查更新',
    development: currentVersion ? `v${currentVersion}` : '开发模式',
    checking: '正在检查',
    current: currentVersion ? `v${currentVersion}` : '已是最新版',
    available: `v${availableVersion} 可更新`,
    downloading: `下载 ${percent}%`,
    downloaded: '重启更新',
    error: '更新检查失败',
  };

  elements.updateChip.hidden = false;
  elements.updateChip.className = `update-chip ${status}`;
  elements.updateChip.querySelector('span').textContent = labels[status] || labels.idle;
  elements.updateChip.setAttribute('aria-label', status === 'available' || status === 'downloaded'
    ? '打开应用更新'
    : '检查应用更新');

  elements.updateDialogTitle.textContent = status === 'available'
    ? `发现 v${availableVersion}`
    : status === 'downloaded'
      ? '更新已准备好'
      : status === 'error'
        ? '更新检查失败'
        : '应用更新';
  elements.updateDialogCopy.textContent = status === 'available'
    ? `当前版本 v${currentVersion}。下载完成后由你决定何时重启安装。`
    : status === 'downloading'
      ? '正在后台下载更新，账号数据和登录环境不会被覆盖。'
      : status === 'downloaded'
        ? '更新已经下载完成。重启应用即可安装，正在运行的 Codex 不会被强制关闭。'
        : status === 'current'
          ? `当前 v${currentVersion} 已是最新版。`
          : status === 'development'
            ? '开发模式不会连接更新服务，请安装本地构建的 Setup 版本测试。'
            : status === 'error'
              ? (applicationUpdate.error || '无法连接更新服务，请稍后重试。')
              : '检查 GitHub Releases 是否有新版本。';

  elements.updateProgress.hidden = status !== 'downloading';
  elements.updateProgressBar.style.width = `${percent}%`;
  elements.updateProgressLabel.textContent = `${percent}%`;
  const notes = String(applicationUpdate.releaseNotes || '').trim();
  elements.updateNotes.hidden = !(notes && status === 'available');
  elements.updateNotes.textContent = notes;

  elements.updatePrimaryAction.hidden = status === 'downloading';
  elements.updatePrimaryAction.disabled = status === 'checking';
  elements.updatePrimaryAction.dataset.action = status === 'available'
    ? 'download'
    : status === 'downloaded'
      ? 'install'
      : 'check';
  elements.updatePrimaryAction.textContent = status === 'available'
    ? '下载更新'
    : status === 'downloaded'
      ? '重启并安装'
      : status === 'checking'
        ? '正在检查'
        : '重新检查';
}

async function initializeApplicationUpdater() {
  if (!window.codexUpdater) return;
  try {
    applicationUpdate = await window.codexUpdater.getState();
    renderApplicationUpdate();
    window.codexUpdater.onState((nextState) => {
      applicationUpdate = nextState;
      renderApplicationUpdate();
    });
  } catch {
    elements.updateChip.hidden = true;
  }
}

const sortStorageKey = 'codex-manager-account-sort';
const viewStorageKey = 'codex-navo-account-view';
const usageRangeStorageKey = 'codex-navo-usage-range';
const collapsedUsageStorageKey = 'codex-navo-collapsed-account-usage';
const sortLabels = {
  current: '当前账号优先',
  'quota-desc': '额度：高到低',
  'quota-asc': '额度：低到高',
  name: '账号名称',
  created: '最近添加',
};
state.sortMode = localStorage.getItem(sortStorageKey) || 'current';
state.viewMode = localStorage.getItem(viewStorageKey) === 'grid' ? 'grid' : 'list';
state.usageRange = ['today', 'yesterday', '7d', '30d', 'all'].includes(localStorage.getItem(usageRangeStorageKey))
  ? localStorage.getItem(usageRangeStorageKey)
  : 'today';
try {
  state.collapsedUsage = new Set(JSON.parse(localStorage.getItem(collapsedUsageStorageKey) || '[]'));
} catch {
  state.collapsedUsage = new Set();
}

function applyViewMode() {
  elements.accounts.classList.toggle('account-grid', state.viewMode === 'grid');
  elements.viewSwitcher.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.viewMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function formatPlan(planType) {
  const normalized = String(planType || '').trim().toLowerCase();
  const labels = {
    plus: 'PLUS',
    pro: 'PRO',
    team: 'TEAM',
    business: 'BUSINESS',
    enterprise: 'ENTERPRISE',
    edu: 'EDU',
    free: 'FREE',
  };
  return labels[normalized] || normalized.toUpperCase();
}

function creditQuantity(credits) {
  const candidate = credits?.quantity ?? credits?.points ?? credits?.rawBalance;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function formatCredits(credits) {
  if (!credits) return '';
  if (credits.unlimited) return 'Credits ∞';
  const quantity = creditQuantity(credits);
  if (quantity == null) return '';
  return `Credits ${quantity.toLocaleString('en-US')}`;
}

function formatUsdBalance(credits) {
  if (!credits || credits.unlimited) return '';
  const amount = Number(credits.usdBalance);
  return Number.isFinite(amount)
    ? `US$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '';
}

function weeklyRemaining(account) {
  const weekly = account.quota?.windows?.find((window) => Number(window.windowDurationMins) >= 6 * 24 * 60)
    || account.quota?.windows?.[0];
  const remaining = Number(weekly?.remainingPercent);
  return Number.isFinite(remaining) ? remaining : null;
}

function formatTokenCount(value, compact = false) {
  const number = Math.max(0, Number(value) || 0);
  return compact && number >= 10_000
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(number)
    : Math.round(number).toLocaleString('en-US');
}

function formatYiTokenNote(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 100_000_000) return '';
  const amount = (number / 100_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return `<em class="token-scale-note">约 ${amount} 亿</em>`;
}

function formatUsageCost(usage) {
  if (!usage || !usage.pricedRequests) return '—';
  const value = Number(usage.estimatedCostUsd) || 0;
  const digits = value < 0.01 ? 4 : 2;
  return `${usage.unpricedRequests ? '≥' : ''}US$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function formatCacheHitRate(usage) {
  const inputTokens = Math.max(0, Number(usage?.inputTokens) || 0);
  if (!inputTokens) return '—';
  const cachedTokens = Math.max(0, Number(usage?.cachedInputTokens) || 0);
  const percentage = Math.min(100, cachedTokens / inputTokens * 100);
  return `${percentage.toLocaleString('zh-CN', { minimumFractionDigits: percentage === 100 ? 0 : 1, maximumFractionDigits: 1 })}%`;
}

function renderUsage() {
  const usage = state.usage || {};
  const totals = usage.totals || {};
  elements.usageRange.querySelectorAll('[data-range]').forEach((button) => {
    const active = button.dataset.range === state.usageRange;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const updated = usage.updatedAt ? new Date(usage.updatedAt) : null;
  elements.usageUpdated.textContent = updated && !Number.isNaN(updated.getTime())
    ? `更新于 ${updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`
    : '从启用统计后开始记录';
  elements.usageLedger.innerHTML = `
    <div class="usage-primary">
      <div><span>总 Token</span>${formatYiTokenNote(totals.totalTokens)}<strong title="${formatTokenCount(totals.totalTokens)}">${formatTokenCount(totals.totalTokens, true)}</strong><small>输入与输出合计</small></div>
      <div class="usage-cost"><span>Token 估值</span><strong>${formatUsageCost(totals)}</strong><small>${totals.unpricedRequests ? `${formatTokenCount(totals.unpricedRequests)} 次待定价` : '按 API Token 公价估算'}</small></div>
    </div>
    <div class="usage-breakdown">
      <div class="usage-metric"><span>模型调用</span><strong>${formatTokenCount(totals.requests)}</strong><small>${state.usageRange === 'today' ? '近实时记录' : '所选时段'}</small></div>
      <div class="usage-metric"><span>输入</span><strong title="${formatTokenCount(totals.inputTokens)}">${formatTokenCount(totals.inputTokens, true)}</strong><small>缓存 ${formatTokenCount(totals.cachedInputTokens, true)} · 命中 ${formatCacheHitRate(totals)}</small></div>
      <div class="usage-metric"><span>输出</span><strong title="${formatTokenCount(totals.outputTokens)}">${formatTokenCount(totals.outputTokens, true)}</strong><small>其中推理 ${formatTokenCount(totals.reasoningOutputTokens, true)}</small></div>
    </div>`;
}

function renderAccountUsage(account) {
  const usage = state.usage?.accounts?.[account.id] || {};
  const rangeLabels = { today: '今日用量', yesterday: '昨日用量', '7d': '近 7 天', '30d': '近 30 天', all: '全部记录' };
  const collapsed = state.viewMode === 'list' && state.collapsedUsage.has(account.id);
  return `<div class="account-usage-strip${collapsed ? ' collapsed' : ''}" aria-label="账号用量">
    <div class="account-usage-title">
      <span><i></i>${rangeLabels[state.usageRange] || '用量'}</span>
      <div class="account-usage-total"><strong title="${formatTokenCount(usage.totalTokens)}">${formatTokenCount(usage.totalTokens, true)} <small>Token</small></strong>${formatYiTokenNote(usage.totalTokens)}<button class="usage-collapse-button" data-action="toggle-usage" type="button" aria-expanded="${!collapsed}" aria-label="${collapsed ? '展开账号用量' : '收起账号用量'}" title="${collapsed ? '展开用量' : '收起用量'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"></path></svg></button></div>
    </div>
    <div class="account-usage-line">
      <b>${formatTokenCount(usage.requests)} <small>模型调用</small></b>
      <b class="usage-estimate">${formatUsageCost(usage)} <small>Token 估值</small></b>
      <span>输入 ${formatTokenCount(usage.inputTokens, true)} · 缓存 ${formatTokenCount(usage.cachedInputTokens, true)} · 命中 ${formatCacheHitRate(usage)} · 输出 ${formatTokenCount(usage.outputTokens, true)}</span>
    </div>
  </div>`;
}

function sortedAccounts(activeAccount) {
  const accounts = state.accounts.map((account, index) => ({ account, index }));
  const mode = state.sortMode;
  accounts.sort((left, right) => {
    const a = left.account;
    const b = right.account;
    if (mode === 'current') {
      const activeDifference = Number(b.id === activeAccount?.id) - Number(a.id === activeAccount?.id);
      return activeDifference || left.index - right.index;
    }
    if (mode === 'quota-desc' || mode === 'quota-asc') {
      const aQuota = weeklyRemaining(a);
      const bQuota = weeklyRemaining(b);
      if (aQuota === null || bQuota === null) {
        if (aQuota === null && bQuota === null) return left.index - right.index;
        return aQuota === null ? 1 : -1;
      }
      return mode === 'quota-desc' ? bQuota - aQuota : aQuota - bQuota;
    }
    if (mode === 'name') {
      return String(a.label || '').localeCompare(String(b.label || ''), 'zh-CN', { sensitivity: 'base' });
    }
    if (mode === 'created') {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    }
    return left.index - right.index;
  });
  return accounts.map(({ account }) => account);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => { elements.toast.className = 'toast'; }, 3200);
}

function showAccountDialogError(message) {
  elements.accountDialogStatus.textContent = String(message || '操作失败');
  elements.accountDialogStatus.className = 'account-dialog-status error';
  elements.accountDialogStatus.hidden = false;
}

async function readAuthorizationPackageFile(file, { onName, onClear }) {
  if (!file) {
    onName('选择 .codexnavo 文件');
    return '';
  }
  onName(file.name);
  if (file.size > 768 * 1024) {
    onClear();
    onName('文件过大，请选择有效授权包');
    throw new Error('授权包文件过大');
  }
  try {
    return await file.text();
  } catch {
    throw new Error('无法读取授权包文件');
  }
}

function syncAccountLoginMethod() {
  const method = String(new FormData(elements.form).get('loginMethod') || 'official');
  const importing = method === 'import';
  const protocol = method === 'protocol';
  const more = elements.form.querySelector('.login-method-more');
  const labelInput = elements.form.elements.label;
  const emailInput = elements.form.elements.emailHint;
  elements.accountImportPanel.hidden = !importing;
  if (more) more.open = method !== 'official';
  elements.form.querySelectorAll('.account-manual-field').forEach((field) => { field.hidden = importing; });
  labelInput.required = !importing;
  labelInput.disabled = importing;
  emailInput.disabled = importing;
  emailInput.placeholder = protocol ? '完整邮箱，例如：name@example.com' : '例如：de***@company.com';
  elements.accountSubmit.textContent = importing ? '导入账号' : '登录并授权';
}

function renderProtocolPrompt(login, action = 'protocol-input') {
  const kind = String(login?.promptKind || '');
  const otp = ['email_otp', 'totp', 'phone_otp'].includes(kind);
  const phone = kind === 'phone';
  const type = kind === 'password' ? 'password' : phone ? 'tel' : 'text';
  const autocomplete = kind === 'password' ? 'current-password' : otp ? 'one-time-code' : 'off';
  const inputMode = otp ? 'numeric' : phone ? 'tel' : 'text';
  const submitLabel = phone ? '确认手机号' : kind === 'password' ? '确认密码' : otp ? '确认验证码' : '确认';
  const maxlength = phone ? 16 : otp ? 8 : 256;
  return `<strong>${escapeHtml(login.promptLabel || '继续验证')}</strong>
    <small>${escapeHtml(login.promptHint || '输入仅传给当前登录进程，不会保存。')}</small>
    <div class="protocol-inline-input" data-prompt-kind="${escapeHtml(kind)}">
      <input type="${type}" inputmode="${inputMode}" autocomplete="${autocomplete}" maxlength="${maxlength}" placeholder="${escapeHtml(login.promptLabel || '请输入')}" aria-label="${escapeHtml(login.promptLabel || '协议登录输入')}">
      <button data-action="${escapeHtml(action)}" type="button">${submitLabel}</button>
    </div>`;
}

function resetProtocolDialog() {
  state.protocolDialogAccountId = '';
  state.protocolDialogPromptKind = '';
  elements.form.classList.remove('protocol-progress-active');
  elements.protocolProgress.hidden = true;
  elements.protocolProgress.className = 'protocol-dialog-progress';
  elements.protocolProgressInput.innerHTML = '';
  elements.form.querySelector('.dialog-head .eyebrow').textContent = 'NEW TRACK';
  elements.form.querySelector('.dialog-head h2').textContent = '添加账号环境';
}

function openProtocolDialog(account) {
  state.protocolDialogAccountId = account.id;
  state.protocolDialogPromptKind = '';
  elements.form.classList.add('protocol-progress-active');
  elements.protocolProgress.hidden = false;
  elements.form.querySelector('.dialog-head .eyebrow').textContent = 'PROTOCOL LOGIN';
  elements.form.querySelector('.dialog-head h2').textContent = '登录并授权';
  renderProtocolDialogProgress();
}

function renderProtocolDialogProgress() {
  if (!state.protocolDialogAccountId || !elements.dialog.open) return;
  const account = state.accounts.find((item) => item.id === state.protocolDialogAccountId);
  if (!account) return;
  const login = account.codexLogin;
  const completed = account.codexInitialized && !login;
  const failed = ['error', 'interrupted'].includes(login?.status);
  elements.protocolProgress.className = `protocol-dialog-progress${completed ? ' success' : failed ? ' error' : ''}`;
  elements.protocolProgressTitle.textContent = completed ? '账号已完成入池' : failed ? '登录授权未完成' : account.label;
  elements.protocolProgressCopy.textContent = completed
    ? '网页登录凭证与 Codex 授权已经写入独立账号环境。'
    : failed
      ? (login?.error || '登录进程已经结束，可以重新发起。')
      : login?.status === 'finalizing'
        ? (login.promptHint || '正在校验并写入 Codex 登录凭证。')
        : login?.promptKind
          ? '请在下方完成当前验证步骤，内容只传给本次登录进程。'
          : '后台正在推进 ChatGPT 网页登录与 Codex 授权，请稍候。';
  const nextPromptKind = String(login?.promptKind || '');
  if (state.protocolDialogPromptKind !== nextPromptKind) {
    state.protocolDialogPromptKind = nextPromptKind;
    elements.protocolProgressInput.innerHTML = nextPromptKind ? renderProtocolPrompt(login, 'protocol-modal-input') : '';
    elements.protocolProgressInput.querySelector('input')?.focus();
  }
  elements.protocolProgressCancel.hidden = completed;
  elements.protocolProgressRetry.hidden = !failed;
  elements.protocolProgressClose.hidden = !completed;
}

function showProtocolDialogConnectionError(message) {
  if (!state.protocolDialogAccountId || !elements.dialog.open) return false;
  const detail = String(message || '本地服务连接中断');
  elements.protocolProgress.className = 'protocol-dialog-progress error';
  elements.protocolProgressTitle.textContent = '后台服务连接中断';
  elements.protocolProgressCopy.textContent = `${detail}。Codex Navo 正在尝试恢复后台服务；关闭弹窗后可重新发起授权。`;
  elements.protocolProgressInput.innerHTML = '';
  elements.protocolProgressCancel.hidden = true;
  elements.protocolProgressRetry.hidden = true;
  elements.protocolProgressClose.hidden = false;
  showAccountDialogError(`后台服务连接中断：${detail}`);
  return true;
}

function hideToolsStatus() {
  clearTimeout(toolsStatusTimer);
  toolsStatusTimer = null;
  elements.toolsStatus.hidden = true;
  elements.toolsStatus.replaceChildren();
}

function showToolsStatus(message, error = false, autoHideMs = error ? 0 : 5_000) {
  clearTimeout(toolsStatusTimer);
  elements.toolsStatus.hidden = false;
  elements.toolsStatus.className = `tools-status${error ? ' error' : ' success'}`;
  const copy = document.createElement('span');
  copy.className = 'tools-status-copy';
  copy.textContent = message;
  const close = document.createElement('button');
  close.className = 'tools-status-close';
  close.type = 'button';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', hideToolsStatus, { once: true });
  elements.toolsStatus.replaceChildren(copy, close);
  if (autoHideMs > 0) toolsStatusTimer = setTimeout(hideToolsStatus, autoHideMs);
}

function syncModalScrollLock() {
  const open = Boolean(document.querySelector('dialog[open]'));
  document.documentElement.classList.toggle('modal-open', open);
  document.body.classList.toggle('modal-open', open);
}

const modalObserver = new MutationObserver(syncModalScrollLock);
document.querySelectorAll('dialog').forEach((dialog) => modalObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] }));

function setSortMenuOpen(open) {
  elements.sortPopover.hidden = !open;
  elements.sortTrigger.setAttribute('aria-expanded', String(open));
  elements.sortMenu.classList.toggle('open', open);
}

function syncSortMenu() {
  elements.sortLabel.textContent = sortLabels[state.sortMode] || sortLabels.current;
  elements.sortPopover.querySelectorAll('[data-sort]').forEach((button) => {
    const active = button.dataset.sort === state.sortMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(url, { ...options, headers });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('本地服务返回了无法识别的内容'); }
  if (!response.ok || !payload.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload.data;
}

function renderHealthCenter() {
  elements.healthList.innerHTML = state.accounts.length
    ? state.accounts.map((account) => {
      const health = account.health || { status: 'attention', label: '等待检查', detail: '尚未读取授权状态' };
      const action = ['needs_auth', 'expired', 'invalid', 'interrupted'].includes(health.status)
        ? `<button type="button" data-health-action="authorize" data-account-id="${account.id}">${health.status === 'interrupted' ? '继续' : '授权'}</button>`
        : `<button type="button" data-health-action="check" data-account-id="${account.id}">检查</button>`;
      return `<div class="health-row" data-health="${escapeHtml(health.status)}">
        <div class="health-account" title="${escapeHtml(account.label)}">${escapeHtml(account.label)}</div>
        <div class="health-state"><i></i>${escapeHtml(health.label)}</div>
        <div class="health-detail" title="${escapeHtml(health.detail)}">${escapeHtml(health.detail)}</div>
        ${action}
      </div>`;
    }).join('')
    : '<div class="health-empty">账号池为空，暂无可检查的授权。</div>';

  const selected = elements.exportAccount.value;
  elements.exportAccount.replaceChildren();
  for (const account of state.accounts.filter((item) => item.codexInitialized)) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.label;
    elements.exportAccount.append(option);
  }
  if ([...elements.exportAccount.options].some((option) => option.value === selected)) elements.exportAccount.value = selected;
  elements.exportAuthPackage.disabled = !elements.exportAccount.value;
}

function downloadJsonFile(fileName, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function operator() {
  return '本机用户';
}

function formatReset(timestamp) {
  if (!timestamp) return '重置时间未知';
  const reset = new Date(timestamp * 1000);
  const remaining = Math.max(0, reset.getTime() - Date.now());
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  const dateText = reset.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${parts.join(' ')} (${dateText})`;
}

function quotaLabel(window) {
  return Number(window.windowDurationMins) >= 6 * 24 * 60 ? 'Weekly' : window.label;
}

function renderQuota(account) {
  if (account.quotaErrorCode === 'auth_expired') {
    return `<div class="quota-panel quota-unavailable quota-error"><div class="quota-empty-title">登录已失效</div><p>重新授权后会自动读取额度</p></div>`;
  }
  if (!account.codexInitialized) {
    return `<div class="quota-panel quota-unavailable"><div class="quota-empty-title">等待登录授权</div><p>在独立浏览器完成官方流程后会自动入池</p></div>`;
  }
  if (!account.quota?.windows?.length) {
    return account.quotaError
      ? `<div class="quota-panel quota-unavailable quota-error-soft"><div class="quota-empty-title">额度刷新失败</div><p>${escapeHtml(account.quotaError)}，可点击右侧刷新按钮重试</p></div>`
      : `<div class="quota-panel quota-unavailable"><div class="quota-empty-title">正在读取额度</div><p>已入池账号会自动刷新</p></div>`;
  }
  const windows = account.quota.windows.slice(0, 2).map((window) => {
    const remaining = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
    const tone = remaining >= 70 ? 'healthy' : remaining >= 30 ? 'warning' : 'critical';
    return `<div class="quota-window ${tone}">
      <div class="quota-line"><span>${escapeHtml(quotaLabel(window))}</span><strong>${remaining}%</strong></div>
      <progress class="quota-track" aria-label="${escapeHtml(quotaLabel(window))}可用额度" value="${remaining}" max="100">${remaining}%</progress>
      <div class="quota-reset">${escapeHtml(formatReset(window.resetsAt))}</div>
    </div>`;
  }).join('');
  const errorNotice = account.quotaError
    ? `<div class="quota-refresh-error"><span>刷新失败，当前显示上次数据</span><button data-action="quota" type="button">重试</button></div>`
    : '';
  return `<div class="quota-panel">${windows}${errorNotice}</div>`;
}

function render() {
  renderProtocolDialogProgress();
  applyViewMode();
  renderUsage();
  const occupied = state.accounts.filter((account) => account.lease || account.codexActive).length;
  elements.summary.innerHTML = `<span><strong>${state.accounts.length}</strong> 个账号</span><i aria-hidden="true"></i><span class="${occupied ? 'has-active' : ''}"><strong>${occupied}</strong> 使用中</span>`;
  const activeAccount = state.accounts.find((account) => account.codexActive);
  const externalCodexRunning = Boolean(state.codexRunning && !activeAccount);
  elements.currentCodex.classList.toggle('active', Boolean(activeAccount));
  elements.currentCodex.classList.toggle('external', externalCodexRunning);
  elements.closeExternalCodex.hidden = !externalCodexRunning;
  elements.currentCodex.querySelector('span').textContent = activeAccount
    ? `当前 Codex · ${activeAccount.label}`
    : externalCodexRunning
      ? '外部 Codex 正在运行'
      : 'Codex 未启动';
  if (!state.accounts.length) {
    elements.accounts.classList.add('is-empty');
    elements.accounts.innerHTML = `<div class="empty-state"><strong>暂无账号</strong><p>点击右上角“添加账号”创建第一个独立登录环境。</p></div>`;
    return;
  }

  elements.accounts.classList.remove('is-empty');

  elements.accounts.innerHTML = sortedAccounts(activeAccount).map((account) => {
    const status = account.enabled === false ? 'disabled' : account.lease || account.codexActive ? 'occupied' : 'free';
    const codexLoginPending = account.codexLogin && ['starting', 'waiting', 'finalizing'].includes(account.codexLogin.status);
    const setupSteps = !account.codexInitialized ? `<div class="setup-steps one-step" aria-label="账号入池进度">
      <span class="active"><i>1</i>${account.setupStage === 'device-auth' ? '设备代码授权' : '登录并授权'}</span>
    </div>` : '';
    const codexLoginPanel = account.codexLogin ? `<div class="codex-login-panel ${['error', 'interrupted'].includes(account.codexLogin.status) ? 'error' : ''}">
      ${setupSteps}
      ${['error', 'interrupted'].includes(account.codexLogin.status)
        ? `<strong>${account.codexLogin.status === 'interrupted' ? '授权流程已中断' : '登录授权未完成'}</strong><span>${escapeHtml(account.codexLogin.error)}</span><div class="login-recovery-actions"><button class="login-fallback" data-action="${account.loginMethod === 'protocol' ? 'authorize-protocol' : 'authorize'}" type="button">继续授权</button>${account.codexLogin.status === 'error' && account.loginMethod === 'protocol' ? '<button class="login-fallback" data-action="authorize" type="button">改用官方登录</button>' : account.codexLogin.status === 'error' ? '<button class="login-fallback" data-action="authorize-device" type="button">设备代码</button>' : ''}<button class="login-cancel" data-action="cancel-authorization" type="button">取消</button></div>`
        : account.codexLogin.flow === 'protocol'
        ? account.codexLogin.promptKind
            ? renderProtocolPrompt(account.codexLogin)
            : account.codexLogin.status === 'finalizing'
              ? '<strong>正在完成登录与授权</strong><small>正在写入独立 Chrome 网页会话和 Codex OAuth 凭证，请稍候。</small>'
              : '<strong>登录与 Codex 授权正在后台运行</strong><small>需要邮箱验证码、密码、两步验证、手机号或短信验证码时，会在这里显示输入框。</small>'
        : account.codexLogin.flow === 'device'
          ? `<strong>请在独立浏览器中完成设备代码授权</strong><span>设备验证码</span><code>${escapeHtml(account.codexLogin.userCode || '正在获取…')}</code><small>备用流程需要先在 ChatGPT 设置中开启设备代码授权。</small>`
          : `<strong>请在独立浏览器中完成登录与授权</strong><small>这是一个连续的官方流程，完成后会自动入池，无需开启设备代码授权。</small>`}
    </div>` : account.webLoginComplete && !account.codexInitialized ? `<div class="codex-login-panel setup-ready">
      ${setupSteps}
      <strong>网页端已登录并入池</strong>
      <small>该账号的独立 Chrome 会话已经验证；点击右侧按钮继续完成 Codex 授权。</small>
    </div>` : !account.codexInitialized ? `<div class="codex-login-panel setup-ready">
      ${setupSteps}
      <strong>登录授权尚未完成</strong>
      <small>点击“登录并授权”，在该账号的独立 Chrome 环境中一次完成官方流程。</small>
    </div>` : '';
    const secondaryIdentity = account.emailHint && account.emailHint !== account.label
      ? `<p>${escapeHtml(account.emailHint)}</p>`
      : '';
    const planType = account.quota?.planType;
    const planBadge = planType
      ? `<span class="plan-badge plan-${escapeHtml(String(planType).toLowerCase())}">${escapeHtml(formatPlan(planType))}</span>`
      : '';
    const creditText = formatCredits(account.quota?.credits);
    const creditBadge = creditText
      ? `<span class="credit-badge" title="Codex 返回的原始 Credits">${escapeHtml(creditText)}</span>`
      : '';
    const usdBalance = formatUsdBalance(account.quota?.credits);
    const balanceBadge = usdBalance
      ? `<span class="balance-badge" title="按 Codex 官方美国定价 US$0.04/Credit 换算">余额 ${escapeHtml(usdBalance)}</span>`
      : '';
    const browserOccupied = Boolean(account.lease && !account.codexActive && account.lease.launchType === 'browser');
    const sessionBadge = browserOccupied
      ? '<span class="session-badge"><i></i>网页使用中</span>'
      : '';
    const health = account.health || {};
    const healthBadge = health.status && health.status !== 'healthy'
      ? `<span class="health-badge health-${escapeHtml(health.status)}" title="${escapeHtml(health.detail || health.label)}">${escapeHtml(health.label || '待检查')}</span>`
      : '';
    let codexAction;
    if (account.webLoginComplete && !account.codexInitialized) {
      codexAction = '<button class="action-primary action-codex" data-action="authorize-protocol">继续 Codex 授权</button>';
    } else if (!account.codexInitialized) {
      codexAction = `<button class="action-primary action-codex" data-action="${account.loginMethod === 'protocol' ? 'authorize-protocol' : 'authorize'}" ${codexLoginPending ? 'disabled' : ''}>${codexLoginPending ? '等待登录授权' : account.quotaErrorCode === 'auth_expired' ? '重新登录授权' : '登录并授权'}</button>`;
    } else if (account.codexActive) {
      codexAction = '<button class="action-primary action-exit" data-action="quit-codex">退出 Codex</button>';
    } else if (externalCodexRunning) {
      codexAction = '<button class="action-primary action-blocked" type="button" disabled title="请先通过顶部入口关闭外部 Codex">关闭后启动</button>';
    } else if (activeAccount) {
      codexAction = '<button class="action-primary action-blocked" type="button" disabled title="请先退出当前 Codex">暂不可切换</button>';
    } else {
      codexAction = '<button class="action-primary action-codex" data-action="codex">登录 Codex</button>';
    }
    const wakeTitle = account.wake?.running
      ? '正在唤醒账号'
      : account.wake?.lastWakeStatus === 'failed'
        ? `上次唤醒失败：${escapeHtml(account.wake.lastWakeError || '未知错误')}`
        : '唤醒账号（发送一次真实 Codex 请求）';
    return `<article class="account-card ${status}${account.codexActive ? ' current' : ''}" data-id="${account.id}">
      <div class="account-overview">
        <div class="account-identity">
          <div class="identity-title"><h3>${escapeHtml(account.label)}</h3></div>
          ${(planBadge || creditBadge || balanceBadge || sessionBadge || healthBadge) ? `<div class="identity-badges">${planBadge}${creditBadge}${balanceBadge}${sessionBadge}${healthBadge}</div>` : ''}
          ${secondaryIdentity}
        </div>
      </div>
      ${renderQuota(account)}
      <div class="account-actions">
        <button class="action-primary ${browserOccupied ? 'action-browser-active' : ''}" data-action="browser">${browserOccupied ? '网页已打开' : account.codexInitialized ? '网页端' : '打开网页登录'}</button>
        ${codexAction}
        <button class="icon-action wake-action" data-action="wake" title="${wakeTitle}" aria-label="唤醒账号" ${account.codexInitialized && !account.wake?.running ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.8 5.8 13h5l-1 8.2L18.2 10h-5z"></path></svg></button>
        <button class="icon-action" data-action="quota" title="刷新额度" aria-label="刷新额度" ${account.codexInitialized ? '' : 'disabled'}>↻</button>
        ${account.lease && !account.codexActive ? '<button class="icon-action release-action" data-action="release" title="释放账号占用（不会关闭网页）" aria-label="释放账号占用"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="10" width="12" height="10" rx="2"></rect><path d="M9 10V7a3 3 0 0 1 5.6-1.5"></path></svg></button>' : '<button class="icon-action danger-button" data-action="remove" title="移除账号" aria-label="移除账号">×</button>'}
      </div>
      ${renderAccountUsage(account)}
      ${codexLoginPanel}
    </article>`;
  }).join('');
}

async function refresh() {
  try {
    const data = await api('/api/bootstrap');
    Object.assign(state, data);
    if (state.usageRange !== 'today') state.usage = await api(`/api/usage?range=${encodeURIComponent(state.usageRange)}`);
    render();
    refreshStaleQuotas();
  } catch (error) {
    if (showProtocolDialogConnectionError(error.message)) return;
    elements.accounts.innerHTML = `<div class="empty-state"><strong>无法读取本地状态</strong><p>${escapeHtml(error.message)}。请确认启动窗口仍在运行，然后刷新页面。</p></div>`;
    showToast(error.message, true);
  }
}

async function refreshStaleQuotas() {
  if (state.quotaRefreshing) return;
  const now = Date.now();
  const due = state.accounts.filter((account) => {
    if (!account.codexInitialized) return false;
    if (!account.quota?.credits || creditQuantity(account.quota.credits) == null) return true;
    const interval = account.codexActive ? 60_000 : 5 * 60_000;
    const lastChecked = account.quota?.refreshedAt || account.quotaCheckedAt;
    return !lastChecked || Date.parse(lastChecked) <= now - interval;
  });
  if (!due.length) return;
  state.quotaRefreshing = true;
  try {
    for (const account of due) {
      try {
        await api(`/api/accounts/${account.id}/quota`, {
          method: 'POST',
          body: JSON.stringify({ operator: operator() }),
        });
      } catch {}
    }
    const data = await api('/api/bootstrap');
    Object.assign(state, data);
    render();
  } finally {
    state.quotaRefreshing = false;
  }
}

elements.accounts.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.target.matches('.protocol-inline-input input')) return;
  event.preventDefault();
  event.target.closest('.protocol-inline-input')?.querySelector('[data-action="protocol-input"]')?.click();
});

elements.accounts.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  const card = event.target.closest('[data-id]');
  if (!button || !card) return;
  if (button.dataset.action === 'toggle-usage') {
    if (state.collapsedUsage.has(card.dataset.id)) state.collapsedUsage.delete(card.dataset.id);
    else state.collapsedUsage.add(card.dataset.id);
    localStorage.setItem(collapsedUsageStorageKey, JSON.stringify([...state.collapsedUsage]));
    render();
    return;
  }
  button.disabled = true;
  try {
    const action = button.dataset.action;
    const currentOperator = operator();
    if (action === 'remove') {
      if (!confirm('只从列表移除这个账号。浏览器和 Codex 目录会保留，确定继续吗？')) return;
      await api(`/api/accounts/${card.dataset.id}`, { method: 'DELETE', body: JSON.stringify({ operator: currentOperator }) });
      showToast('已从列表移除，登录目录仍然保留');
    } else if (action === 'release') {
      await api(`/api/accounts/${card.dataset.id}/release`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('账号已释放');
    } else if (action === 'quota') {
      await api(`/api/accounts/${card.dataset.id}/quota`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('额度已刷新');
    } else if (action === 'wake') {
      await api(`/api/accounts/${card.dataset.id}/wake`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('账号已唤醒，额度状态已同步');
    } else if (action === 'cancel-authorization') {
      await api(`/api/accounts/${card.dataset.id}/cancel-authorization`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator }),
      });
      showToast('已取消未完成的授权流程');
    } else if (action === 'protocol-input') {
      const input = card.querySelector('.protocol-inline-input input');
      const value = String(input?.value || '').trim();
      if (!value) {
        showToast('请输入当前验证步骤需要的内容', true);
        return;
      }
      await api(`/api/accounts/${card.dataset.id}/protocol-input`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator, value }),
      });
      if (input) input.value = '';
      showToast('已提交，正在继续登录授权');
    } else if (action === 'authorize' || action === 'authorize-device' || action === 'authorize-protocol') {
      if (action === 'authorize-device' && !confirm('设备代码是备用流程。请先在 ChatGPT 设置 → 账户安全与登录中开启“为 Codex 启用设备代码授权”。继续吗？')) return;
      await api(`/api/accounts/${card.dataset.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator }),
      });
      showToast(action === 'authorize-protocol'
        ? '登录与 Codex 授权已在后台启动；需要验证时会在账号卡片中提示'
        : action === 'authorize-device'
          ? '已打开设备代码授权页，完成后账号会自动入池'
          : '已打开官方登录授权页，完成后账号会自动入池');
    } else if (action === 'quit-codex') {
      if (!confirm('退出当前 Codex？正在进行的任务会被中断。')) return;
      await api(`/api/accounts/${card.dataset.id}/quit-codex`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('Codex 已退出，账号认证已安全保存');
    } else {
      const launched = await api(`/api/accounts/${card.dataset.id}/launch`, { method: 'POST', body: JSON.stringify({ operator: currentOperator, launchType: action }) });
      showToast(action === 'browser'
        ? '已打开独立环境；使用结束后关闭窗口，账号会自动释放'
        : launched.codexLogin
          ? '已打开该账号的独立授权页面'
          : '已切换账号并启动 Codex；关闭应用后账号会自动释放');
    }
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#add-account').addEventListener('click', () => {
  resetProtocolDialog();
  elements.form.reset();
  elements.accountDialogStatus.hidden = true;
  elements.accountDialogStatus.textContent = '';
  state.accountImportPackageText = '';
  elements.accountImportPackageFile.value = '';
  elements.accountImportFileName.textContent = '选择 .codexnavo 文件';
  const more = elements.form.querySelector('.login-method-more');
  if (more) more.open = false;
  syncAccountLoginMethod();
  elements.dialog.showModal();
  requestAnimationFrame(() => elements.form.elements.label.focus());
});

elements.protocolProgressInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.target.matches('.protocol-inline-input input')) return;
  event.preventDefault();
  elements.protocolProgressInput.querySelector('[data-action="protocol-modal-input"]')?.click();
});

elements.protocolProgressInput.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="protocol-modal-input"]');
  if (!button || !state.protocolDialogAccountId) return;
  const input = elements.protocolProgressInput.querySelector('.protocol-inline-input input');
  const value = String(input?.value || '').trim();
  if (!value) return showAccountDialogError('请输入当前验证步骤需要的内容');
  button.disabled = true;
  try {
    await api(`/api/accounts/${state.protocolDialogAccountId}/protocol-input`, {
      method: 'POST',
      body: JSON.stringify({ operator: operator(), value }),
    });
    if (input) input.value = '';
    state.protocolDialogPromptKind = '';
    elements.protocolProgressInput.innerHTML = '';
    elements.protocolProgressCopy.textContent = '已提交，正在继续登录授权。';
    await refresh();
  } catch (error) {
    showAccountDialogError(error.message);
  } finally {
    button.disabled = false;
  }
});

elements.protocolProgressCancel.addEventListener('click', async () => {
  if (state.protocolDialogAccountId) {
    try {
      await api(`/api/accounts/${state.protocolDialogAccountId}/cancel-authorization`, {
        method: 'POST', body: JSON.stringify({ operator: operator() }),
      });
    } catch {}
  }
  elements.dialog.close();
});

elements.protocolProgressRetry.addEventListener('click', async () => {
  if (!state.protocolDialogAccountId) return;
  elements.protocolProgressRetry.disabled = true;
  try {
    await api(`/api/accounts/${state.protocolDialogAccountId}/authorize-protocol`, {
      method: 'POST', body: JSON.stringify({ operator: operator() }),
    });
    state.protocolDialogPromptKind = '';
    await refresh();
  } catch (error) {
    showAccountDialogError(error.message);
  } finally {
    elements.protocolProgressRetry.disabled = false;
  }
});

elements.protocolProgressClose.addEventListener('click', () => elements.dialog.close());
elements.dialog.addEventListener('close', resetProtocolDialog);

elements.accountToolsButton.addEventListener('click', () => {
  renderHealthCenter();
  hideToolsStatus();
  elements.accountToolsDialog.showModal();
});

elements.healthList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-health-action]');
  if (!button) return;
  const row = button.closest('.health-row');
  const originalText = button.textContent;
  button.disabled = true;
  row?.classList.add('is-checking');
  if (button.dataset.healthAction === 'check') {
    button.classList.add('is-loading');
    button.textContent = '检查中…';
    button.setAttribute('aria-busy', 'true');
  }
  try {
    if (button.dataset.healthAction === 'authorize') {
      await api(`/api/accounts/${button.dataset.accountId}/authorize`, {
        method: 'POST', body: JSON.stringify({ operator: operator() }),
      });
      showToolsStatus('已继续官方登录授权流程，请在账号独立浏览器中完成操作。');
    } else {
      await api(`/api/accounts/${button.dataset.accountId}/health`, {
        method: 'POST', body: JSON.stringify({ operator: operator() }),
      });
      await refresh();
      const checked = state.accounts.find((account) => account.id === button.dataset.accountId);
      const health = checked?.health;
      const unhealthy = health?.status !== 'healthy';
      showToolsStatus(
        health
          ? `${checked.label}：${health.label}。${health.detail}`
          : '账号授权状态已检查，结果已更新。',
        unhealthy,
      );
    }
    if (button.dataset.healthAction === 'authorize') await refresh();
    renderHealthCenter();
  } catch (error) {
    showToolsStatus(error.message, true);
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    button.textContent = originalText;
    row?.classList.remove('is-checking');
  }
});

elements.checkAllHealth.addEventListener('click', async () => {
  elements.checkAllHealth.disabled = true;
  elements.checkAllHealth.textContent = '检查中…';
  try {
    await api('/api/accounts/health-all', {
      method: 'POST', body: JSON.stringify({ operator: operator() }),
    });
    await refresh();
    renderHealthCenter();
    const unhealthy = state.accounts.filter((account) => account.health?.status !== 'healthy').length;
    showToolsStatus(unhealthy ? `检查完成：${unhealthy} 个账号需要处理。` : '检查完成：全部账号授权正常。', Boolean(unhealthy));
  } catch (error) {
    showToolsStatus(error.message, true);
  } finally {
    elements.checkAllHealth.disabled = false;
    elements.checkAllHealth.textContent = '检查全部';
  }
});

elements.exportAuthPackage.addEventListener('click', async () => {
  elements.exportAuthPackage.disabled = true;
  try {
    const result = await api(`/api/accounts/${elements.exportAccount.value}/export-auth`, {
      method: 'POST', body: JSON.stringify({ operator: operator() }),
    });
    downloadJsonFile(result.fileName, result.package);
    showToolsStatus(result.webSessionIncluded
      ? '双端授权包已生成：包含 Codex 授权和网页会话。'
      : '授权包已生成，但该账号没有可导出的有效网页会话，因此仅包含 Codex 授权。');
  } catch (error) {
    showToolsStatus(error.message, true);
  } finally {
    elements.exportAuthPackage.disabled = !elements.exportAccount.value;
  }
});

elements.importPackageFile.addEventListener('change', async () => {
  const file = elements.importPackageFile.files?.[0];
  state.importPackageText = '';
  try {
    state.importPackageText = await readAuthorizationPackageFile(file, {
      onName: (name) => { elements.importFileName.textContent = name; },
      onClear: () => { elements.importPackageFile.value = ''; },
    });
  } catch (error) {
    showToolsStatus(error.message, true);
  }
});

elements.accountImportPackageFile.addEventListener('change', async () => {
  const file = elements.accountImportPackageFile.files?.[0];
  state.accountImportPackageText = '';
  try {
    state.accountImportPackageText = await readAuthorizationPackageFile(file, {
      onName: (name) => { elements.accountImportFileName.textContent = name; },
      onClear: () => { elements.accountImportPackageFile.value = ''; },
    });
    elements.accountDialogStatus.hidden = true;
  } catch (error) {
    showAccountDialogError(error.message);
  }
});

elements.importAuthPackage.addEventListener('click', async () => {
  if (!state.importPackageText) return showToolsStatus('请先选择 .codexnavo 授权包', true);
  elements.importAuthPackage.disabled = true;
  try {
    const result = await api('/api/auth-packages/import', {
      method: 'POST',
      body: JSON.stringify({ operator: operator(), package: state.importPackageText }),
    });
    state.importPackageText = '';
    elements.importPackageFile.value = '';
    elements.importFileName.textContent = '选择 .codexnavo 文件';
    await refresh();
    renderHealthCenter();
    const status = result.importStatus || {};
    showToolsStatus(status.web === 'imported'
      ? '导入完成：Codex 授权与网页会话均已验证。'
      : status.web === 'failed'
        ? `Codex 授权已导入；网页会话验证失败，需要重新登录网页端：${status.webError || '会话已失效'}`
        : 'Codex 授权已导入；该授权包不包含网页会话。', status.web === 'failed');
  } catch (error) {
    showToolsStatus(error.message, true);
  } finally {
    elements.importAuthPackage.disabled = false;
  }
});

elements.closeExternalCodex.addEventListener('click', async () => {
  if (!confirm('关闭外部 Codex？正在进行的任务会被中断。')) return;
  elements.closeExternalCodex.disabled = true;
  try {
    await api('/api/codex/quit-external', {
      method: 'POST',
      body: JSON.stringify({ operator: operator() }),
    });
    showToast('外部 Codex 已关闭');
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.closeExternalCodex.disabled = false;
  }
});
elements.refreshAllQuotas.addEventListener('click', async () => {
  const accounts = state.accounts.filter((account) => account.codexInitialized);
  if (!accounts.length) {
    showToast('暂无已完成授权的账号可刷新', true);
    return;
  }
  elements.refreshAllQuotas.disabled = true;
  elements.refreshAllQuotas.classList.add('loading');
  try {
    const results = await Promise.allSettled(accounts.map((account) => api(`/api/accounts/${account.id}/quota`, {
      method: 'POST',
      body: JSON.stringify({ operator: operator() }),
    })));
    const failed = results.filter((result) => result.status === 'rejected').length;
    await refresh();
    showToast(failed
      ? `已刷新 ${accounts.length - failed} 个账号，${failed} 个刷新失败`
      : `已刷新全部 ${accounts.length} 个账号额度`, Boolean(failed));
  } finally {
    elements.refreshAllQuotas.disabled = false;
    elements.refreshAllQuotas.classList.remove('loading');
  }
});
elements.wakeAll.addEventListener('click', async () => {
  const accounts = state.accounts.filter((account) => account.codexInitialized);
  if (!accounts.length) {
    showToast('暂无已完成授权的账号可唤醒', true);
    return;
  }
  if (!confirm(`将为 ${accounts.length} 个账号各发送一次真实 Codex 请求，会消耗额度。继续吗？`)) return;
  elements.wakeAll.disabled = true;
  elements.wakeAll.classList.add('loading');
  try {
    const result = await api('/api/wake-all', {
      method: 'POST',
      body: JSON.stringify({ operator: operator() }),
    });
    await refresh();
    const failed = result.total - result.succeeded;
    showToast(failed
      ? `已唤醒 ${result.succeeded} 个账号，${failed} 个失败`
      : `已成功唤醒全部 ${result.succeeded} 个账号`, Boolean(failed));
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.wakeAll.disabled = false;
    elements.wakeAll.classList.remove('loading');
  }
});

function syncWakeForm() {
  const config = state.wakeSettings || {};
  elements.wakeForm.elements.enabled.checked = config.enabled === true;
  elements.wakeForm.elements.mode.value = config.mode || 'manual';
  elements.wakeForm.elements.dailyTime.value = config.dailyTime || '09:00';
  syncWakeModelOptions(config.model || '', config.reasoningEffort || '');
  elements.wakeForm.elements.prompt.value = config.prompt || 'hi';
  elements.wakeForm.querySelector('[data-daily-time]').hidden = elements.wakeForm.elements.mode.value !== 'daily';
}

const reasoningLabels = {
  none: '无推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大', ultra: '极限（自动协作）',
};

function syncWakeReasoningOptions(preferred = '') {
  const modelSelect = elements.wakeForm.elements.model;
  const effortSelect = elements.wakeForm.elements.reasoningEffort;
  const selected = state.wakeModelOptions.find((model) => model.slug === modelSelect.value) || state.wakeModelOptions[0];
  effortSelect.replaceChildren();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = selected?.defaultReasoningEffort
    ? `模型默认（${reasoningLabels[selected.defaultReasoningEffort] || selected.defaultReasoningEffort}）`
    : '模型默认';
  effortSelect.append(defaultOption);
  for (const effort of selected?.reasoningEfforts || []) {
    const option = document.createElement('option');
    option.value = effort;
    option.textContent = reasoningLabels[effort] || effort;
    effortSelect.append(option);
  }
  effortSelect.value = [...effortSelect.options].some((option) => option.value === preferred) ? preferred : '';
  elements.wakeModelHelp.textContent = selected
    ? `${selected.description || selected.displayName}；默认推理强度：${reasoningLabels[selected.defaultReasoningEffort] || selected.defaultReasoningEffort || '由 Codex 决定'}`
    : '模型列表暂不可用';
}

function syncWakeModelOptions(preferredModel = '', preferredEffort = '') {
  const select = elements.wakeForm.elements.model;
  select.replaceChildren();
  const currentDefault = state.wakeModelOptions[0];
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = currentDefault
    ? `Codex 默认（当前 ${currentDefault.displayName}）`
    : 'Codex 默认模型';
  select.append(defaultOption);
  for (const model of state.wakeModelOptions) {
    const option = document.createElement('option');
    option.value = model.slug;
    option.textContent = model.displayName;
    select.append(option);
  }
  select.value = [...select.options].some((option) => option.value === preferredModel) ? preferredModel : '';
  syncWakeReasoningOptions(preferredEffort);
}

elements.wakeSettingsButton.addEventListener('click', () => {
  syncWakeForm();
  elements.wakeDialog.showModal();
});
elements.wakeForm.elements.mode.addEventListener('change', syncWakeFormVisibility);
elements.wakeForm.elements.model.addEventListener('change', () => syncWakeReasoningOptions(''));
function syncWakeFormVisibility() {
  elements.wakeForm.querySelector('[data-daily-time]').hidden = elements.wakeForm.elements.mode.value !== 'daily';
}
elements.wakeForm.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const formData = new FormData(elements.wakeForm);
  try {
    state.wakeSettings = await api('/api/wake-settings', {
      method: 'POST',
      body: JSON.stringify({
        enabled: formData.get('enabled') === 'on',
        mode: formData.get('mode'),
        dailyTime: formData.get('dailyTime'),
        model: formData.get('model'),
        reasoningEffort: formData.get('reasoningEffort'),
        prompt: formData.get('prompt'),
      }),
    });
    elements.wakeDialog.close();
    showToast(state.wakeSettings.enabled ? '自动唤醒设置已启用' : '唤醒设置已保存');
  } catch (error) {
    showToast(error.message, true);
  }
});
elements.sortTrigger.addEventListener('click', () => {
  setSortMenuOpen(elements.sortPopover.hidden);
});
elements.viewSwitcher.addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button || button.dataset.view === state.viewMode) return;
  state.viewMode = button.dataset.view;
  localStorage.setItem(viewStorageKey, state.viewMode);
  applyViewMode();
});

elements.usageRange.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-range]');
  if (!button || button.dataset.range === state.usageRange) return;
  const previous = state.usageRange;
  state.usageRange = button.dataset.range;
  localStorage.setItem(usageRangeStorageKey, state.usageRange);
  renderUsage();
  elements.usageRange.querySelectorAll('button').forEach((item) => { item.disabled = true; });
  try {
    state.usage = await api(`/api/usage?range=${encodeURIComponent(state.usageRange)}`);
    render();
  } catch (error) {
    state.usageRange = previous;
    localStorage.setItem(usageRangeStorageKey, previous);
    renderUsage();
    showToast(error.message, true);
  } finally {
    elements.usageRange.querySelectorAll('button').forEach((item) => { item.disabled = false; });
  }
});
elements.sortPopover.addEventListener('click', (event) => {
  const option = event.target.closest('[data-sort]');
  if (!option) return;
  state.sortMode = option.dataset.sort;
  localStorage.setItem(sortStorageKey, state.sortMode);
  syncSortMenu();
  setSortMenuOpen(false);
  render();
});
document.addEventListener('click', (event) => {
  if (!elements.sortMenu.contains(event.target)) setSortMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.sortPopover.hidden) {
    setSortMenuOpen(false);
    elements.sortTrigger.focus();
  }
});

elements.updateChip.addEventListener('click', async () => {
  if (!window.codexUpdater) return;
  if (['available', 'downloading', 'downloaded', 'error', 'development'].includes(applicationUpdate.status)) {
    elements.updateDialog.showModal();
    return;
  }
  applicationUpdate = await window.codexUpdater.check();
  renderApplicationUpdate();
  elements.updateDialog.showModal();
});

elements.updatePrimaryAction.addEventListener('click', async () => {
  if (!window.codexUpdater) return;
  const action = elements.updatePrimaryAction.dataset.action;
  if (action === 'download') applicationUpdate = await window.codexUpdater.download();
  else if (action === 'install') {
    await window.codexUpdater.install();
    return;
  } else applicationUpdate = await window.codexUpdater.check();
  renderApplicationUpdate();
});

elements.form.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const formData = new FormData(elements.form);
  const requestedLoginMethod = String(formData.get('loginMethod') || 'official');
  if (requestedLoginMethod === 'import') {
    if (!state.accountImportPackageText) return showAccountDialogError('请先选择 .codexnavo 授权包');
    elements.accountSubmit.disabled = true;
    elements.accountSubmit.textContent = '正在导入…';
    try {
      const result = await api('/api/auth-packages/import', {
        method: 'POST',
        body: JSON.stringify({ operator: operator(), package: state.accountImportPackageText }),
      });
      const status = result.importStatus || {};
      state.accountImportPackageText = '';
      elements.form.reset();
      elements.dialog.close();
      await refresh();
      showToast(status.web === 'imported'
        ? '账号已导入：Codex 授权与网页会话均已验证'
        : status.web === 'failed'
          ? 'Codex 授权已导入，网页会话需要重新登录'
          : '账号已导入：授权包仅包含 Codex 授权', status.web === 'failed');
    } catch (error) {
      showAccountDialogError(error.message);
    } finally {
      elements.accountSubmit.disabled = false;
      syncAccountLoginMethod();
    }
    return;
  }
  const loginMethod = requestedLoginMethod === 'protocol' ? 'protocol' : 'official';
  const emailHint = String(formData.get('emailHint') || '').trim();
  elements.accountDialogStatus.hidden = true;
  elements.accountDialogStatus.textContent = '';
  if (loginMethod === 'protocol' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailHint)) {
    showAccountDialogError('协议登录需要填写完整邮箱地址');
    return;
  }
  try {
    const currentOperator = operator();
    const created = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        operator: currentOperator,
        label: formData.get('label'),
        emailHint,
        loginMethod,
      }),
    });
    if (loginMethod === 'protocol') {
      Object.assign(state, await api('/api/bootstrap'));
      openProtocolDialog(created);
      showToast('协议登录已启动，后续验证步骤将在当前弹窗中完成');
    } else {
      elements.form.reset();
      elements.dialog.close();
      showToast('账号已创建，请在独立浏览器中完成登录与授权');
      await refresh();
    }
  } catch (error) {
    showAccountDialogError(error.message);
  }
});

elements.form.addEventListener('change', (event) => {
  if (event.target.name !== 'loginMethod') return;
  syncAccountLoginMethod();
});

syncSortMenu();
initializeApplicationUpdater();
refresh();
state.timer = setInterval(() => {
  const protocolDialogActive = Boolean(elements.dialog.open && state.protocolDialogAccountId);
  if ((protocolDialogActive || (!elements.dialog.open && !elements.wakeDialog.open && !elements.updateDialog.open && !elements.accountToolsDialog.open)) && !document.activeElement?.closest('.protocol-inline-input') && document.visibilityState === 'visible') refresh();
}, 5_000);

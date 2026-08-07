const state = { accounts: [], csrfToken: '', timer: null, quotaRefreshing: false };
const elements = {
  accounts: document.querySelector('#accounts'),
  summary: document.querySelector('#account-summary'),
  dialog: document.querySelector('#account-dialog'),
  form: document.querySelector('#account-form'),
  toast: document.querySelector('#toast'),
  currentCodex: document.querySelector('#current-codex'),
  closeExternalCodex: document.querySelector('#close-external-codex'),
  sortMenu: document.querySelector('#sort-menu'),
  sortTrigger: document.querySelector('#sort-trigger'),
  sortLabel: document.querySelector('#sort-label'),
  sortPopover: document.querySelector('#sort-popover'),
  refreshAllQuotas: document.querySelector('#refresh-all-quotas'),
  updateChip: document.querySelector('#update-chip'),
  updateDialog: document.querySelector('#update-dialog'),
  updateDialogTitle: document.querySelector('#update-dialog-title'),
  updateDialogCopy: document.querySelector('#update-dialog-copy'),
  updateProgress: document.querySelector('#update-progress'),
  updateProgressBar: document.querySelector('#update-progress-bar'),
  updateProgressLabel: document.querySelector('#update-progress-label'),
  updateNotes: document.querySelector('#update-notes'),
  updatePrimaryAction: document.querySelector('#update-primary-action'),
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
      if (nextState.status === 'available' || nextState.status === 'downloaded') {
        elements.updateDialog.showModal();
      }
    });
  } catch {
    elements.updateChip.hidden = true;
  }
}

const sortStorageKey = 'codex-manager-account-sort';
const sortLabels = {
  current: '当前账号优先',
  'quota-desc': '额度：高到低',
  'quota-asc': '额度：低到高',
  name: '账号名称',
  created: '最近添加',
};
state.sortMode = localStorage.getItem(sortStorageKey) || 'current';

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

function formatCreditPoints(credits) {
  if (!credits) return '';
  if (credits.unlimited) return '点数 ∞';
  if (credits.points == null || credits.points === '') return '';
  const numeric = Number(credits.points);
  const points = Number.isFinite(numeric)
    ? numeric.toLocaleString('en-US', { minimumFractionDigits: numeric % 1 ? 2 : 0, maximumFractionDigits: 2 })
    : String(credits.points);
  return `点数 ${points}`;
}

function weeklyRemaining(account) {
  const weekly = account.quota?.windows?.find((window) => Number(window.windowDurationMins) >= 6 * 24 * 60)
    || account.quota?.windows?.[0];
  const remaining = Number(weekly?.remainingPercent);
  return Number.isFinite(remaining) ? remaining : null;
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
    return account.setupStage === 'web-login'
      ? `<div class="quota-panel quota-unavailable"><div class="quota-empty-title">等待网页登录</div><p>先在独立浏览器登录 ChatGPT，再继续 Codex 授权</p></div>`
      : `<div class="quota-panel quota-unavailable"><div class="quota-empty-title">等待 Codex 授权</div><p>设备授权完成后会自动入池并读取额度</p></div>`;
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
  const occupied = state.accounts.filter((account) => account.lease).length;
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
    const status = account.enabled === false ? 'disabled' : account.lease ? 'occupied' : 'free';
    const codexLoginPending = account.codexLogin && ['starting', 'waiting'].includes(account.codexLogin.status);
    const setupSteps = !account.codexInitialized ? `<div class="setup-steps" aria-label="账号入池进度">
      <span class="${account.setupStage === 'web-login' ? 'active' : 'done'}"><i>1</i>网页登录</span>
      <b aria-hidden="true">→</b>
      <span class="${account.setupStage === 'device-auth' ? 'active' : ''}"><i>2</i>Codex 授权</span>
    </div>` : '';
    const codexLoginPanel = account.codexLogin ? `<div class="codex-login-panel ${account.codexLogin.status === 'error' ? 'error' : ''}">
      ${setupSteps}
      ${account.codexLogin.status === 'error'
        ? `<strong>Codex 授权未完成</strong><span>${escapeHtml(account.codexLogin.error)}</span>`
        : `<strong>请在同一个独立浏览器中完成 Codex 授权</strong><span>设备验证码</span><code>${escapeHtml(account.codexLogin.userCode || '正在获取…')}</code><small>授权完成后会自动入池。</small>`}
    </div>` : !account.codexInitialized ? `<div class="codex-login-panel setup-ready">
      ${setupSteps}
      <strong>${account.setupStage === 'web-login' ? '先完成 ChatGPT 网页登录' : 'Codex 授权尚未完成'}</strong>
      <small>${account.setupStage === 'web-login' ? '确认网页右上角显示目标账号后，再点击“已登录，继续授权”。' : '点击“重试 Codex 授权”重新打开设备授权页。'}</small>
    </div>` : '';
    const secondaryIdentity = account.emailHint && account.emailHint !== account.label
      ? `<p>${escapeHtml(account.emailHint)}</p>`
      : '';
    const planType = account.quota?.planType;
    const planBadge = planType
      ? `<span class="plan-badge plan-${escapeHtml(String(planType).toLowerCase())}">${escapeHtml(formatPlan(planType))}</span>`
      : '';
    const creditPoints = formatCreditPoints(account.quota?.credits);
    const creditBadge = creditPoints
      ? `<span class="credit-badge" title="Codex Credits 可用点数">${escapeHtml(creditPoints)}</span>`
      : '';
    return `<article class="account-card ${status}${account.codexActive ? ' current' : ''}" data-id="${account.id}">
      <div class="account-overview">
        <div class="account-identity">
          <div class="identity-title"><h3>${escapeHtml(account.label)}</h3></div>
          ${(planBadge || creditBadge) ? `<div class="identity-badges">${planBadge}${creditBadge}</div>` : ''}
          ${secondaryIdentity}
        </div>
      </div>
      ${renderQuota(account)}
      <div class="account-actions">
        <button class="action-primary" data-action="browser">${account.codexInitialized ? '网页端' : '打开网页登录'}</button>
        ${account.codexInitialized
          ? account.codexActive
            ? `<button class="action-primary action-exit" data-action="quit-codex">退出 Codex</button>`
            : `<button class="action-primary action-codex" data-action="codex">${activeAccount ? '切换账号' : '登录 Codex'}</button>`
          : `<button class="action-primary action-codex" data-action="authorize" ${codexLoginPending ? 'disabled' : ''}>${codexLoginPending ? '等待 Codex 授权' : account.setupStage === 'web-login' ? '已登录，继续授权' : account.quotaErrorCode === 'auth_expired' ? '重新授权' : '重试 Codex 授权'}</button>`}
        <button class="icon-action" data-action="quota" title="刷新额度" aria-label="刷新额度" ${account.codexInitialized ? '' : 'disabled'}>↻</button>
        ${account.lease && !account.codexActive ? '<button class="release" data-action="release">释放占用</button>' : ''}
        <button class="icon-action danger-button" data-action="remove" title="移除账号" aria-label="移除账号" ${account.lease ? 'disabled' : ''}>×</button>
      </div>
      ${codexLoginPanel}
    </article>`;
  }).join('');
}

async function refresh() {
  try {
    const data = await api('/api/bootstrap');
    Object.assign(state, data);
    render();
    refreshStaleQuotas();
  } catch (error) {
    elements.accounts.innerHTML = `<div class="empty-state"><strong>无法读取本地状态</strong><p>${escapeHtml(error.message)}。请确认启动窗口仍在运行，然后刷新页面。</p></div>`;
    showToast(error.message, true);
  }
}

async function refreshStaleQuotas() {
  if (state.quotaRefreshing) return;
  const now = Date.now();
  const due = state.accounts.filter((account) => {
    if (!account.codexInitialized) return false;
    if (!account.quota?.credits || !Object.prototype.hasOwnProperty.call(account.quota.credits, 'points')) return true;
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

elements.accounts.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  const card = event.target.closest('[data-id]');
  if (!button || !card) return;
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
    } else if (action === 'authorize') {
      await api(`/api/accounts/${card.dataset.id}/authorize`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('已在同一个独立浏览器中打开 Codex 授权页，完成后会自动入池');
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

document.querySelector('#add-account').addEventListener('click', () => elements.dialog.showModal());
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
elements.sortTrigger.addEventListener('click', () => {
  setSortMenuOpen(elements.sortPopover.hidden);
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
  try {
    const currentOperator = operator();
    await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        operator: currentOperator,
        label: formData.get('label'),
        emailHint: formData.get('emailHint'),
        browserType: formData.get('browserType'),
      }),
    });
    elements.form.reset();
    elements.dialog.close();
    showToast('账号已创建，请先在专属浏览器完成 ChatGPT 网页登录');
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  }
});

syncSortMenu();
initializeApplicationUpdater();
refresh();
state.timer = setInterval(refresh, 5_000);

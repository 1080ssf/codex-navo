/* Account diagnostics and explicit, idempotent reset-credit operations. */
(() => {
  'use strict';
  const tr = (zh, en) => navoUsesChinese() ? zh : en;
  const esc = value => escapeHtml(String(value ?? ''));
  const post = (url, body = {}) => api(url, { method: 'POST', body: JSON.stringify(body) });
  const icons = {
    browser: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
    codex: '<path d="m9 6-6 6 6 6m6-12 6 6-6 6"/>',
    models: '<path d="M9 3h6m-5 0v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 15h8"/><path d="M10 18h.01M14 17h.01"/>',
    route: '<path d="M5 5h14M5 12h14M5 19h14"/>'
  };
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.codex}</svg>`;
  let dialog, mode, timer, targetId, creditsState, busy = false, catalog = [], job = null, pollEpoch = 0;
  const attempts = new Map();
  try { for (const [id, attempt] of JSON.parse(sessionStorage.getItem('navo-reset-attempts') || '[]')) if (attempt?.id) attempts.set(id, attempt); } catch {}
  function saveAttempts() { try { sessionStorage.setItem('navo-reset-attempts', JSON.stringify([...attempts])); } catch {} }
  const storedJob = () => { try { return sessionStorage.getItem('navo-model-job'); } catch { return null; } };
  const rememberJob = id => { try { sessionStorage.setItem('navo-model-job', id); } catch {} };
  function targets() {
    return [
      { title: tr('普通账号', 'Regular accounts'), values: (state.accounts || []).filter(a => a.accountKind !== 'relay') },
      { title: tr('临时账号', 'Temporary accounts'), values: (state.accounts || []).filter(a => a.accountKind === 'relay') },
      { title: 'API Codex', values: (state.apiService?.keys || []).map(k => ({ ...k, id: `api-key:${k.id}`, label: k.name || k.label || k.id })) }
    ];
  }
  function open(title) {
    pollEpoch++;
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.className = 'navo-account-tools-dialog';
      document.body.append(dialog);
      dialog.addEventListener('close', () => { pollEpoch++; clearTimeout(timer); });
      dialog.addEventListener('click', event => {
        const button = event.target.closest('[data-tools-action]');
        if (!button) return;
        event.preventDefault();
        handle(button.dataset.toolsAction, button).catch(showError);
      });
    }
    clearTimeout(timer);
    dialog.innerHTML = `<header><h2>${esc(title)}</h2><button type="button" data-tools-action="close" aria-label="${esc(tr('关闭', 'Close'))}">×</button></header><div class="tools-error" role="alert" hidden></div><div class="tools-body"></div>`;
    if (!dialog.open) dialog.showModal();
  }
  function showError(error) {
    if (!dialog?.open) return;
    const box = dialog.querySelector('.tools-error');
    box.hidden = false; box.textContent = error?.message || String(error);
  }
  function status(value) {
    const labels = { queued: ['等待检测','Queued'], running:['检测中','Running'], completed:['完成','Completed'], available:['可用','Available'], success:['可用','Available'], failed:['失败','Failed'], cancelled:['已停止','Cancelled'], pending:['结果待确认','Pending verification'], rate_limited:['限流','Rate limited'], unavailable:['不可用','Unavailable'], model_mismatch:['实际模型不匹配','Model mismatch'] };
    Object.assign(labels, { checking:['检测中','Checking'], authentication_required:['需要重新授权','Authentication required'], access_denied:['访问被拒绝','Access denied'], region_restricted:['地区受限','Region restricted'], model_not_found:['模型不存在','Model not found'], endpoint_not_found:['接口不存在','Endpoint not found'], quota_exhausted:['额度耗尽','Quota exhausted'], service_unavailable:['服务不可用','Service unavailable'], request_rejected:['请求被拒绝','Request rejected'], timeout:['超时，未确认','Timed out; unverified'], tls_error:['TLS 错误','TLS error'], network_error:['网络错误','Network error'], incomplete:['响应未完成','Incomplete response'], cooldown:['冷却中','Cooling down'], busy:['账号正在使用','Account busy'] });
    return labels[value] ? tr(...labels[value]) : value || '—';
  }
  function modelBody(initial) {
    dialog.querySelector('.tools-body').innerHTML = `<p>${esc(tr('模型列表不代表实测可用。实际检测会产生少量用量；关闭窗口不会停止后台检测。', 'A listed model is not verified usable. Live probes consume some quota. Closing this window does not stop the job.'))}</p>
      <div class="tools-targets">${targets().map(group => `<details ${group.values.some(a => a.id === initial) ? 'open' : ''}><summary>${esc(group.title)} · ${group.values.length}</summary>${group.values.map(a => `<label><input type="checkbox" name="tools-target" value="${esc(a.id)}" ${a.id === initial ? 'checked' : ''}><span class="tools-option-text">${esc(a.label || a.emailHint || a.id)}</span></label>`).join('')}</details>`).join('')}</div>
      <label class="tools-active-option"><input type="checkbox" name="tools-allow-busy"><span>${esc(tr('包含使用中的账号（可能影响当前任务的额度与限流）', 'Include active accounts (shares task quota and rate limits)'))}</span></label>
      <div class="tools-buttons"><button data-tools-action="catalog">${esc(tr('读取模型列表', 'Read model catalog'))}</button><button data-tools-action="start">${esc(tr('检测所选模型', 'Probe selected models'))}</button><button data-tools-action="cancel">${esc(tr('停止检测', 'Stop job'))}</button><button data-tools-action="retry">${esc(tr('重测失败项', 'Retry failed items'))}</button></div><div class="tools-catalog"></div><div class="tools-results" aria-live="polite"></div>`;
    renderCatalog(); renderJob();
  }
  function renderCatalog() {
    const box = dialog.querySelector('.tools-catalog');
    if (!box) return;
    box.innerHTML = catalog.map((entry, i) => `<label><input type="checkbox" name="tools-model" value="${i}"><span class="tools-option-text">${esc(entry.targetLabel || entry.targetId)} · ${esc(entry.model)}</span><small>${esc(tr('未实测', 'Not probed'))}</small></label>`).join('');
  }
  function renderJob() {
    const box = dialog?.querySelector('.tools-results');
    if (!box || !job) return;
    box.innerHTML = `<h3>${esc(tr('检测结果', 'Probe results'))} · ${esc(status(job.status))}</h3>${(job.items || []).map(item => `<article><strong>${esc(item.model)} · ${esc(item.targetId)}</strong><span>${esc(status(item.state))}${item.httpStatus ? ` · HTTP ${esc(item.httpStatus)}` : ''}</span><small>${esc([item.errorCode, item.error || item.message, item.firstOutputMs != null ? `${tr('首段输出', 'First output')} ${item.firstOutputMs} ms` : '', item.checkedAt, item.retryAt ? `${tr('可重试时间', 'Retry at')}: ${item.retryAt}` : '', item.selectedAccountId ? `${tr('实际账号', 'Selected account')}: ${item.selectedAccountId}` : '', item.source, item.attemptedAccountIds?.length ? `${tr('尝试账号', 'Attempted accounts')}: ${item.attemptedAccountIds.join(', ')}` : ''].filter(Boolean).join(' · '))}</small></article>`).join('')}`;
  }
  async function poll(id) {
    clearTimeout(timer);
    if (!dialog?.open || mode !== 'models') return;
    const epoch = pollEpoch;
    try {
      const result = await api(`/api/model-diagnostics/jobs/${encodeURIComponent(id)}`);
      if (epoch !== pollEpoch || !dialog.open || mode !== 'models') return;
      job = result; renderJob();
    } catch (error) { if (epoch !== pollEpoch) return; showError(error); }
    if (dialog.open && mode === 'models' && (!job || ['queued', 'running'].includes(job.status))) timer = setTimeout(() => poll(id), 1000);
  }
  async function start(items) {
    if (job && ['queued', 'running'].includes(job.status)) throw new Error(tr('当前检测尚未结束，请等待完成或停止后再试。', 'A probe job is still active. Wait or stop it before starting another.'));
    if (!items.length) throw new Error(tr('请选择需要检测的模型。', 'Select models to probe.'));
    const allowBusy = dialog?.querySelector('[name="tools-allow-busy"]')?.checked === true;
    const warning = allowBusy ? tr('已包含使用中的账号；检测会与当前任务共享额度和并发限制，可能触发限流。', 'Active accounts are included; probes share quota and concurrency limits with current tasks and may trigger rate limits.') : '';
    if (!confirm(tr(`将发送 ${items.length} 个真实检测请求，会消耗少量账号额度。${warning}继续？`, `Send ${items.length} live probes, consuming account quota? ${warning}`))) return;
    job = await post('/api/model-diagnostics/start', { items: items.map(({ targetId, model }) => ({ targetId, model })), confirmed: true, allowBusy });
    pollEpoch++; rememberJob(job.id); renderJob(); poll(job.id);
  }
  function updateQuota(data) {
    const account = (state.accounts || []).find(a => a.id === targetId);
    if (account && data.quota) { account.quota = data.quota; render(); }
  }
  async function refreshCredits() {
    const id = targetId;
    const data = await post(`/api/accounts/${encodeURIComponent(id)}/reset-credits`);
    if (mode !== 'credits' || targetId !== id) return;
    creditsState = data; updateQuota(data);
    if (data.operation?.clientOperationId && data.operation.status === 'pending') { attempts.set(id, { id: data.operation.clientOperationId, creditId: data.operation.creditId }); saveAttempts(); }
    else if (data.operation?.status === 'complete' && attempts.get(id)?.id === data.operation.clientOperationId) { attempts.delete(id); saveAttempts(); }
    renderCredits();
  }
  function creditCopy(card) {
    const title = /^Full reset \(Weekly \+ 5 hr\)$/i.test(card.title || '')
      ? tr('完整重置（周额度 + 5 小时额度）', 'Full reset (Weekly + 5 hr)') : card.title || tr('重置卡', 'Reset credit');
    const states = { available: ['可用', 'Available'], used: ['已使用', 'Used'], redeemed: ['已兑换', 'Redeemed'], expired: ['已过期', 'Expired'] };
    const stateLabel = states[card.status] ? tr(...states[card.status]) : tr('状态待识别', 'Unknown status');
    const scope = card.resetType === 'codexRateLimits' ? tr('Codex 使用额度', 'Codex rate limits') : tr('以官方返回范围为准', 'Scope determined by the server');
    const description = /^Thanks for using Codex! You've been granted one free rate limit reset\.?$/i.test(card.description || '')
      ? tr('感谢使用 Codex！你已获赠一次免费的额度重置。', "Thanks for using Codex! You've been granted one free rate limit reset.")
      : card.description || '';
    const date = new Date(card.expiresAt);
    const expiry = card.expiresAt && Number.isFinite(date.getTime())
      ? date.toLocaleString(navoUsesChinese() ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : tr('官方未提供', 'Not provided');
    return { title, stateLabel, scope, description, expiry };
  }
  function creditMarkup(card, i, pending) {
    const copy = creditCopy(card);
    return `<article class="tools-credit"><strong>${esc(copy.title)}</strong><small>${esc(tr('状态：', 'Status: '))}${esc(copy.stateLabel)} · ${esc(tr('范围：', 'Scope: '))}${esc(copy.scope)}</small>${copy.description ? `<small>${esc(copy.description)}</small>` : ''}<small>${esc(tr('到期时间（本地）：', 'Expires (local): '))}${esc(copy.expiry)}</small><button data-tools-action="consume" data-credit-index="${i}" ${pending || busy ? 'disabled' : ''}>${esc(tr('使用此卡', 'Use credit'))}</button></article>`;
  }
  function renderCredits() {
    if (!dialog?.open || mode !== 'credits') return;
    const credits = creditsState?.credits;
    const pending = attempts.has(targetId) || creditsState?.operation?.status === 'pending';
    dialog.querySelector('.tools-body').innerHTML = `<p>${esc(tr('重置卡属于当前账号。使用可能无法撤销；不会自动使用第二张。', 'Credits belong to this account. Redemption may be irreversible; a second credit is never consumed automatically.'))}</p><div class="tools-buttons"><button data-tools-action="refresh-credits">${esc(tr('刷新', 'Refresh'))}</button></div>${credits ? `<h3>${esc(tr('可用重置卡', 'Available reset credits'))}: ${esc(credits.availableCount ?? '—')}</h3>` : ''}${pending ? `<p class="tools-pending">${esc(tr('上次操作结果待确认，请刷新核验；再次提交会复用同一个操作编号。', 'The previous result is pending. Refresh to verify; resubmitting reuses the same operation ID.'))}</p><button data-tools-action="consume">${esc(tr('核验或重试原操作', 'Verify or retry prior operation'))}</button>` : ''}${Array.isArray(credits?.credits) ? credits.credits.map((card, i) => creditMarkup(card, i, pending)).join('') : `<p>${esc(tr('官方未提供逐卡详情。', 'Individual credit details were not provided.'))}</p>${Number(credits?.availableCount) > 0 && !pending ? `<button data-tools-action="consume">${esc(tr('使用一张', 'Use one credit'))}</button>` : ''}`}`;
  }
  async function consume(button) {
    let attempt = attempts.get(targetId);
    if (!confirm(tr('确认对当前账号使用一张重置卡？实际重置范围由官方决定，操作可能无法撤销。', 'Use one reset credit for this account? The server determines its scope; this may be irreversible.'))) return;
    if (!attempt) {
      const card = creditsState?.credits?.credits?.[Number(button.dataset.creditIndex)];
      attempt = { id: crypto.randomUUID(), creditId: card?.id };
      attempts.set(targetId, attempt);
      saveAttempts();
    }
    renderCredits();
    const result = await post(`/api/accounts/${encodeURIComponent(targetId)}/reset-credits/consume`, { confirmed: true, clientOperationId: attempt.id, ...(attempt.creditId ? { creditId: attempt.creditId } : {}) });
    updateQuota(result);
    if (result.outcome !== 'pending') { attempts.delete(targetId); saveAttempts(); }
    await refreshCredits();
    const outcomes = { reset: tr('已使用', 'Redeemed'), alreadyRedeemed: tr('此操作已完成', 'Already redeemed'), nothingToReset: tr('当前无需重置', 'Nothing to reset'), noCredit: tr('没有可用重置卡', 'No credit available'), pending: tr('结果待确认', 'Pending verification') };
    const notice = document.createElement('p'); notice.textContent = `${outcomes[result.outcome] || result.outcome}${result.outcome === 'reset' && !result.quotaSynced ? tr('，额度同步中', '; syncing quota') : ''}`;
    dialog.querySelector('.tools-body').prepend(notice);
  }
  async function handle(action, button) {
    if (action === 'close') { dialog.close(); return; }
    if (busy) return;
    busy = true; button.disabled = true;
    try {
      if (action === 'catalog') {
        const targetIds = [...dialog.querySelectorAll('[name="tools-target"]:checked')].map(el => el.value);
        if (!targetIds.length) throw new Error(tr('请选择账号。', 'Select accounts.'));
        const rows = await post('/api/model-diagnostics/catalog', { targetIds });
        const unique = new Map(), errors = [];
        for (const row of rows) {
          if (row.error) errors.push(`${row.targetId}: ${row.error}`);
          for (const model of row.models || []) {
            if (model.error) { errors.push(`${row.targetId}: ${model.error}`); continue; }
            if (model.id) unique.set(`${row.targetId}\0${model.id}`, { targetId: row.targetId, model: model.id });
            if (model.id && model.memberTargetId) {
              const label = (state.accounts || []).find(a => a.id === model.accountId)?.label || model.accountId;
              unique.set(`${model.memberTargetId}\0${model.id}`, { targetId: model.memberTargetId, model: model.id, targetLabel: `${tr('固定成员', 'Fixed member')} · ${label}` });
            }
          }
        }
        catalog = [...unique.values()]; renderCatalog();
        if (errors.length) showError(new Error(errors.join('\n')));
      } else if (action === 'start') await start([...dialog.querySelectorAll('[name="tools-model"]:checked')].map(el => catalog[Number(el.value)]));
      else if (action === 'retry') await start((job?.items || []).filter(item => !['available', 'success', 'completed', 'running', 'checking', 'queued'].includes(item.state)).map(({ targetId, model }) => ({ targetId, model })));
      else if (action === 'cancel' && job?.id) { pollEpoch++; clearTimeout(timer); job = await post(`/api/model-diagnostics/jobs/${encodeURIComponent(job.id)}/cancel`); renderJob(); if (['queued', 'running'].includes(job.status)) poll(job.id); }
      else if (action === 'refresh-credits') await refreshCredits();
      else if (action === 'consume') await consume(button);
      else if (action === 'select-credit-account') { targetId = button.dataset.accountId; mode = 'credits'; creditsState = null; renderCredits(); await refreshCredits(); }
    } finally { busy = false; if (button.isConnected) button.disabled = false; }
  }
  function decorate() {
    document.querySelectorAll('.account-actions .action-primary').forEach(button => {
      if (button.querySelector('.account-action-icon')) return;
      const label = button.textContent.trim();
      button.setAttribute('aria-label', label); if (!button.title) button.title = label;
      const type = /browser/.test(button.dataset.action || '') || /网页|web/i.test(label) ? 'browser' : /route/.test(button.dataset.action || '') ? 'route' : 'codex';
      button.innerHTML = `<span class="account-action-icon" aria-hidden="true">${icon(type)}</span><span class="account-action-label">${esc(label)}</span>`;
    });
    document.querySelectorAll('.account-card[data-id]').forEach(card => {
      const account = (state.accounts || []).find(a => a.id === card.dataset.id);
      const expiry = card.querySelector('.expiry-badge');
      if (account && expiry) {
        const labels = { credential_unavailable: tr('当前凭证无法读取', 'Credential cannot read expiry'), not_returned: tr('官方未提供日期', 'Date not provided'), error: tr('到期读取失败', 'Expiry read failed'), not_checked: tr('到期待检测', 'Expiry not checked') };
        if (account.planExpiryStatus === 'renewal' && account.planRenewsAt) expiry.textContent = `${tr('下次续费', 'Next renewal')} ${new Date(account.planRenewsAt).toLocaleDateString(navoUsesChinese() ? 'zh-CN' : 'en-US')}`;
        else if (!account.planExpiresAt && labels[account.planExpiryStatus]) expiry.textContent = labels[account.planExpiryStatus];
        if (account.planExpiryError) expiry.title = `${tr('最近刷新失败', 'Last refresh failed')}: ${account.planExpiryError}`;
      }
      const actions = card.querySelector('.account-actions');
      if (card.dataset.id.startsWith('api-key:') && actions && !actions.querySelector('[data-tool="reset-pool"]')) {
        const button = document.createElement('button'); button.className = 'icon-action'; button.dataset.tool = 'reset-pool'; button.title = button.ariaLabel = tr('查看成员重置卡', 'Member reset credits'); button.textContent = '↺'; actions.append(button);
      }
      if (!actions || actions.querySelector('[data-tool="models"]')) return;
      const button = document.createElement('button'); button.className = 'icon-action'; button.dataset.tool = 'models';
      button.title = button.ariaLabel = tr('模型检测', 'Model diagnostics'); button.innerHTML = icon('models'); actions.append(button);
    });
    if (!document.querySelector('#navo-model-tools')) {
      const anchor = document.querySelector('#refresh-all-quotas');
      if (anchor) { const button = document.createElement('button'); button.id = 'navo-model-tools'; button.className = 'refresh-all-button'; button.dataset.tool = 'models'; button.title = button.ariaLabel = tr('模型检测', 'Model diagnostics'); button.innerHTML = icon('models'); anchor.before(button); }
    }
    const toolbar = document.querySelector('#navo-model-tools');
    if (toolbar) toolbar.dataset.tooltip = toolbar.title = toolbar.ariaLabel = tr('模型检测', 'Model diagnostics');
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('[data-tool]');
    if (!button || !['models', 'reset-credits', 'reset-pool'].includes(button.dataset.tool)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (busy) return;
    targetId = button.closest('.account-card')?.dataset.id;
    if (button.dataset.tool === 'models') {
      mode = 'models'; open(tr('模型检测', 'Model diagnostics')); modelBody(targetId);
      const id = job?.id || storedJob(); if (id) poll(id);
    } else if (button.dataset.tool === 'reset-pool') {
      mode = 'pool'; open(tr('选择重置卡所属账号', 'Choose credit owner'));
      const key = (state.apiService?.keys || []).find(k => `api-key:${k.id}` === targetId);
      const ids = key?.accountIds || [];
      dialog.querySelector('.tools-body').innerHTML = `<p>${esc(tr('重置卡属于成员账号，不属于 API Key。', 'Credits belong to member accounts, not the API Key.'))}</p>${ids.map(id => `<button data-tools-action="select-credit-account" data-account-id="${esc(id)}">${esc((state.accounts || []).find(a => a.id === id)?.label || id)}</button>`).join('') || esc(tr('没有绑定账号', 'No bound accounts'))}`;
    } else {
      mode = 'credits'; creditsState = null; open(tr('重置卡详情', 'Reset credits')); renderCredits(); refreshCredits().catch(showError);
    }
  }, true);
  window.NavoAccountTools = { decorate };
  decorate();
})();

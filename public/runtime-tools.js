/* Runtime readiness is a separate dependency from the installed desktop version. */
(() => {
  'use strict';
  const panel = document.querySelector('#cli-runtime-panel');
  if (!panel) return;
  const tr = (zh, en) => navoUsesChinese() ? zh : en;
  const esc = value => escapeHtml(String(value ?? ''));
  const labels = {
    ready:['可用','Ready'], not_checked:['尚未检测','Not checked'], unavailable:['尚未就绪','Not ready'],
    missing:['文件不存在','File missing'], timeout:['检测超时','Probe timed out'], stat_timeout:['文件状态读取超时','File status read timed out'], prerelease:['预发行版本','Prerelease'],
    invalid_version:['版本输出无法识别','Unrecognized version'], nonzero_exit:['进程异常退出','Process exited with an error'],
    budget_exhausted:['达到本轮总时限','Check time limit reached'], output_limit:['版本输出过长','Version output too large'],
    spawn_failed:['进程无法启动','Process could not start'], configured:['自定义','Custom'],path:['PATH 路径','PATH'],
    managed:['本机托管目录','Managed installation'],standalone:['独立 CLI','Standalone CLI'],desktop:['桌面端内置','Desktop bundled'],npm:['npm 安装','npm installation'],
    discovery:['其他查找来源','Other discovery sources'],
  };
  const label = key => labels[key] ? tr(...labels[key]) : key || '—';
  let current = { status:'not_checked',candidates:[] }, draftDiagnostics = null, busy = false, message = '', failed = false, draftTouched = false, revision = 0;
  function render() {
    const draft = (draftTouched ? panel.querySelector('input')?.value : current.configuredPath) ?? '';
    const diagnostics = draftDiagnostics || current;
    const discoveryIssues = diagnostics.discoveryIssues || [];
    const emptyDiagnostics = diagnostics.discoveryStatus
      ? tr('CLI 文件查找未完成：', 'CLI discovery did not complete: ') + label(diagnostics.discoveryStatus)
      : diagnostics.checkedAt
        ? tr('本次未找到 CLI 候选文件。可以选择现有 codex.exe，验证后保存。', 'No CLI candidates were found. Choose an existing codex.exe, then verify and save it.')
        : tr('尚无候选记录，请点击重新检测。', 'No candidate records. Select Check again.');
    panel.innerHTML = `<div class="cli-runtime-head"><div><h2>${esc(tr('Codex CLI 运行依赖','Codex CLI runtime'))}</h2><p>${esc(tr('桌面端与 CLI 是独立依赖。这里检查实际用于授权、额度读取和启动预热的 CLI。','The desktop app and CLI are separate dependencies. This checks the CLI used for authorization, quota reads and launch preparation.'))}</p></div><span class="cli-runtime-status">${esc(busy ? tr('正在检测…','Checking…') : label(current.status))}</span></div>
      <dl class="cli-runtime-summary"><div><dt>${esc(tr('当前 CLI','Selected CLI'))}</dt><dd>${esc(current.selected?.version || '—')}</dd></div><div><dt>${esc(tr('来源','Source'))}</dt><dd>${esc(label(current.selected?.source))}</dd></div><div><dt>${esc(tr('最近检测','Last checked'))}</dt><dd>${current.checkedAt ? esc(new Date(current.checkedAt).toLocaleString(navoUsesChinese()?'zh-CN':'en-US')) : '—'}</dd></div></dl>
      <div class="cli-runtime-path"><label for="cli-runtime-path">${esc(tr('自定义 CLI 路径（可选）','Custom CLI path (optional)'))}</label><input id="cli-runtime-path" value="${esc(draft)}" placeholder="${esc(tr('留空使用自动识别，或选择现有 codex.exe','Use automatic discovery, or choose an existing codex.exe'))}" ${busy?'disabled':''}></div>
      <div class="cli-runtime-actions"><button type="button" data-cli-action="check" ${busy?'disabled':''}>${esc(tr('重新检测','Check again'))}</button><button type="button" data-cli-action="browse" ${busy||!window.codexRuntime?.selectCli?'disabled':''}>${esc(tr('选择文件','Choose file'))}</button><button type="button" data-cli-action="save" ${busy?'disabled':''}>${esc(tr('验证并保存','Verify and save'))}</button></div>
      ${message ? `<p class="cli-runtime-message${failed?' error':''}" role="status">${esc(message)}</p>` : ''}
      ${discoveryIssues.length ? `<details class="cli-runtime-details"><summary>${esc(tr('部分来源未完成检查，请查看详情','Some sources were not fully checked; see details'))}</summary>${discoveryIssues.map(issue=>`<article><strong>${esc(label(issue.source))} · ${esc(label(issue.status))}</strong>${issue.path?`<code>${esc(issue.path)}</code>`:''}</article>`).join('')}</details>` : ''}
      <details class="cli-runtime-details"><summary>${esc(draftDiagnostics ? tr('未保存路径的诊断详情','Unsaved path diagnostics') : tr('查看候选与诊断详情','Candidate diagnostics'))} · ${diagnostics.candidates?.length||0}</summary>${(diagnostics.candidates||[]).map(row=>`<article><strong>${esc(label(row.source))} · ${esc(label(row.status))}</strong><code>${esc(row.path)}</code><small>${esc([row.version,row.durationMs!=null?`${row.durationMs} ms`:'',row.processErrorCode,row.exitCode!=null?`exit ${row.exitCode}`:''].filter(Boolean).join(' · '))}</small></article>`).join('') || `<p>${esc(emptyDiagnostics)}</p>`}</details>`;
  }
  panel.addEventListener('input', event => { if (event.target.id === 'cli-runtime-path') draftTouched = true; });
  panel.addEventListener('click', async event => {
    const button = event.target.closest('[data-cli-action]');
    if (!button || busy) return;
    const action = button.dataset.cliAction;
    if (action === 'browse') {
      busy = true; render();
      try {
        const file = await window.codexRuntime?.selectCli(state.appLocale);
        if (file) {
          panel.querySelector('input').value = file; draftTouched = true;
          draftDiagnostics = null; message = ''; failed = false;
        }
      } catch (error) { failed = true; message = tr('无法选择文件：','File selection failed: ') + error.message; }
      finally { busy = false; render(); }
      return;
    }
    revision++;
    const path = panel.querySelector('input').value.trim();
    busy = true; message = ''; failed = false; draftDiagnostics = null; render();
    try {
      current = await api(action === 'save' ? '/api/cli-settings' : '/api/cli-diagnostics', {method:'POST',body:JSON.stringify(action==='save'?{path}:{})});
      if (action === 'save') { draftTouched = false; message = tr('CLI 配置已验证并保存。','CLI configuration verified and saved.'); }
      else if (current.status !== 'ready') { failed = true; message = tr('CLI 尚未就绪，请展开诊断详情查看原因。','The CLI is not ready. Expand diagnostics to see why.'); }
    } catch (error) {
      if (error.diagnostics) draftDiagnostics = error.diagnostics;
      failed = true;
      message = error.diagnostics ? tr('该路径未通过验证，未更改原配置。请查看诊断详情。','This path did not pass validation. The previous setting is unchanged. See diagnostics.')
        : tr('操作失败：','Operation failed: ')+error.message;
    } finally { busy = false; render(); }
  });
  window.NavoRuntimeTools = {render};
  render();
  api('/api/cli-state').then(data=>{if (revision === 0) { current=data;render(); }}).catch(()=>{
    if (revision === 0) { failed = true; message = tr('无法读取 CLI 状态，请重新检测。','Could not read CLI state. Select Check again.'); render(); }
  });
})();

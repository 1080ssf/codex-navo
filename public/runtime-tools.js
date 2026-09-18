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
    navo:['Navo 独立安装','Navo-managed installation'],
    protocol_failed:['启动握手失败','Startup handshake failed'], protocol_timeout:['启动握手超时','Startup handshake timed out'],
  };
  const label = key => labels[key] ? tr(...labels[key]) : key || '—';
  let current = { status:'not_checked',candidates:[] }, draftDiagnostics = null, busy = false, message = '', failed = false, draftTouched = false, revision = 0;
  let installation = { status: 'idle', busy: false }, pollTimer = null;
  const installLabels = {
    checking:['正在获取官方稳定版…','Checking the official stable release…'], downloading:['正在下载…','Downloading…'],
    verifying:['正在校验文件…','Verifying the download…'], extracting:['正在解压…','Extracting…'],
    validating:['正在验证版本和启动握手…','Validating the version and startup handshake…'], activating:['正在启用…','Activating…'],
    complete:['稳定版 CLI 已安装并启用','Stable CLI installed and selected'], cancelled:['下载已取消，原配置未更改','Download cancelled; previous configuration unchanged'],
    error:['安装失败，原配置未更改','Installation failed; previous configuration unchanged'],
  };
  const installErrors = {
    unsupported_platform:['目前支持 Windows x64 和 ARM64。','Windows x64 and ARM64 are supported.'],
    release_invalid:['官方稳定版信息或校验值不完整，请稍后重试。','Official stable release metadata or checksum is missing. Try again later.'],
    http_error:['官方下载服务返回错误','Official download service returned an error'],
    integrity_failed:['下载文件不完整或校验不一致，请重新下载。','Download is incomplete or its checksum does not match. Download again.'],
    archive_invalid:['安装包内容无法识别，请重试。','The archive could not be read. Try again.'],
    version_failed:['下载的程序未通过稳定版本验证。','The downloaded program failed stable-version validation.'],
    protocol_failed:['程序未通过启动握手验证。','The program failed startup handshake validation.'],
    protocol_timeout:['程序启动握手超时，请重试。','Startup handshake timed out. Try again.'],
    spawn_failed:['无法启动下载的程序。','Could not start the downloaded program.'],
    download_timeout:['连接或下载超时，请检查后台代理后重试。','Connection or download timed out. Check the background proxy and retry.'],
  };
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!installation.busy) return;
    pollTimer = setTimeout(async () => {
      try {
        const next = await api('/api/cli-state');
        current = next; installation = next.installation || installation;
        if (installation.status === 'complete') { draftTouched = false; draftDiagnostics = null; message = ''; failed = false; }
        render();
      } catch { message = tr('暂时无法读取安装进度，正在重试…','Cannot read installation progress; retrying…'); render(); }
      schedulePoll();
    }, 1000);
  }
  function render() {
    const locked = busy || installation.busy;
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
      <div class="cli-runtime-path"><label for="cli-runtime-path">${esc(tr('自定义 CLI 路径（可选）','Custom CLI path (optional)'))}</label><input id="cli-runtime-path" value="${esc(draft)}" placeholder="${esc(tr('留空使用自动识别，或选择现有 codex.exe','Use automatic discovery, or choose an existing codex.exe'))}" ${locked?'disabled':''}></div>
      <div class="cli-runtime-actions"><button type="button" data-cli-action="install" ${locked?'disabled':''}>${esc(tr('安装并使用稳定版 CLI','Install and use stable CLI'))}</button><button type="button" data-cli-action="check" ${locked?'disabled':''}>${esc(tr('重新检测','Check again'))}</button><button type="button" data-cli-action="browse" ${locked||!window.codexRuntime?.selectCli?'disabled':''}>${esc(tr('选择文件','Choose file'))}</button><button type="button" data-cli-action="save" ${locked?'disabled':''}>${esc(tr('验证并保存','Verify and save'))}</button>${installation.busy && ['checking','downloading'].includes(installation.status)?`<button type="button" data-cli-action="cancel" ${busy?'disabled':''}>${esc(tr('取消下载','Cancel download'))}</button>`:''}</div>
      <div class="cli-runtime-install"><p>${esc(tr('从 OpenAI 官方发布下载稳定版，安装到 Navo 独立目录。不修改账号、会话或代理配置。','Downloads the stable release published by OpenAI into a Navo-managed directory. Accounts, sessions and proxy settings are unchanged.'))}</p>${installation.status !== 'idle'?`<strong role="status">${esc(tr(...(installLabels[installation.status] || installLabels.error)))}${installation.version?' · '+esc(installation.version):''}</strong>${installation.busy?`<progress max="100" value="${Number(installation.progress)||0}" aria-label="${esc(tr('CLI 安装进度','CLI installation progress'))}"></progress><p>${Number(installation.progress)||0}%${installation.totalBytes?' · '+(Number(installation.receivedBytes||0)/1048576).toFixed(1)+' / '+(Number(installation.totalBytes)/1048576).toFixed(1)+' MB':''}</p>`:''}${installation.status === 'error'?`<p>${esc(tr(...(installErrors[installation.errorCode] || ['安装未完成，请检查网络和目录写入权限后重试。','Installation did not finish. Check the network and directory write permissions, then retry.'])))}${installation.httpStatus?' (HTTP '+Number(installation.httpStatus)+')':''}</p>`:''}`:''}</div>
      ${current.selected?.stable === false && current.selected?.protocolVerified ? `<p class="cli-runtime-message">${esc(tr('当前使用通过启动握手验证的预发行版。建议安装稳定版 CLI。','Using a prerelease that passed startup handshake validation. Installing the stable CLI is recommended.'))}</p>`:''}
      ${message ? `<p class="cli-runtime-message${failed?' error':''}" role="status">${esc(message)}</p>` : ''}
      ${discoveryIssues.length ? `<details class="cli-runtime-details"><summary>${esc(tr('部分来源未完成检查，请查看详情','Some sources were not fully checked; see details'))}</summary>${discoveryIssues.map(issue=>`<article><strong>${esc(label(issue.source))} · ${esc(label(issue.status))}</strong>${issue.path?`<code>${esc(issue.path)}</code>`:''}</article>`).join('')}</details>` : ''}
      <details class="cli-runtime-details"><summary>${esc(draftDiagnostics ? tr('未保存路径的诊断详情','Unsaved path diagnostics') : tr('查看候选与诊断详情','Candidate diagnostics'))} · ${diagnostics.candidates?.length||0}</summary>${(diagnostics.candidates||[]).map(row=>`<article><strong>${esc(label(row.source))} · ${esc(label(row.status))}</strong><code>${esc(row.path)}</code><small>${esc([row.version,row.durationMs!=null?`${row.durationMs} ms`:'',row.processErrorCode,row.exitCode!=null?`exit ${row.exitCode}`:''].filter(Boolean).join(' · '))}</small></article>`).join('') || `<p>${esc(emptyDiagnostics)}</p>`}</details>`;
  }
  panel.addEventListener('input', event => { if (event.target.id === 'cli-runtime-path') draftTouched = true; });
  panel.addEventListener('click', async event => {
    const button = event.target.closest('[data-cli-action]');
    if (!button || busy) return;
    const action = button.dataset.cliAction;
    if (installation.busy && action !== 'cancel') return;
    if (action === 'install' || action === 'cancel') {
      revision++; busy = true; message = ''; failed = false; render();
      try {
        installation = await api(action === 'install' ? '/api/cli-install' : '/api/cli-install/cancel', { method:'POST', body:'{}' });
      } catch { failed = true; message = tr('无法提交安装操作，请重新检测后重试。','Could not submit the installation operation. Check again and retry.'); }
      finally { busy = false; render(); schedulePoll(); }
      return;
    }
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
  api('/api/cli-state').then(data=>{if (revision === 0) { current=data;installation=data.installation || installation;render();schedulePoll(); }}).catch(()=>{
    if (revision === 0) { failed = true; message = tr('无法读取 CLI 状态，请重新检测。','Could not read CLI state. Select Check again.'); render(); }
  });
})();

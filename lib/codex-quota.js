const { spawn } = require('node:child_process');

function windowLabel(window) {
  const minutes = Number(window?.windowDurationMins);
  if (minutes >= 6 * 24 * 60) return '周额度';
  if (minutes >= 4 * 60 && minutes <= 6 * 60) return '5 小时额度';
  if (minutes >= 24 * 60) return `${Math.round(minutes / 1440)} 天额度`;
  if (minutes >= 60) return `${Math.round(minutes / 60)} 小时额度`;
  return '短时额度';
}

function normalizeWindow(window) {
  if (!window || !Number.isFinite(Number(window.usedPercent))) return null;
  const usedPercent = Math.max(0, Math.min(100, Number(window.usedPercent)));
  return {
    label: windowLabel(window),
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: Number.isFinite(Number(window.resetsAt)) ? Number(window.resetsAt) : null,
    windowDurationMins: Number.isFinite(Number(window.windowDurationMins)) ? Number(window.windowDurationMins) : null,
  };
}

function normalizeCredits(credits) {
  if (!credits || typeof credits !== 'object') return null;
  const points = credits.balance == null ? null : String(credits.balance).trim().slice(0, 32);
  return {
    hasCredits: credits.hasCredits === true,
    unlimited: credits.unlimited === true,
    points,
  };
}

function normalizeRateLimits(response) {
  const buckets = response?.rateLimitsByLimitId;
  const snapshot = (buckets && (buckets.codex || Object.values(buckets)[0])) || response?.rateLimits;
  if (!snapshot) throw new Error('Codex 没有返回额度信息');
  const windows = [normalizeWindow(snapshot.primary), normalizeWindow(snapshot.secondary)].filter(Boolean);
  if (!windows.length) throw new Error('当前账号没有可显示的额度窗口');
  windows.sort((left, right) => (right.windowDurationMins || 0) - (left.windowDurationMins || 0));
  return {
    planType: snapshot.planType || null,
    limitName: snapshot.limitName || null,
    credits: normalizeCredits(snapshot.credits),
    windows,
    refreshedAt: new Date().toISOString(),
  };
}

function readCodexQuota(executable, codexHome, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--stdio'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdoutBuffer = '';
    let stderr = '';

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish(new Error('读取额度超时，请稍后重试')), timeoutMs);

    child.once('error', (error) => finish(new Error(`无法启动 Codex 额度服务：${error.message}`)));
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1200); });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: null });
        } else if (message.id === 1 && message.error) {
          finish(new Error(message.error.message || 'Codex 额度服务初始化失败'));
        } else if (message.id === 2 && message.result) {
          try { finish(null, normalizeRateLimits(message.result)); }
          catch (error) { finish(error); }
        } else if (message.id === 2 && message.error) {
          finish(new Error(message.error.message || '读取额度失败'));
        }
      }
    });
    child.once('exit', (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex 额度服务已退出（${code ?? 'unknown'}）`));
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex-navo', title: 'Codex Navo', version: '1.1.18' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

module.exports = { normalizeCredits, normalizeRateLimits, readCodexQuota, windowLabel };

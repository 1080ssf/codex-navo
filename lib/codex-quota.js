const { spawn } = require('node:child_process');

// Codex Desktop's US pricing configuration currently values one credit at US$0.04.
// Keep the conversion in one place so it can be updated if OpenAI changes the rate.
const USD_PER_CREDIT = 0.04;

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
  const rawBalance = credits.balance == null ? null : String(credits.balance).trim().slice(0, 32);
  const numericBalance = Number(rawBalance);
  const quantity = Number.isFinite(numericBalance) ? Math.max(0, Math.floor(numericBalance)) : null;
  const usdBalance = quantity == null ? null : (quantity * USD_PER_CREDIT).toFixed(2);
  return {
    hasCredits: credits.hasCredits === true,
    unlimited: credits.unlimited === true,
    quantity,
    rawBalance,
    usdBalance,
    usdPerCredit: USD_PER_CREDIT,
  };
}

function hasSpendableCredits(credits) {
  if (!credits || typeof credits !== 'object') return false;
  if (credits.unlimited === true) return true;
  const balance = Number(credits.rawBalance ?? credits.balance ?? credits.quantity);
  return credits.hasCredits !== false && Number.isFinite(balance) && balance > 0;
}

function normalizeResetCredits(value) {
  if (!value || typeof value !== 'object') return null;
  const summary = value.summary && typeof value.summary === 'object' ? value.summary : value;
  const count = Number(summary.availableCount ?? summary.available_count ?? value.availableCount ?? value.available_count);
  const records = [value.credits, value.items, value.details].find(Array.isArray) ?? null;
  const timestamp = (input) => {
    if (input == null || input === '') return null;
    const milliseconds = typeof input === 'number' ? input * 1000 : Date.parse(input);
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  };
  const credits = records?.filter((item) => item && typeof item === 'object').map((item) => ({
    id: typeof item.id === 'string' ? item.id : null,
    resetType: typeof item.resetType === 'string' ? item.resetType : null,
    status: typeof item.status === 'string' ? item.status : null,
    grantedAt: timestamp(item.grantedAt ?? item.granted_at),
    expiresAt: timestamp(item.expiresAt ?? item.expires_at),
    title: typeof item.title === 'string' ? item.title : null,
    description: typeof item.description === 'string' ? item.description : null,
  })) ?? null;
  const expirations = (credits || [])
    .map((item) => Date.parse(item.expiresAt || ''))
    .filter(Number.isFinite);
  if (!Number.isFinite(count) && records === null) return null;
  return {
    availableCount: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : null,
    expiresAt: expirations.length ? new Date(Math.min(...expirations)).toISOString() : null,
    credits,
  };
}

function normalizeRateLimits(response) {
  const buckets = response?.rateLimitsByLimitId;
  const snapshot = (buckets && (buckets.codex || Object.values(buckets)[0])) || response?.rateLimits;
  if (!snapshot) throw new Error('Codex 没有返回额度信息');
  const windows = [normalizeWindow(snapshot.primary), normalizeWindow(snapshot.secondary)].filter(Boolean);
  if (!windows.length) throw new Error('当前账号没有可显示的额度窗口');
  // Keep the short rolling limit first in every account card. The weekly limit
  // remains available as the second row and is still used by pool eligibility.
  windows.sort((left, right) => (left.windowDurationMins || Number.MAX_SAFE_INTEGER)
    - (right.windowDurationMins || Number.MAX_SAFE_INTEGER));
  return {
    planType: snapshot.planType || null,
    limitName: snapshot.limitName || null,
    credits: normalizeCredits(snapshot.credits),
    resetCredits: normalizeResetCredits(
      response?.rateLimitResetCredits ?? response?.rate_limit_reset_credits
      ?? snapshot?.rateLimitResetCredits ?? snapshot?.rate_limit_reset_credits,
    ),
    windows,
    refreshedAt: new Date().toISOString(),
  };
}

function readCodexQuota(executable, codexHome, timeoutMs = 15_000, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--stdio'], {
      env: { ...environment, CODEX_HOME: codexHome },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let completed = false;
    let stdoutBuffer = '';
    let stderr = '';

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => {
        if (completed) return;
        completed = true;
        if (error) reject(error);
        else resolve(result);
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        complete();
        return;
      }
      child.once('exit', complete);
      if (!child.killed) child.kill();
      setTimeout(complete, 2_000).unref?.();
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
        clientInfo: { name: 'codex-navo', title: 'Codex Navo', version: '1.1.20' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function consumeCodexResetCredit(executable, codexHome, options = {}, environment = process.env) {
  const { idempotencyKey, creditId, timeoutMs = 30_000 } = options;
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) return Promise.reject(new Error('Missing idempotency key'));
  if (creditId != null && (typeof creditId !== 'string' || !creditId.trim())) return Promise.reject(new Error('Invalid credit ID'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--stdio'], {
      env: { ...environment, CODEX_HOME: codexHome }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let submitted = false;
    let buffer = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) error.outcomeUnknown = submitted;
      const complete = () => error ? reject(error) : resolve(result);
      if (child.exitCode !== null || child.signalCode !== null) return complete();
      child.once('exit', complete);
      child.kill();
      setTimeout(complete, 2_000).unref?.();
    };
    const timer = setTimeout(() => {
      const error = new Error('Reset credit request timed out; confirm the result before retrying');
      error.code = 'RESET_CREDIT_TIMEOUT';
      finish(error);
    }, timeoutMs);
    const send = (message) => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch (error) { finish(error); } };
    child.on('error', finish);
    child.stdin.on('error', finish);
    child.stderr.on('data', () => {});
    child.once('exit', () => { if (!settled) finish(new Error('Reset credit service exited before responding')); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
      for (const line of lines) {
        if (settled) break;
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (![1, 2].includes(message.id)) continue;
        if (message.error) {
          const error = new Error('Codex rejected the reset credit request');
          error.code = message.error.code;
          finish(error);
        } else if (message.id === 1 && message.result && !submitted) {
          send({ method: 'initialized' });
          submitted = true;
          send({ id: 2, method: 'account/rateLimitResetCredit/consume', params: { idempotencyKey, ...(creditId == null ? {} : { creditId }) } });
        } else if (message.id === 2 && message.result) {
          const outcome = message.result.outcome;
          if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(outcome)) finish(new Error('Unknown reset credit outcome'));
          else finish(null, { outcome });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-navo', version: '1.2.142' }, capabilities: { experimentalApi: true } } });
  });
}

function normalizeModelList(response) {
  const records = Array.isArray(response?.data) ? response.data : Array.isArray(response?.models) ? response.models : [];
  return [...new Map(records.map((record) => {
    const id = String(record?.id || record?.model || record?.slug || '').trim();
    return id ? [id, {
      id,
      label: String(record.displayName || record.display_name || record.name || id),
      hidden: record.hidden === true,
    }] : null;
  }).filter(Boolean)).values()];
}

function readCodexModels(executable, codexHome, timeoutMs = 20_000, environment = process.env) {
  return new Promise((resolve, reject) => {
    const collectedModels = new Map();
    const seenCursors = new Set();
    const child = spawn(executable, ['app-server', '--stdio'], {
      env: { ...environment, CODEX_HOME: codexHome },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let completed = false;
    let stdoutBuffer = '';
    let stderr = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => {
        if (completed) return;
        completed = true;
        if (error) reject(error); else resolve(result);
      };
      if (child.exitCode !== null || child.signalCode !== null) return complete();
      child.once('exit', complete);
      if (!child.killed) child.kill();
      setTimeout(complete, 2_000).unref?.();
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(() => finish(new Error('读取模型超时，请稍后重试')), timeoutMs);
    child.once('error', (error) => finish(new Error(`无法启动 Codex 模型服务：${error.message}`)));
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
          send({ id: 2, method: 'model/list', params: { includeHidden: false } });
        } else if (message.id === 1 && message.error) {
          finish(new Error(message.error.message || 'Codex 模型服务初始化失败'));
        } else if (message.id === 2 && message.result) {
          for (const model of normalizeModelList(message.result)) collectedModels.set(model.id, model);
          const cursor = message.result.nextCursor;
          if (cursor) {
            if (seenCursors.has(cursor)) return finish(new Error('Model list returned a repeated pagination cursor'));
            seenCursors.add(cursor);
            send({ id: 2, method: 'model/list', params: { includeHidden: false, cursor } });
            continue;
          }
          const models = [...collectedModels.values()];
          finish(models.length ? null : new Error('当前账号没有返回可用模型'), models);
        } else if (message.id === 2 && message.error) {
          finish(new Error(message.error.message || '读取模型失败'));
        }
      }
    });
    child.once('exit', (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex 模型服务已退出（${code ?? 'unknown'}）`));
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'codex-navo', title: 'Codex Navo', version: '1.2.87' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function warmCodexAppServer(executable, codexHome, timeoutMs = 90_000, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '-c',
      'features.code_mode_host=true',
      'app-server',
      '--analytics-default-enabled',
    ], {
      env: { ...environment, CODEX_HOME: codexHome },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const startedAt = Date.now();
    let settled = false;
    let completed = false;
    let stdoutBuffer = '';
    let stderr = '';

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => {
        if (completed) return;
        completed = true;
        if (error) reject(error);
        else resolve(result);
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        complete();
        return;
      }
      child.once('exit', complete);
      if (!child.killed) child.kill();
      setTimeout(complete, 2_000).unref?.();
    };

    const timer = setTimeout(() => {
      finish(new Error('Codex API 运行环境初始化超时，请重试'));
    }, timeoutMs);

    child.once('error', (error) => finish(new Error(`无法初始化 Codex API 运行环境：${error.message}`)));
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1600); });
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === '__codex_navo_warmup__' && message.result) {
          finish(null, { elapsedMs: Date.now() - startedAt, codexHome: message.result.codexHome || codexHome });
        } else if (message.id === '__codex_navo_warmup__' && message.error) {
          finish(new Error(message.error.message || 'Codex API 运行环境初始化失败'));
        }
      }
    });
    child.once('exit', (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex API 初始化进程已退出（${code ?? 'unknown'}）`));
    });
    child.stdin.write(`${JSON.stringify({
      id: '__codex_navo_warmup__',
      method: 'initialize',
      params: {
        clientInfo: { name: 'Codex Desktop', title: 'Codex Desktop', version: 'codex-navo-warmup' },
        capabilities: { experimentalApi: true },
      },
    })}\n`);
  });
}

module.exports = {
  consumeCodexResetCredit,
  hasSpendableCredits,
  normalizeCredits,
  normalizeResetCredits,
  normalizeRateLimits,
  readCodexModels,
  readCodexQuota,
  warmCodexAppServer,
  windowLabel,
  USD_PER_CREDIT,
};

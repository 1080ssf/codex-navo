const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

function parseCliVersion(stdout, stderr = '') {
  const match = `${stdout || ''}\n${stderr || ''}`.match(/(?:^|\n)\s*codex-cli\s+(\d+)\.(\d+)\.(\d+)([-+][\w.-]+)?\s*(?:\r?\n|$)/);
  if (!match) return null;
  return { parts: match.slice(1, 4).map(Number), version: `${match[1]}.${match[2]}.${match[3]}${match[4] || ''}`, stable: !match[4]?.startsWith('-') };
}

function selectNewestCli(candidates, getVersion) {
  let selected = null;
  let newest = null;
  for (const executable of [...new Set(candidates)]) {
    let version;
    try { version = getVersion(executable); } catch { continue; }
    if (!version) continue;
    const difference = newest ? version.map((part, index) => part - newest[index]).find(Boolean) || 0 : 1;
    if (difference > 0) { selected = executable; newest = version; }
  }
  if (!selected) throw new Error('No working stable Codex CLI was found; check the installed CLI or configure its path.');
  return selected;
}

// No shell or terminal window, including while probing a broken executable.
function runHidden(executable, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child, stdout = '', stderr = '', ended = false, timer;
    const finish = (patch) => {
      if (ended) return;
      ended = true; clearTimeout(timer);
      resolve({ stdout, stderr, durationMs: Date.now() - started, ...patch });
    };
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = (stream) => (chunk) => {
        if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) {
          child.kill(); finish({ code: 'output_limit', exitCode: null });
        }
      };
      child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
      child.once('error', (error) => finish({ code: error.code || 'spawn_failed', exitCode: null }));
      child.once('close', (exitCode) => finish({ code: exitCode === 0 ? '' : 'nonzero_exit', exitCode }));
      timer = setTimeout(() => { child.kill(); finish({ code: 'timeout', exitCode: null }); }, timeoutMs);
    } catch (error) { finish({ code: error.code || 'spawn_failed', exitCode: null }); }
  });
}

async function installedDesktopCli(run = runHidden) {
  if (process.platform !== 'win32') return [];
  const result = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { Join-Path $_.InstallLocation 'app\\resources\\codex.exe' }"], 8000);
  return result.exitCode === 0 ? result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
}

async function discoverCliCandidates({ environment = process.env, configured = '', desktopExecutable = '', desktopCandidates = installedDesktopCli,
  stat = file => fs.promises.stat(file), readdir = (directory, options) => fs.promises.readdir(directory, options), now = Date.now,
  timeoutMs = 8000, fileTimeoutMs = 2000, sourceTimeoutMs = 3000, concurrency = 4, onCandidate = () => {}, onIssue = () => {} } = {}) {
  if (configured) return [{ path: path.resolve(configured), source: 'configured', explicit: true }];
  const candidates = new Map();
  const deadline = now() + timeoutMs;
  const tasks = [];
  let closed = false;
  const before = (left, right) => left[0] - right[0] || left[1] - right[1];
  const add = (filename, source, order) => {
    if (!filename || !path.isAbsolute(filename)) return;
    const key = path.resolve(filename).toLowerCase();
    if (!candidates.has(key) || before(order, candidates.get(key).order) < 0) {
      const candidate = { path: path.resolve(filename), source, explicit: false };
      candidates.set(key, { candidate, order });
      onCandidate(candidate, order);
    }
  };
  const schedule = (source, location, body, priority = 0) => tasks.push({ source, location, body, priority, index: tasks.length });
  const pathDirs = String(environment.PATH || environment.Path || '').split(path.delimiter).map(value => value.replace(/^"|"$/g, '')).filter(Boolean);
  for (const dir of [...new Set(pathDirs)]) schedule('path', dir, context => context.probe(path.join(dir, 'codex.exe')), 1);
  const knownPrefixes = [environment.npm_config_prefix, environment.NPM_CONFIG_PREFIX,
    environment.APPDATA && path.join(environment.APPDATA, 'npm')].filter(Boolean);
  const prefixes = [...new Set([...knownPrefixes, ...pathDirs])];
  for (const prefix of prefixes) {
    schedule('npm', prefix, async context => {
      const base = path.join(prefix, 'node_modules', '@openai');
      if (!(await context.read(() => stat(base), base))?.isDirectory()) return;
      const roots = [path.join(base, 'codex'), path.join(base, 'codex', 'node_modules', '@openai', 'codex-win32-x64'),
        path.join(base, 'codex', 'node_modules', '@openai', 'codex-win32-arm64'), path.join(base, 'codex-win32-x64'), path.join(base, 'codex-win32-arm64')];
      for (const root of roots) for (const target of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']) {
        for (const subpath of [['vendor', target, 'bin', 'codex.exe'], ['vendor', target, 'codex', 'codex.exe']]) {
          if (!context.active()) return;
          await context.probe(path.join(root, ...subpath));
        }
      }
    }, knownPrefixes.includes(prefix) ? 0 : 2);
  }
  if (environment.LOCALAPPDATA) {
    const bin = path.join(environment.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    schedule('managed', bin, async context => {
      await context.probe(path.join(bin, 'codex.exe'));
      const entries = await context.read(() => readdir(bin, { withFileTypes: true }), bin) || [];
      for (const entry of entries) {
        if (!context.active()) return;
        if (entry.isDirectory()) await context.probe(path.join(bin, entry.name, 'codex.exe'));
      }
    });
  }
  if (environment.USERPROFILE) {
    const file = path.join(environment.USERPROFILE, '.local', 'bin', 'codex.exe');
    schedule('standalone', file, context => context.probe(file));
  }
  if (desktopExecutable) {
    const file = path.join(path.dirname(desktopExecutable), 'resources', 'codex.exe');
    schedule('desktop', file, context => context.probe(file));
  }
  schedule('desktop', 'OpenAI.Codex', async context => {
    const files = await context.read(desktopCandidates, 'OpenAI.Codex', 'timeout', sourceTimeoutMs) || [];
    for (const file of files) {
      if (!context.active()) return;
      await context.probe(file);
    }
  });

  // Check known local installations before an arbitrarily long PATH. The
  // original source/path order still decides duplicate attribution and ties.
  const queue = [...tasks].sort((left, right) => left.priority - right.priority || left.index - right.index);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(concurrency)), queue.length) }, async () => {
    while (!closed && now() < deadline && next < queue.length) {
      const task = queue[next++];
      const sourceDeadline = Math.min(deadline, now() + sourceTimeoutMs);
      let sourceClosed = false, sequence = 0;
      const active = () => !closed && !sourceClosed && now() < sourceDeadline;
      const read = (operation, target, status = 'stat_timeout', limitMs = fileTimeoutMs) => {
        if (!active()) return Promise.resolve(null);
        return new Promise(resolve => {
          let finished = false;
          const finish = (value, timedOut = false) => {
            if (finished) return;
            finished = true; clearTimeout(timer);
            if (timedOut && !closed && !sourceClosed) onIssue({ source: task.source, path: target, status });
            resolve(value);
          };
          const timer = setTimeout(() => finish(null, true), Math.max(1, Math.min(limitMs, sourceDeadline - now())));
          Promise.resolve().then(operation).then(value => active() ? finish(value) : finish(null, true), () => finish(null));
        });
      };
      const probe = async file => {
        const order = [task.index, sequence++];
        if ((await read(() => stat(file), file))?.isFile() && active()) add(file, task.source, order);
      };
      try { await task.body({ active, read, probe }); }
      catch (error) { onIssue({ source: task.source, path: task.location, status: 'spawn_failed', filesystemErrorCode: error?.code || '' }); }
      finally { sourceClosed = true; }
    }
  }));
  if (next < queue.length) onIssue({ source: 'discovery', path: '', status: 'budget_exhausted', skippedSources: queue.length - next });
  closed = true;
  return [...candidates.values()].sort((left, right) => before(left.order, right.order)).map(value => value.candidate);
}

const reasonLabels = {
  not_found: ['未找到 CLI 文件', 'No CLI file found'], missing: ['文件不存在', 'File missing'],
  prerelease: ['仅为预发行版本', 'Prerelease version'], timeout: ['版本检测超时', 'Version probe timed out'],
  stat_timeout: ['CLI 文件状态读取超时', 'CLI file status read timed out'],
  invalid_version: ['无法识别版本输出', 'Unrecognized version output'], nonzero_exit: ['进程异常退出', 'Process exited with an error'],
  budget_exhausted: ['本轮检测已达总时限', 'Probe budget exhausted'], output_limit: ['版本输出过长', 'Version output too large'],
  spawn_failed: ['无法启动 CLI 进程', 'CLI process could not start'], ready: ['可用', 'Ready'],
};
function cliDiagnosticMessage(state, chinese = false) {
  const label = code => (reasonLabels[code] || reasonLabels.spawn_failed)[chinese ? 0 : 1];
  const prefix = chinese ? 'Codex CLI 尚未就绪' : 'Codex CLI is not ready';
  const rows = state.candidates || [];
  if (!rows.length) return `${prefix}: ${label(state.discoveryStatus || 'not_found')}`;
  return `${prefix}: ${rows.map(row => `${path.basename(row.path)} [${row.source}]: ${label(row.status)}${row.version ? ` (${row.version})` : ''}${row.exitCode != null && row.exitCode !== 0 ? `, exit ${row.exitCode}` : ''}`).join('; ')}`;
}

function createCliResolver({ discover = discoverCliCandidates, run = runHidden, stat = file => fs.promises.stat(file), now = Date.now, timeoutMs = 8000, totalTimeoutMs = 24000, statTimeoutMs = 2000,
  discoveryTimeoutMs = 8000, sourceTimeoutMs = 3000, discoveryConcurrency = 4 } = {}) {
  const cache = new Map();
  let snapshot = { status: 'not_checked', checkedAt: null, selected: null, candidates: [] }, pending = null, pendingIdentity = '', fingerprint = '', cachedUntil = 0;
  const readStat = (file, remainingMs) => new Promise(resolve => {
    const started = now();
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ...result, durationMs: now() - started });
    };
    // A filesystem request itself cannot be cancelled. Late completion must
    // not change a diagnostic or start a version probe after this deadline.
    const timer = setTimeout(() => finish({ status: 'stat_timeout', stat: null }),
      Math.max(1, Math.min(statTimeoutMs, remainingMs)));
    Promise.resolve().then(() => stat(file)).then(value => finish({ stat: value }),
      error => finish({ status: 'missing', stat: null, filesystemErrorCode: error.code || '' }));
  });
  async function inspect(options = {}) {
    const identity = JSON.stringify([options.configured || '', options.desktopExecutable || '']);
    if (pending) {
      if (pendingIdentity === identity) return pending;
      await pending;
      return inspect(options);
    }
    if (!options.force && identity === fingerprint && now() < cachedUntil) return snapshot;
    pendingIdentity = identity;
    pending = (async () => {
      const started = now();
      // Keep incremental findings if any other source stalls. Reserve part of
      // the total budget for actual file validation and version probes.
      const discovered = new Map(), discoveryIssues = [];
      let acceptingDiscovery = true;
      const acceptCandidate = (candidate, order) => {
        if (!acceptingDiscovery || !candidate?.path) return;
        const key = path.resolve(candidate.path).toLowerCase();
        const previous = discovered.get(key);
        const rank = order || [Number.MAX_SAFE_INTEGER, discovered.size];
        if (!previous || rank[0] < previous.order[0] || (rank[0] === previous.order[0] && rank[1] < previous.order[1])) {
          discovered.set(key, { candidate, order: rank });
        }
      };
      const discoveryBudget = Math.max(1, Math.min(discoveryTimeoutMs,
        totalTimeoutMs - Math.min(timeoutMs + statTimeoutMs, totalTimeoutMs / 2)));
      let discoveryTimer, discoveryStatus = '';
      await Promise.race([
        Promise.resolve().then(() => options.configured
          ? [{ path: path.resolve(options.configured), source: 'configured', explicit: true }]
          : discover({ ...options, stat, now, timeoutMs: discoveryBudget, fileTimeoutMs: statTimeoutMs,
            sourceTimeoutMs, concurrency: discoveryConcurrency, onCandidate: acceptCandidate,
            onIssue: issue => { if (acceptingDiscovery && discoveryIssues.length < 100) discoveryIssues.push(issue); } }))
          .then(found => { for (const candidate of found) acceptCandidate(candidate); })
          .catch(() => { if (acceptingDiscovery) discoveryStatus = 'spawn_failed'; }),
        new Promise(resolve => { discoveryTimer = setTimeout(() => { discoveryStatus = 'timeout'; resolve(); }, discoveryBudget); }),
      ]).finally(() => { acceptingDiscovery = false; clearTimeout(discoveryTimer); });
      if (!discoveryStatus && discoveryIssues.length) discoveryStatus = discoveryIssues.some(issue => ['timeout', 'stat_timeout', 'budget_exhausted'].includes(issue.status)) ? 'timeout' : 'spawn_failed';
      const candidates = [...discovered.values()].sort((left, right) => left.order[0] - right.order[0] || left.order[1] - right.order[1]).map(value => value.candidate);
      let cursor = 0;
      const rows = new Array(candidates.length);
      await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, async () => {
        while (cursor < candidates.length) {
          const index = cursor++, candidate = candidates[index];
          const remainingMs = totalTimeoutMs - (now() - started);
          const checked = remainingMs > 0 ? await readStat(candidate.path, remainingMs)
            : { status: 'budget_exhausted', stat: null, durationMs: 0 };
          const stamp = checked.stat?.isFile() ? `${checked.stat.size}:${checked.stat.mtimeMs}` : '';
          const cached = cache.get(candidate.path);
          if (stamp && !options.force && cached?.stamp === stamp && now() < cached.until) { rows[index] = { ...candidate, ...cached.result, fingerprint: stamp, cached: true }; continue; }
          let result;
          if (checked.status) result = { status: checked.status, durationMs: checked.durationMs, filesystemErrorCode: checked.filesystemErrorCode || '' };
          else if (!stamp) result = { status: 'missing', durationMs: 0 };
          else if (now() - started >= totalTimeoutMs) result = { status: 'budget_exhausted', durationMs: 0 };
          else {
            const output = await run(candidate.path, ['--version'], Math.max(1, Math.min(timeoutMs, totalTimeoutMs - (now() - started))))
              .catch(error => ({ code: error.code || 'spawn_failed', exitCode: null }));
            const version = parseCliVersion(output.stdout, output.stderr);
            result = { status: output.code ? (reasonLabels[output.code] ? output.code : 'spawn_failed')
              : output.exitCode !== 0 ? 'nonzero_exit' : !version ? 'invalid_version' : version.stable ? 'ready' : 'prerelease',
              version: version?.version || '', parts: version?.parts || null, exitCode: output.exitCode,
              processErrorCode: output.code || '', durationMs: output.durationMs || 0 };
          }
          cache.set(candidate.path, { stamp, result, until: now() + (result.status === 'ready' ? 60000 : 15000) });
          rows[index] = { ...candidate, ...result, fingerprint: stamp };
        }
      }));
      const eligible = rows.filter(row => row.status === 'ready' && (!options.configured || row.explicit));
      let selected = null;
      if (eligible.length) {
        const file = selectNewestCli(eligible.map(row => row.path), file => eligible.find(row => row.path === file).parts);
        selected = eligible.find(row => row.path === file);
      }
      snapshot = { status: selected ? 'ready' : 'unavailable', checkedAt: new Date(now()).toISOString(), durationMs: now() - started, discoveryStatus, discoveryIssues, selected, candidates: rows };
      fingerprint = identity; cachedUntil = now() + (selected ? 30000 : 15000);
      return snapshot;
    })().finally(() => { pending = null; });
    return pending;
  }
  return {
    inspect, snapshot: () => snapshot,
    async resolve(options = {}) {
      const started = now();
      let result = await inspect(options);
      if (result.selected) {
        const remainingMs = totalTimeoutMs - (now() - started);
        const checked = remainingMs > 0 ? await readStat(result.selected.path, remainingMs)
          : { status: 'budget_exhausted', stat: null, durationMs: 0 };
        if (checked.status === 'stat_timeout' || checked.status === 'budget_exhausted') {
          const previous = result;
          result = { ...previous, status: 'unavailable', selected: null, checkedAt: new Date(now()).toISOString(), durationMs: now() - started,
            candidates: previous.candidates.map(row => row.path === previous.selected.path
              ? { ...row, status: checked.status, durationMs: checked.durationMs, fingerprint: '', cached: false } : row) };
          cache.delete(previous.selected.path);
          // Another caller may meanwhile have inspected a different explicit
          // path. Do not replace that caller's newer diagnostic with ours.
          if (snapshot === previous) { snapshot = result; cachedUntil = now() + 15000; }
        } else {
          const stamp = checked.stat?.isFile() ? `${checked.stat.size}:${checked.stat.mtimeMs}` : '';
          if (!stamp || result.selected.fingerprint !== stamp) result = await inspect({ ...options, force: true });
        }
      }
      if (result.selected) return result.selected.path;
      const error = new Error(cliDiagnosticMessage(result, true)); error.code = 'CODEX_CLI_UNAVAILABLE'; error.diagnostics = result;
      throw error;
    },
  };
}

module.exports = { selectNewestCli, parseCliVersion, runHidden, discoverCliCandidates, createCliResolver, cliDiagnosticMessage };

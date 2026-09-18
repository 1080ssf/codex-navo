const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// A handshake only: never inherit an account home, keys, projects or MCP config.
async function probeCliProtocol(executable, timeoutMs = 8000, { spawnProcess = spawn } = {}) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'navo-cli-probe-'));
  const started = Date.now();
  let closed = false;
  try {
    return await new Promise(resolve => {
      let child, timer, cleanupTimer, settled = false, completed = false, buffer = '', bytes = 0;
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const complete = () => {
          if (completed) return;
          completed = true; clearTimeout(cleanupTimer);
          resolve({ ...result, durationMs: Date.now() - started });
        };
        if (!child || closed) { closed = true; complete(); return; }
        child.once('close', complete);
        child.stdin?.end();
        try { child.kill(); } catch {}
        cleanupTimer = setTimeout(complete, 1000);
      };
      try {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
          /^(SystemRoot|WINDIR|PATH|PATHEXT|TEMP|TMP|COMSPEC|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)));
        child = spawnProcess(executable, ['app-server'], {
          cwd: home, env: { ...env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        });
        timer = setTimeout(() => finish({ ok: false, code: 'protocol_timeout' }), timeoutMs);
        child.once('error', error => finish({ ok: false, code: 'spawn_failed', processErrorCode: error.code || '' }));
        child.once('close', () => { closed = true; finish({ ok: false, code: 'protocol_failed' }); });
        child.stdin.on('error', () => finish({ ok: false, code: 'protocol_failed' }));
        child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 262144) finish({ ok: false, code: 'protocol_failed' }); });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          if (settled) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > 262144) { finish({ ok: false, code: 'protocol_failed' }); return; }
          buffer += chunk;
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) {
            let message;
            try { message = JSON.parse(line); } catch { continue; }
            if (message.id !== 'navo-cli-probe') continue;
            if (!message.error && message.result && typeof message.result.userAgent === 'string') {
              child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
              finish({ ok: true, code: '' });
            } else finish({ ok: false, code: 'protocol_failed' });
            break;
          }
        });
        child.stdin.write(`${JSON.stringify({ id: 'navo-cli-probe', method: 'initialize', params: {
          clientInfo: { name: 'codex-navo', title: 'Codex Navo', version: 'cli-compatibility-check' },
          capabilities: { experimentalApi: true },
        } })}\n`);
      } catch (error) { finish({ ok: false, code: 'spawn_failed', processErrorCode: error.code || '' }); }
    });
  } finally {
    // This exact, freshly-created directory is disposable; never remove an account home.
    if (closed) await fs.promises.rm(home, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
}

module.exports = { probeCliProtocol };

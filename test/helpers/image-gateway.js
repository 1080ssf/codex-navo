// Runs the production HTTP handler and manager with an isolated, in-memory Key.
// No production server startup, credentials, profiles or persistent settings.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const serviceModule = require('../../lib/api-service');
const compat = require('../../lib/openai-compat');
const { codexUpstreamHeaders } = require('../../lib/codex-upstream-headers');
const { upstreamMessage } = require('../../lib/upstream-error');
const { createUsageTap } = require('../../lib/usage-stream');

async function createImageGateway(poolForwarder, { models = ['gpt-6-astra'], allowlist = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'navo-image-fixture-'));
  const service = new serviceModule.ApiServiceManager({ runtimeRoot: root,
    readJson: (_file, fallback) => fallback, writeJsonAtomic() {}, poolForwarder });
  service.saveConfig({ enabled: true });
  service.ensureAccountPool(models);
  const created = service.createKey({ accountIds: ['image-fixture'], modelAllowlist: allowlist });
  const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  const context = { ...serviceModule, ...compat, crypto, Buffer, URL, Readable, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    apiServiceManager: service, MAX_API_REQUEST_BYTES: 32 * 1024 * 1024,
    imageDriverModelForKey: () => '', codexUpstreamHeaders, upstreamMessage, createUsageTap, auditUpstreamFailure() {},
  };
  const start = source.indexOf('function securityHeaders(');
  const end = source.indexOf('\nfunction audit(', start);
  const gatewayStart = source.indexOf('async function apiGatewayHandler(');
  const gatewayEnd = source.indexOf('\nconst server = http.createServer', gatewayStart);
  if (Math.min(start, end, gatewayStart, gatewayEnd) < 0) throw new Error('Production gateway functions not found');
  vm.runInNewContext(source.slice(start, end) + '\n' + source.slice(gatewayStart, gatewayEnd), context);
  const server = http.createServer(context.apiGatewayHandler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { service, base: `http://127.0.0.1:${server.address().port}`,
    headers: { Authorization: `Bearer ${created.secret}`, 'Content-Type': 'application/json' },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      // Only the exact directory created above is removed.
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
module.exports = { createImageGateway };

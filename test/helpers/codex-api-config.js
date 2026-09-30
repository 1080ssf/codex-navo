const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { withDesktopLocale } = require('../../lib/codex-launch-view');
const { normalizeWindowsSandbox } = require('../../lib/codex-launch-auth');
const { removeTaskProxy } = require('../../lib/codex-launch-network');

// Exercise the production config builder without starting Navo or touching
// the user's shared Codex home.
function configFunctions(port = 18300) {
  const source = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
  const start = source.indexOf('function tomlString(');
  const end = source.indexOf('function prepareApiKeyCodexHome(', start);
  if (start < 0 || end < 0) throw new Error('Codex config builder not found');
  const context = { API_GATEWAY_PORT: port, withDesktopLocale, normalizeWindowsSandbox, removeTaskProxy };
  vm.runInNewContext(source.slice(start, end), context);
  return { build: context.apiKeyCodexConfig, restore: context.configAfterApiKeyCodex };
}

module.exports = { configFunctions };

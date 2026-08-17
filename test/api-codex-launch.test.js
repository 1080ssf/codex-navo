const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const root = path.join(__dirname, '..');

test('API Codex prewarms the shared app-server before desktop launch', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const quota = fs.readFileSync(path.join(root, 'lib', 'codex-quota.js'), 'utf8');
  assert.match(server, /await warmCodexAppServer\(findCodexCli\(\), codexHomeDir, 90_000, environment\)/);
  assert.ok(
    server.indexOf('await warmCodexAppServer') < server.indexOf('spawnDetached(installation.executable', server.indexOf('async function launchApiKeyCodex')),
    'warmup must finish before the Codex Desktop process is spawned',
  );
  assert.match(quota, /features\.code_mode_host=true/);
  assert.match(quota, /__codex_navo_warmup__/);
  assert.match(quota, /Codex API 运行环境初始化超时/);
});

test('API Codex recovery app-servers retain the launch-scoped gateway credential', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const config = server.slice(server.indexOf('function apiKeyCodexConfig'), server.indexOf('function prepareApiKeyCodexHome'));
  assert.match(config, /experimental_bearer_token/);
  assert.doesNotMatch(config, /env_key = "OPENAI_API_KEY"/);
  assert.match(server, /apiKeyCodexConfig\(sourceConfig, model, secret, selection\?\.language\)/);
});

test('account-pool failover cools down exhausted accounts and preserves the remaining pool', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /const accountPoolCooldowns = new Map\(\)/);
  assert.match(server, /retryableAccountPoolResponse/);
  assert.match(server, /insufficient_quota\|usage_limit\|rate_limit/);
  assert.match(server, /accountPoolCooldowns\.set\(accountId, Date\.now\(\) \+ duration\)/);
  assert.match(server, /saveAccounts\(\[\.\.\.accounts\]\)/);
});

test('API Codex validates its assigned proxy route before opening the desktop app', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const launchStart = server.indexOf('async function launchApiKeyCodex');
  const launchEnd = server.indexOf('\n}', launchStart);
  const launch = server.slice(launchStart, launchEnd + 2);
  assert.match(server, /async function prepareApiKeyNetwork/);
  assert.match(server, /networkManager\.preflightAccount\(networkId, 12_000\)/);
  assert.match(launch, /stage: 'network'/);
  assert.match(launch, /await prepareApiKeyNetwork\(keyId, \{ preflight: true, purpose: '启动 API Codex' \}\)/);
  assert.ok(
    launch.indexOf('await prepareApiKeyNetwork') < launch.indexOf('prepareApiKeyCodexHome'),
    'proxy preflight must finish before shared Codex state is modified',
  );
  assert.ok(
    launch.indexOf('await prepareApiKeyNetwork') < launch.indexOf('spawnDetached(installation.executable'),
    'proxy preflight must finish before Codex Desktop is spawned',
  );
  assert.match(launch, /const apiKeyNetwork = await prepareApiKeyNetwork/);
  assert.match(server, /const API_CODEX_PROXY_PORT = 18301/);
  assert.match(launch, /await prepareStableApiCodexProxy\(apiKeyNetwork\)/);
  assert.match(launch, /--proxy-server=http:\/\/127\.0\.0\.1:\$\{stableProxyPort\}/);
  assert.match(launch, /--proxy-bypass-list=<local>;localhost;\*\.localhost;127\.0\.0\.1;\[::1\]/);
});

test('API Codex proxies arbitrary task websites while keeping only local IPC direct', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const environmentStart = server.indexOf('async function apiKeyTaskEnvironment');
  const environmentEnd = server.indexOf('async function accountPoolDispatcher', environmentStart);
  const launchStart = server.indexOf('async function launchApiKeyCodex');
  const launchEnd = server.indexOf('\n}', launchStart);
  const environmentSource = server.slice(environmentStart, environmentEnd);
  const launchSource = server.slice(launchStart, launchEnd + 2);
  assert.match(environmentSource, /networkManager\.environmentForRuntime/);
  assert.match(launchSource, /apiKeyTaskEnvironment\(keyId, apiCodexEnvironment\(process\.env, secret\)\)/);
  assert.doesNotMatch(launchSource, /github\.com|api\.github\.com/);
  assert.match(launchSource, /--proxy-server=http:\/\/127\.0\.0\.1:/);
  assert.match(launchSource, /--proxy-bypass-list=<local>;localhost;\*\.localhost;127\.0\.0\.1;\[::1\]/);
  const backgroundStart = server.indexOf('async function backgroundTaskRuntime');
  const backgroundEnd = server.indexOf('async function backgroundTaskEnvironment', backgroundStart);
  const backgroundSource = server.slice(backgroundStart, backgroundEnd);
  assert.match(backgroundSource, /readActiveApiCodex\(\)/);
  assert.match(backgroundSource, /apiKeyNetworkId\(activeApi\.keyId\)/);
});

test('API Codex launch installs temporary API auth while sharing normal project and conversation state', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const functionStart = server.indexOf('function apiCodexEnvironment');
  const functionEnd = server.indexOf('\n}', functionStart);
  const source = server.slice(functionStart, functionEnd + 2);
  assert.match(source, /applyProxyEnvironment\(environment, \{ enabled: false \}\)/);
  assert.match(source, /next\.CODEX_HOME = SHARED_CODEX_HOME/);
  assert.match(source, /delete next\.CODEX_ELECTRON_USER_DATA_PATH/);
  assert.match(source, /delete next\.CODEX_SQLITE_HOME/);
  assert.match(source, /next\.NO_PROXY = 'localhost,127\.0\.0\.1,::1,\.localhost,0\.0\.0\.0'/);
  assert.match(server, /apiCodexEnvironment\(process\.env, secret\)/);
  assert.match(server, /copyFileAtomic\(configFile, API_SHARED_CONFIG_BACKUP_FILE\)/);
  assert.match(server, /authManaged: true/);
  assert.match(server, /'model_provider = "codex_navo"'/);
  assert.match(server, /'\[model_providers\.codex_navo\]'/);
  assert.match(server, /reserve the built-in `openai` provider id/);
  assert.match(server.slice(
    server.indexOf('function prepareApiKeyCodexHome'),
    server.indexOf('function repairSharedCodexPreferences'),
  ), /writeJsonAtomic\(SHARED_CODEX_AUTH_FILE, \{ OPENAI_API_KEY: secret \}\)/);
});

test('API Codex launch does not clear the active managed account marker', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const launchStart = server.indexOf('async function launchApiKeyCodex');
  const launchEnd = server.indexOf('\n}', launchStart);
  const launch = server.slice(launchStart, launchEnd + 2);
  assert.doesNotMatch(launch, /restoreSharedCodexAuth\(activeAccount\.accountId\)/);
  assert.doesNotMatch(launch, /const activeAccount = readActiveCodexAuth\(\)/);
  assert.match(server, /function readActiveApiCodex\(\)/);
  assert.match(server, /const hasActiveApiCodex = typeof context\.hasActiveApiCodex === 'boolean'/);
  assert.match(server, /const activeAccountId = hasActiveApiCodex \? '' : \(context\.activeAccountId \|\| activeCodexAccountId\(context\.codexSnapshot\)\)/);
});

test('managed Codex state survives stale or missing lease records', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const activeStart = server.indexOf('function activeCodexAccountId');
  const activeEnd = server.indexOf('function activateSharedCodexAuth', activeStart);
  const active = server.slice(activeStart, activeEnd);
  assert.match(active, /if \(!lease\) return active\.accountId/);
  assert.match(active, /if \(lease\.launchType !== 'codex'\) return ''/);
  assert.match(active, /if \(snapshot\?\.reliable && !snapshot\.pid\) return ''/);
  assert.match(active, /codexProcessIdentityMatches\(active\.processIdentity, snapshot\)/);
  const bootstrapStart = server.indexOf("url.pathname === '/api/bootstrap'");
  const bootstrapEnd = server.indexOf("url.pathname === '/api/usage'", bootstrapStart);
  const bootstrap = server.slice(bootstrapStart, bootstrapEnd);
  assert.ok(
    bootstrap.indexOf('const apiServiceState = publicApiServiceState()') < bootstrap.indexOf('accounts: accounts.map'),
    'bootstrap must reconcile API Codex before rendering account activity',
  );
  assert.match(bootstrap, /accounts: accounts\.map\(\(account\) => accountView\(account, accountContext\)\)/);
});

test('managed launches persist a process fingerprint instead of trusting PID alone', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(server, /CreationDate/);
  assert.match(server, /commandLineHash/);
  assert.match(server, /launchId: crypto\.randomUUID\(\)/);
  assert.match(server, /recordSharedCodexProcess\(account\.id, detectCodexDesktopSnapshot/);
  assert.match(server, /result\.lease\.processIdentity = readActiveCodexAuth\(\)\?\.processIdentity/);
  assert.match(server, /process-identity-changed/);
});

test('API lifecycle follows ChatGPT and Codex Store process replacements without restoring live credentials', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const reconcileStart = server.indexOf('function reconcileActiveApiCodexState');
  const reconcileEnd = server.indexOf('async function launchApiKeyCodex', reconcileStart);
  const reconcile = server.slice(reconcileStart, reconcileEnd);
  assert.match(server, /Name = 'ChatGPT\.exe' OR Name = 'codex\.exe'/);
  assert.match(server, /Get-Process -Name ChatGPT,codex/);
  assert.match(reconcile, /codexProcessIdentityMatches\(active\.processIdentity, snapshot\)/);
  assert.match(reconcile, /replacementMatchesInstall/);
  assert.match(reconcile, /active\.status === 'running' && snapshot\.pid && \(replacementMatchesExecutable \|\| replacementMatchesInstall\)/);
  assert.match(reconcile, /processPid: snapshot\.pid/);
  assert.match(reconcile, /replacementMatchesExecutable/);
});

test('API Codex launch status cannot be mistaken for an exited desktop during warmup', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const prepareStart = server.indexOf('function prepareApiKeyCodexHome');
  const prepareEnd = server.indexOf('function repairSharedCodexPreferences', prepareStart);
  const prepare = server.slice(prepareStart, prepareEnd);
  assert.match(prepare, /status: 'preparing'/);
  assert.match(prepare, /writeJsonAtomic\(ACTIVE_API_CODEX_FILE, active\)/);
  assert.ok(
    prepare.indexOf('writeJsonAtomic(ACTIVE_API_CODEX_FILE, active)') < prepare.indexOf('fs.writeFileSync(configFile'),
    'rollback marker must be durable before the shared configuration changes',
  );
  assert.match(prepare, /status: 'launching'/);
  assert.match(server, /\['preparing', 'launching'\]\.includes\(active\.status\) && launchIsRecent/);
  assert.match(server, /const apiCodexLifecycleTimer = setInterval/);
  assert.match(server, /reconcileActiveApiCodexState\(\)/);
  const launchStart = server.indexOf('async function launchApiKeyCodex');
  const launch = server.slice(launchStart, server.indexOf('function stopApiKeyCodex', launchStart));
  assert.match(launch, /await waitForCodexDesktop\(60_000\)/);
  assert.match(launch, /recovered-after-launch-warning/);
  assert.ok(
    launch.indexOf('if (snapshot.pid && activeRecord)') < launch.indexOf('restoreApiKeyCodexHome(activeRecord || undefined)'),
    'a late Store process must be adopted before restoring codex_navo config',
  );
});

test('API Codex shared-state transaction preserves launch config during warmup and restores original bytes', async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-navo-api-transaction-'));
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: value } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(value));
    });
  });
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const runtime = process.env.CODEX_SWITCHBOARD_USER_DATA;
    const shared = path.join(runtime, 'shared-codex');
    fs.mkdirSync(shared, { recursive: true });
    const originalConfig = 'model = "gpt-5.6-sol"\\npersonality = "pragmatic"\\n';
    const originalAuth = '{"tokens":{"access_token":"original"}}\\n';
    fs.writeFileSync(path.join(shared, 'config.toml'), originalConfig);
    fs.writeFileSync(path.join(shared, 'auth.json'), originalAuth);
    const mod = require(${JSON.stringify(path.join(root, 'server.js'))});
    const prepared = mod.__test.prepareApiKeyCodexHome('key-test', 'gpt-5.6-sol', 'launch-secret');
    const lockFile = path.join(runtime, 'profiles', 'codex', '_api-shared', 'config.lock');
    if (!fs.existsSync(lockFile)) throw new Error('config lock was not acquired');
    const duringWarmup = mod.__test.reconcileActiveApiCodexState();
    if (!duringWarmup || !['launching', 'running'].includes(duringWarmup.status)) throw new Error('launch state was restored during warmup');
    const launchConfig = fs.readFileSync(path.join(shared, 'config.toml'), 'utf8');
    if (!launchConfig.includes('model_provider = "codex_navo"')) throw new Error('launch provider identity was not installed');
    if (!launchConfig.includes('[model_providers.codex_navo]')) throw new Error('local gateway transport was not installed');
    if (launchConfig.includes('[model_providers.openai]')) throw new Error('reserved built-in provider was overridden');
    const launchAuth = JSON.parse(fs.readFileSync(path.join(shared, 'auth.json'), 'utf8'));
    if (launchAuth.OPENAI_API_KEY !== 'launch-secret') throw new Error('launch-scoped API key auth was not installed');
    mod.__test.restoreApiKeyCodexHome(prepared);
    if (fs.readFileSync(path.join(shared, 'config.toml'), 'utf8') !== originalConfig) throw new Error('config bytes were not restored');
    if (fs.readFileSync(path.join(shared, 'auth.json'), 'utf8') !== originalAuth) throw new Error('auth bytes were not restored');
    if (fs.existsSync(lockFile)) throw new Error('config lock was not released');

    fs.rmSync(path.join(shared, 'auth.json'), { force: true });
    const preparedWithoutOriginalAuth = mod.__test.prepareApiKeyCodexHome('key-test', 'gpt-5.6-sol', 'second-launch-secret');
    const secondLaunchAuth = JSON.parse(fs.readFileSync(path.join(shared, 'auth.json'), 'utf8'));
    if (secondLaunchAuth.OPENAI_API_KEY !== 'second-launch-secret') throw new Error('temporary auth was not installed without an original auth file');
    mod.__test.restoreApiKeyCodexHome(preparedWithoutOriginalAuth);
    if (fs.existsSync(path.join(shared, 'auth.json'))) throw new Error('missing original auth state was not restored');

    fs.rmSync(path.join(shared, 'config.toml'), { force: true });
    const preparedWithoutOriginalConfig = mod.__test.prepareApiKeyCodexHome('key-test', 'gpt-5.6-sol', 'third-launch-secret');
    fs.appendFileSync(path.join(shared, 'config.toml'), '\\n[windows]\\nsandbox = "elevated"\\n');
    mod.__test.restoreApiKeyCodexHome(preparedWithoutOriginalConfig);
    const generatedDefaults = fs.readFileSync(path.join(shared, 'config.toml'), 'utf8');
    if (!generatedDefaults.includes('[windows]')) throw new Error('Codex-generated defaults were deleted after first API launch');
    if (generatedDefaults.includes('codex_navo') || generatedDefaults.includes('third-launch-secret')) throw new Error('launch-scoped provider leaked into preserved defaults');
    mod.server.close();
    mod.apiGatewayServer.close();
    process.exit(0);
  `], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CODEX_SWITCHBOARD_USER_DATA: runtime,
      CODEX_MANAGER_MOCK_LAUNCH: '1',
      CODEX_MANAGER_NO_OPEN: '1',
      CODEX_MANAGER_PORT: '0',
      CODEX_NAVO_API_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(runtime, { recursive: true, force: true });
  assert.equal(code, 0, `${stdout}\n${stderr}`);
});

test('API Codex launch owns auth transaction and rebinds Store root process replacements', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const prepareStart = server.indexOf('function prepareApiKeyCodexHome');
  const prepareEnd = server.indexOf('function repairSharedCodexPreferences', prepareStart);
  const prepare = server.slice(prepareStart, prepareEnd);
  assert.match(prepare, /copyFileAtomic\(SHARED_CODEX_AUTH_FILE, API_SHARED_AUTH_BACKUP_FILE\)/);
  assert.match(prepare, /authManaged: true/);
  assert.match(prepare, /writeJsonAtomic\(SHARED_CODEX_AUTH_FILE, \{ OPENAI_API_KEY: secret \}\)/);
  assert.match(prepare, /activateAutomationScope\(/);
  assert.match(server, /deactivateAutomationScope\(/);
  assert.match(server, /attemptLegacyAutomationQuarantine/);
  assert.match(server, /api\.codex\.process-rebound/);
  assert.match(server, /active\.status === 'running' && snapshot\.pid && \(replacementMatchesExecutable \|\| replacementMatchesInstall\)/);
});

test('running API Codex proxy switches validate the new route before keeping it', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const start = server.indexOf('const apiKeyNetworkMatch');
  const end = server.indexOf('const apiKeyLaunchMatch', start);
  const endpoint = server.slice(start, end);
  assert.match(endpoint, /activeApi\?\.keyId === keyId/);
  assert.match(endpoint, /networkManager\.preflightAccount\(networkId, 12_000\)/);
  assert.match(endpoint, /api\.key\.network\.hot-switch-validated/);
  assert.match(endpoint, /networkManager\.assign\(networkId, previousAssignment\)/);
});

const fs = require('node:fs');
const path = require('node:path');
const { AccountNetworkManager, CORE_VERSION } = require('../lib/account-network');

async function main() {
  const cacheRoot = path.join(__dirname, '..', '.cache');
  const manager = new AccountNetworkManager({ runtimeRoot: cacheRoot });
  const executable = await manager.installCore();
  const expected = path.join(cacheRoot, 'network-core', `mihomo-${CORE_VERSION}.exe`);
  if (path.resolve(executable) !== path.resolve(expected) || !fs.existsSync(expected)) {
    throw new Error('Mihomo build cache was not prepared');
  }
  process.stdout.write(`Mihomo ${CORE_VERSION} is ready for packaging.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});

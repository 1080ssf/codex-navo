const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pidFile = path.join(__dirname, 'data', 'server.pid');

try {
  const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('PID 文件无效');
  const commandLine = execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
  ], { encoding: 'utf8', windowsHide: true }).trim();
  if (!/\bserver\.js\b/i.test(commandLine)) throw new Error('记录的进程不是账号切换台');
  process.kill(pid, 'SIGTERM');
  fs.rmSync(pidFile, { force: true });
  console.log('Launcher stopped.');
} catch (error) {
  if (error.code === 'ENOENT') console.log('Launcher is not running.');
  else {
    console.error(`[ERROR] ${error.message}`);
    process.exitCode = 1;
  }
}

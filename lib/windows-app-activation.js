const { spawn } = require('node:child_process');

function quoteArgument(value) {
  return '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

// Supported Windows app activation, preserving Chromium arguments unlike an
// Explorer AppsFolder launch. Windows does not promise to inherit brokered env.
function activationScript(appUserModelId, args) {
  if (!/^[\w.-]+![\w.-]+$/.test(appUserModelId || '')) throw new Error('Codex 安装缺少有效的 Windows 应用标识');
  const payload = Buffer.from(JSON.stringify({ id: appUserModelId, args: args.map(quoteArgument).join(' ') })).toString('base64');
  return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface INavoApplicationActivationManager {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string id, [MarshalAs(UnmanagedType.LPWStr)] string args, uint options, out uint pid);
}
public static class NavoApplicationActivation {
  public static uint Start(string id, string args) {
    object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
    try { uint pid; int result = ((INavoApplicationActivationManager)instance).ActivateApplication(id, args, 0, out pid); Marshal.ThrowExceptionForHR(result); return pid; }
    finally { Marshal.ReleaseComObject(instance); }
  }
}
'@
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
try { [Console]::Out.WriteLine([NavoApplicationActivation]::Start($request.id, $request.args)) }
catch {
  $failure = $_.Exception
  while ($failure.InnerException) { $failure = $failure.InnerException }
  [Console]::Error.WriteLine(('NAVO_ACTIVATION_HRESULT=0x{0:X8}' -f $failure.HResult))
  exit 1
}
`;
}

function activatePackagedApp(appUserModelId, args, environment, { spawnProcess = spawn, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, output = '', diagnostic = '', settled = false;
    const finish = (error, pid) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(pid); };
    try {
      const script = activationScript(appUserModelId, args);
      child = spawnProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
      });
      timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error('Windows 系统激活超时'), { code: 'CODEX_ACTIVATION_TIMEOUT' })); }, timeoutMs);
      child.once('error', error => finish(error));
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4096); });
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8');
        if (output.length > 4096) { child.kill(); finish(new Error('Windows 系统激活返回异常')); }
      });
      child.once('close', code => {
        const pid = /^\s*\d+\s*$/.test(output) ? Number(output.trim()) : 0;
        if (code === 0 && Number.isSafeInteger(pid) && pid > 0) finish(null, pid);
        else {
          const hresult = diagnostic.match(/NAVO_ACTIVATION_HRESULT=(0x[0-9A-Fa-f]{8})/)?.[1] || '';
          finish(Object.assign(new Error(`Windows 系统激活失败${hresult ? `（${hresult}）` : ''}`), { code: 'CODEX_ACTIVATION_FAILED', hresult }));
        }
      });
    } catch (error) { finish(error); }
  });
}

module.exports = { activatePackagedApp, activationScript, quoteArgument };

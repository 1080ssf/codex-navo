param(
  [ValidateSet('check', 'install')]
  [string]$Mode = 'check',
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [Parameter(Mandatory = $true)]
  [string]$ProgressPath
)

$ErrorActionPreference = 'Stop'

function Write-Result([hashtable]$Value) {
  $directory = Split-Path -Parent $OutputPath
  if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $temporary = "$OutputPath.$PID.tmp"
  $Value | ConvertTo-Json -Compress -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
}

function Await-Operation($Operation, [Type]$ResultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethodDefinition -and
      $_.GetGenericArguments().Count -eq 1 -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  if (-not $method) { throw 'Windows Runtime task adapter is unavailable.' }
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

function Await-ProgressOperation($Operation, [Type]$ResultType, [Type]$ProgressType) {
  if (-not ('CodexNavo.FileProgress`1' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.IO;
using System.Reflection;

namespace CodexNavo {
  public sealed class FileProgress<T> : IProgress<T> {
    private readonly string path;
    public FileProgress(string path) { this.path = path; }

    private static object Read(object value, string name) {
      if (value == null) return null;
      Type type = value.GetType();
      PropertyInfo property = type.GetProperty(name);
      if (property != null) return property.GetValue(value, null);
      FieldInfo field = type.GetField(name);
      return field == null ? null : field.GetValue(value);
    }

    private static string Number(object value) {
      if (value == null) return "0";
      return Convert.ToDouble(value, CultureInfo.InvariantCulture).ToString("R", CultureInfo.InvariantCulture);
    }

    private static string Text(object value) {
      string text = value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture);
      return text.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n");
    }

    public void Report(T value) {
      object boxed = value;
      string json = "{" +
        "\"packageFamilyName\":\"" + Text(Read(boxed, "PackageFamilyName")) + "\"," +
        "\"packageUpdateState\":\"" + Text(Read(boxed, "PackageUpdateState")) + "\"," +
        "\"packageDownloadProgress\":" + Number(Read(boxed, "PackageDownloadProgress")) + "," +
        "\"totalDownloadProgress\":" + Number(Read(boxed, "TotalDownloadProgress")) + "," +
        "\"packageBytesDownloaded\":" + Number(Read(boxed, "PackageBytesDownloaded")) + "," +
        "\"packageDownloadSizeInBytes\":" + Number(Read(boxed, "PackageDownloadSizeInBytes")) + "," +
        "\"updatedAt\":\"" + DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + "\"}";
      string directory = Path.GetDirectoryName(path);
      if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
      File.WriteAllText(path, json);
    }
  }
}
'@
  }
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethodDefinition -and
      $_.GetGenericArguments().Count -eq 2 -and
      $_.GetParameters().Count -eq 2 -and
      $_.GetParameters()[1].ParameterType.Name -eq 'IProgress`1'
    } |
    Select-Object -First 1
  if (-not $method) { throw 'Windows Runtime progress task adapter is unavailable.' }
  $writerType = [CodexNavo.FileProgress`1].MakeGenericType($ProgressType)
  $writer = [Activator]::CreateInstance($writerType, @($ProgressPath))
  $task = $method.MakeGenericMethod($ResultType, $ProgressType).Invoke($null, @($Operation, $writer))
  $task.Wait()
  return $task.Result
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $context = [Windows.Services.Store.StoreContext, Windows.Services.Store, ContentType = WindowsRuntime]::GetDefault()
  $updateListType = [System.Collections.Generic.IReadOnlyList[Windows.Services.Store.StorePackageUpdate]]
  $rawUpdates = Await-Operation ($context.GetAppAndOptionalStorePackageUpdatesAsync()) $updateListType
  $updates = [System.Collections.Generic.List[Windows.Services.Store.StorePackageUpdate]]::new()
  foreach ($update in $rawUpdates) { [void]$updates.Add($update) }
  $canSilent = [bool]$context.CanSilentlyDownloadStorePackageUpdates
  if ($Mode -eq 'check') {
    Write-Result @{ ok = $true; mode = $Mode; hasUpdate = $updates.Count -gt 0; updateCount = $updates.Count; canSilent = $canSilent }
    exit 0
  }
  if ($updates.Count -eq 0) {
    Write-Result @{ ok = $true; mode = $Mode; hasUpdate = $false; updateCount = 0; overallState = 'NoUpdates'; canSilent = $canSilent }
    exit 0
  }
  if (-not $canSilent) {
    Write-Result @{ ok = $false; mode = $Mode; hasUpdate = $true; updateCount = $updates.Count; overallState = 'SilentConsentRequired'; canSilent = $false }
    exit 2
  }
  # The interactive Request* API requires an app UI thread and a valid window
  # handle. Navo intentionally runs this helper hidden, so use the Store's
  # background-safe silent API instead.
  $result = Await-ProgressOperation ($context.TrySilentDownloadAndInstallStorePackageUpdatesAsync($updates)) ([Windows.Services.Store.StorePackageUpdateResult]) ([Windows.Services.Store.StorePackageUpdateStatus])
  $states = @($result.StorePackageUpdateStatuses | ForEach-Object {
    @{ packageFamilyName = [string]$_.PackageFamilyName; state = [string]$_.PackageUpdateState; error = ('0x{0:X8}' -f $_.ErrorCode.HResult) }
  })
  $overallState = [string]$result.OverallState
  $ok = $overallState -eq 'Completed'
  Write-Result @{ ok = $ok; mode = $Mode; hasUpdate = $true; updateCount = $updates.Count; overallState = $overallState; statuses = $states; canSilent = $canSilent }
  if (-not $ok) { exit 2 }
} catch {
  Write-Result @{ ok = $false; mode = $Mode; error = $_.Exception.Message; hresult = ('0x{0:X8}' -f $_.Exception.HResult) }
  exit 1
}

param(
  [ValidateSet('check', 'install')]
  [string]$Mode = 'check',
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
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
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.IsGenericMethodDefinition -and
      $_.GetGenericArguments().Count -eq 2 -and
      $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  if (-not $method) { throw 'Windows Runtime progress task adapter is unavailable.' }
  $task = $method.MakeGenericMethod($ResultType, $ProgressType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $context = [Windows.Services.Store.StoreContext, Windows.Services.Store, ContentType = WindowsRuntime]::GetDefault()
  $updateListType = [System.Collections.Generic.IReadOnlyList[Windows.Services.Store.StorePackageUpdate]]
  $updates = @(Await-Operation ($context.GetAppAndOptionalStorePackageUpdatesAsync()) $updateListType)
  if ($Mode -eq 'check') {
    Write-Result @{ ok = $true; mode = $Mode; hasUpdate = $updates.Count -gt 0; updateCount = $updates.Count }
    exit 0
  }
  if ($updates.Count -eq 0) {
    Write-Result @{ ok = $true; mode = $Mode; hasUpdate = $false; updateCount = 0; overallState = 'NoUpdates' }
    exit 0
  }
  $result = Await-ProgressOperation ($context.RequestDownloadAndInstallStorePackageUpdatesAsync($updates)) ([Windows.Services.Store.StorePackageUpdateResult]) ([Windows.Services.Store.StorePackageUpdateStatus])
  $states = @($result.StorePackageUpdateStatuses | ForEach-Object {
    @{ packageFamilyName = [string]$_.PackageFamilyName; state = [string]$_.PackageUpdateState; error = ('0x{0:X8}' -f $_.ErrorCode.HResult) }
  })
  $overallState = [string]$result.OverallState
  $ok = $overallState -eq 'Completed'
  Write-Result @{ ok = $ok; mode = $Mode; hasUpdate = $true; updateCount = $updates.Count; overallState = $overallState; statuses = $states }
  if (-not $ok) { exit 2 }
} catch {
  Write-Result @{ ok = $false; mode = $Mode; error = $_.Exception.Message; hresult = ('0x{0:X8}' -f $_.Exception.HResult) }
  exit 1
}

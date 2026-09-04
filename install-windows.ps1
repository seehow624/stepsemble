#requires -Version 5.1
<##
Stepsemble one-click installer for Windows.

This is a per-user install: no administrator prompt is required. A logon
Scheduled Task keeps the local server available, while an optional hourly task
reruns this script to pick up a newer, checksum-verified GitHub release.
Node.js 22.19+ and the built-in tar command are required.
##>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$NoUpdates,
  [string]$Version = "",
  [string]$Source = ""
)

$ErrorActionPreference = "Stop"
$repo = if ($env:STEPSEMBLE_REPOSITORY) { $env:STEPSEMBLE_REPOSITORY } elseif ($env:PI_HARBOR_REPOSITORY) { $env:PI_HARBOR_REPOSITORY } elseif ($env:PI_WEB_REPOSITORY) { $env:PI_WEB_REPOSITORY } else { "seehow624/stepsemble" }
$installDir = Join-Path $HOME ".local\share\stepsemble"
$binDir = Join-Path $HOME ".local\share\stepsemble-bin"
$configDir = Join-Path $HOME ".config\stepsemble"
$tokenFile = Join-Path $configDir "token"
$stateDir = Join-Path $HOME ".local\state\stepsemble"
$taskName = "Stepsemble"
$updateTaskName = "Stepsemble updater"
$legacyTaskNames = @("Pi Harbor", "Pi Harbor updater", "Pi Web", "Pi Web updater")
if (-not $Version -and $env:STEPSEMBLE_VERSION) { $Version = $env:STEPSEMBLE_VERSION }
if (-not $Version -and $env:PI_HARBOR_VERSION) { $Version = $env:PI_HARBOR_VERSION }
if (-not $Version -and $env:PI_WEB_VERSION) { $Version = $env:PI_WEB_VERSION }
if (-not $Source -and $env:STEPSEMBLE_SOURCE_DIR) { $Source = $env:STEPSEMBLE_SOURCE_DIR }
if (-not $Source -and $env:PI_HARBOR_SOURCE_DIR) { $Source = $env:PI_HARBOR_SOURCE_DIR }
if (-not $Source -and $env:PI_WEB_SOURCE_DIR) { $Source = $env:PI_WEB_SOURCE_DIR }
if ($repo -eq "seehow624/pi-harbor") { $repo = "seehow624/stepsemble" }

function Fail([string]$Message) { throw "Stepsemble installer: $Message" }
function Require-Command([string]$Name) { if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "$Name is required" } }
function Test-SupportedNode {
  $parts = (& node -p "process.versions.node").Trim().Split('.') | ForEach-Object { [int]$_ }
  return ($parts[0] -gt 22 -or ($parts[0] -eq 22 -and ($parts[1] -gt 19 -or ($parts[1] -eq 19 -and $parts[2] -ge 0))))
}
function Test-ReleaseTag([string]$Tag) { return $Tag -match '^v\d+\.\d+\.\d+([-.][A-Za-z0-9.]+)?$' }
function Get-Release([string]$Requested) {
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'stepsemble-installer' }
  $uri = if ($Requested) { "https://api.github.com/repos/$repo/releases/tags/$Requested" } else { "https://api.github.com/repos/$repo/releases/latest" }
  try { $release = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 180 } catch {
    $page = if ($Requested) { "https://github.com/$repo/releases/tag/$Requested" } else { "https://github.com/$repo/releases/latest" }
    $response = Invoke-WebRequest -Uri $page -MaximumRedirection 10 -MaximumRetryCount 2 -TimeoutSec 60
    $tag = $response.BaseResponse.ResponseUri.Segments[-1].TrimEnd('/')
    if (-not (Test-ReleaseTag $tag)) { Fail "could not read GitHub release metadata" }
    return [pscustomobject]@{ tag_name = $tag; archive = "https://github.com/$repo/releases/download/$tag/stepsemble-$tag.tar.gz"; checksum = "https://github.com/$repo/releases/download/$tag/stepsemble-$tag.tar.gz.sha256" }
  }
  $tag = [string]$release.tag_name
  $archive = $release.assets | Where-Object { $_.name -eq "stepsemble-$tag.tar.gz" } | Select-Object -First 1
  $checksum = $release.assets | Where-Object { $_.name -eq "stepsemble-$tag.tar.gz.sha256" } | Select-Object -First 1
  if (-not $archive -or -not $checksum) { Fail "release assets are incomplete" }
  return [pscustomobject]@{ tag_name = $tag; archive = $archive.browser_download_url; checksum = $checksum.browser_download_url }
}
function Get-PackageVersion([string]$Dir) {
  $package = Join-Path $Dir 'package.json'
  if (-not (Test-Path $package)) { return "" }
  try { return "v$((Get-Content -Raw $package | ConvertFrom-Json).version)" } catch { return "" }
}
function Test-ReleaseNewer([string]$Current, [string]$Latest) {
  if (-not $Current) { return $true }
  $script = 'function p($v){$m=[regex]::Match($v,"^v?(\d+)\.(\d+)\.(\d+)(?:[-.]([A-Za-z0-9.-]+))?$" ); if(!$m.Success){return $null}; return @([int]$m.Groups[1].Value,[int]$m.Groups[2].Value,[int]$m.Groups[3].Value,[string]$m.Groups[4].Value)}; $a=p $args[0];$b=p $args[1];if(!$b){exit 1};if(!$a){exit 0};for($i=0;$i -lt 3;$i++){if($a[$i] -ne $b[$i]){exit [int]($b[$i] -gt $a[$i])}};exit [int](!$b[3] -and $a[3])'
  & powershell -NoProfile -Command $script $Current $Latest
  return ($LASTEXITCODE -eq 0)
}
function Test-ArchiveSafe([string]$Archive) {
  $names = @(& tar.exe -tzf $Archive | Where-Object { $_ -ne '' })
  if ($LASTEXITCODE -ne 0) { return $false }
  $details = @(& tar.exe -tvzf $Archive | Where-Object { $_ -ne '' })
  if ($LASTEXITCODE -ne 0 -or $names.Count -eq 0 -or $names.Count -ne $details.Count -or $names.Count -gt 4096) { return $false }
  $top = $null; $topDirectory = $false; $seen = [System.Collections.Generic.HashSet[string]]::new()
  for ($index = 0; $index -lt $names.Count; $index++) {
    $raw = [string]$names[$index]; $type = ([string]$details[$index]).Trim().Substring(0, 1)
    if ($type -ne 'd' -and $type -ne '-') { return $false }
    if (-not $raw -or $raw.Contains('\') -or $raw.StartsWith('/') -or $raw -match '^[A-Za-z]:[\\/]') { return $false }
    $parts = @($raw -split '/' | Where-Object { $_ -and $_ -ne '.' })
    if ($parts.Count -eq 0 -or $parts -contains '..') { return $false }
    $normalized = $parts -join '/'; $entryTop = [string]$parts[0]
    if ($entryTop -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { return $false }
    if (-not $top) { $top = $entryTop }
    if ($entryTop -ne $top -or ($normalized -ne $top -and -not $normalized.StartsWith("$top/"))) { return $false }
    if (-not $seen.Add($normalized)) { return $false }
    if ($normalized -eq $top) {
      if ($type -ne 'd') { return $false }
      $topDirectory = $true
    }
  }
  return [bool]$top -and $topDirectory
}
function Test-RegularFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function Copy-LegacyPrivateState {
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $privateFiles = @("token", "tokens.json", "onboarding.json", "device-trust.json", "updater.json", "update-state.json", "push.json", "push-subscriptions.json", "provider-cookies.json", "agent-tasks.json")
  foreach ($legacyName in @("pi-harbor", "pi-web")) {
    $legacyDir = Join-Path (Join-Path $HOME ".config") $legacyName
    if (-not (Test-Path -LiteralPath $legacyDir -PathType Container)) { continue }
    $legacyItem = Get-Item -LiteralPath $legacyDir -Force
    if (($legacyItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    foreach ($fileName in $privateFiles) {
      $sourceFile = Join-Path $legacyDir $fileName
      $targetFile = Join-Path $configDir $fileName
      if ((Test-RegularFile $sourceFile) -and -not (Test-Path -LiteralPath $targetFile)) {
        Copy-Item -LiteralPath $sourceFile -Destination $targetFile
      }
    }
    $legacyTasks = Join-Path $legacyDir "agent-tasks"
    if (Test-Path -LiteralPath $legacyTasks -PathType Container) {
      $legacyTasksItem = Get-Item -LiteralPath $legacyTasks -Force
      if (($legacyTasksItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        $newTasks = Join-Path $configDir "agent-tasks"
        if (Test-Path -LiteralPath $newTasks) {
          $newTasksItem = Get-Item -LiteralPath $newTasks -Force
          if (($newTasksItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "refusing a linked Stepsemble task-state directory" }
        }
        New-Item -ItemType Directory -Force -Path $newTasks | Out-Null
        foreach ($taskFile in Get-ChildItem -LiteralPath $legacyTasks -File -Filter "*.json") {
          if (($taskFile.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
          $targetTask = Join-Path $newTasks $taskFile.Name
          if (-not (Test-Path -LiteralPath $targetTask)) { Copy-Item -LiteralPath $taskFile.FullName -Destination $targetTask }
        }
      }
    }
  }
}
function Get-ConfiguredPort {
  $deviceFile = Join-Path $HOME ".pi\agent\device.json"
  try {
    $port = [int]((Get-Content -Raw -LiteralPath $deviceFile | ConvertFrom-Json).port)
    if ($port -ge 1024 -and $port -le 65535) { return $port }
  } catch {}
  return 3140
}
function Get-StepsembleHeaders {
  if (-not (Test-RegularFile $tokenFile)) { return $null }
  $token = (Get-Content -Raw -LiteralPath $tokenFile).Trim()
  if (-not $token) { return $null }
  $encoded = [Uri]::EscapeDataString($token)
  return @{ Cookie = "stepsemble=$encoded; pi_harbor=$encoded; pi_web=$encoded" }
}
function Get-ActiveWorkState([int]$Port) {
  $headers = Get-StepsembleHeaders
  if (-not $headers) { return "unknown" }
  try {
    $rpcs = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/rpcs" -Headers $headers -TimeoutSec 3
    if ($null -eq $rpcs.rpcs) { return "unknown" }
    if (@($rpcs.rpcs | Where-Object { $_.isStreaming -eq $true }).Count -gt 0) { return "active" }
    try { $tasks = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/agent-tasks" -Headers $headers -TimeoutSec 3 }
    catch {
      $taskError = $_
      $taskStatus = 0
      try { $taskStatus = [int]$taskError.Exception.Response.StatusCode } catch {}
      if ($taskStatus -ne 404) { return "unknown" }
      $tasks = $null
    }
    $terminal = @("completed", "failed", "stopped", "orphaned", "detached")
    if ($tasks -and @($tasks.tasks | Where-Object { $terminal -notcontains ([string]$_.status) }).Count -gt 0) { return "active" }
    return "idle"
  } catch { return "unknown" }
}
function Wait-ReleaseHealth([int]$Port, [string]$Expected) {
  $expectedVersion = $Expected.TrimStart('v')
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
      if ($health.ok -eq $true -and ([string]$health.appVersion).TrimStart('v') -eq $expectedVersion) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}
function Archive-LegacyProducts {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $destination = Join-Path (Join-Path $stateDir "legacy-products") $stamp
  foreach ($legacyName in @("pi-harbor", "pi-web")) {
    $legacyPath = Join-Path (Join-Path $HOME ".local\share") $legacyName
    if (-not (Test-Path -LiteralPath $legacyPath)) { continue }
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Move-Item -LiteralPath $legacyPath -Destination (Join-Path $destination $legacyName)
  }
}

if ($env:OS -ne 'Windows_NT') { Fail 'run this installer on Windows' }
Require-Command node; Require-Command curl.exe; Require-Command tar.exe
if (-not (Test-SupportedNode)) { Fail 'Node.js 22.19 or newer is required' }
if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Fail 'invalid GitHub repository' }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("stepsemble-windows-{0}" -f ([guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $sourceRoot = $Source
  if ($sourceRoot) {
    $sourceRoot = (Resolve-Path $sourceRoot).Path
    if (-not (Test-Path (Join-Path $sourceRoot 'server.js'))) { Fail 'local source is not a Stepsemble checkout' }
    $latest = Get-PackageVersion $sourceRoot
  } else {
    $release = Get-Release $Version
    $latest = [string]$release.tag_name
    if (-not (Test-ReleaseTag $latest)) { Fail 'release tag is invalid' }
    $current = Get-PackageVersion $installDir
    if ($current -and -not (Test-ReleaseNewer $current $latest)) { Write-Output "Stepsemble $current is already up to date"; exit 0 }
    $archive = Join-Path $temporary 'stepsemble.tar.gz'; $checksum = Join-Path $temporary 'stepsemble.tar.gz.sha256'
    Invoke-WebRequest -Uri $release.archive -OutFile $archive -TimeoutSec 300
    Invoke-WebRequest -Uri $release.checksum -OutFile $checksum -TimeoutSec 180
    $expected = ((Get-Content -Raw $checksum).Trim() -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$' -or $expected -ne $actual) { Fail 'release checksum verification failed' }
    if (-not (Test-ArchiveSafe $archive)) { Fail 'release archive failed safety preflight' }
    $extract = Join-Path $temporary 'extract'; New-Item -ItemType Directory -Path $extract | Out-Null
    & tar.exe -xzf $archive -C $extract
    if ($LASTEXITCODE -ne 0) { Fail 'release extraction failed' }
    $sourceRoot = Get-ChildItem -Directory $extract | Select-Object -First 1 -ExpandProperty FullName
    if (-not $sourceRoot -or -not (Test-Path (Join-Path $sourceRoot 'server.js'))) { Fail 'release archive is incomplete' }
  }

  if (Test-Path -LiteralPath $configDir) {
    $configItem = Get-Item -LiteralPath $configDir -Force
    if (($configItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "refusing a linked Stepsemble config directory" }
  }
  if ((Test-Path -LiteralPath $tokenFile) -and -not (Test-RegularFile $tokenFile)) { Fail "refusing a linked or non-file Stepsemble token path" }
  New-Item -ItemType Directory -Force -Path $configDir, $binDir, $stateDir | Out-Null
  Copy-LegacyPrivateState
  if (-not (Test-RegularFile $tokenFile)) {
    $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [IO.File]::WriteAllText($tokenFile, (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') + "`n")
  }
  $port = Get-ConfiguredPort
  $serviceIsRunning = $false
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
    $serviceIsRunning = ($health.ok -eq $true)
  } catch {}
  if ($serviceIsRunning) {
    $workState = Get-ActiveWorkState $port
    if ($workState -eq "active") { Fail "an agent is working or waiting for input; finish it before updating" }
    if ($workState -ne "idle") { Fail "could not safely inspect the running service; verify its token and try again" }
  }

  $stage = "$installDir.update.$PID"; $backup = "$installDir.previous"
  if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -Recurse -Force (Join-Path $sourceRoot '*') $stage

  $taskBackups = @{}
  $taskWasRunning = @{}
  foreach ($name in @($taskName, $updateTaskName) + $legacyTaskNames) {
    $existingTask = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $existingTask) { continue }
    $taskBackups[$name] = Export-ScheduledTask -TaskName $name
    $taskWasRunning[$name] = ($existingTask.State -eq 'Running')
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  }

  $activated = $false
  try {
    if (Test-Path $installDir) { Move-Item $installDir $backup }
    Move-Item $stage $installDir
    $activated = $true
    $node = (Get-Command node).Source
    $action = New-ScheduledTaskAction -Execute $node -Argument "`"$installDir\server.js`"" -WorkingDirectory $installDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'Stepsemble local Agent Hub' -Force | Out-Null
    Start-ScheduledTask -TaskName $taskName
    if (-not $NoUpdates) {
      $updateAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$installDir\install-windows.ps1`" -Yes"
      $updateTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(15)) -RepetitionInterval (New-TimeSpan -Hours 1)
      Register-ScheduledTask -TaskName $updateTaskName -Action $updateAction -Trigger $updateTrigger -Description 'Stepsemble hourly release check' -Force | Out-Null
    } else {
      Unregister-ScheduledTask -TaskName $updateTaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    if (-not (Wait-ReleaseHealth $port $latest)) { Fail 'the service did not become healthy' }
  } catch {
    $failure = $_
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $updateTaskName -Confirm:$false -ErrorAction SilentlyContinue
    if ($activated -and (Test-Path $installDir)) { Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue }
    if (Test-Path $backup) { Move-Item $backup $installDir }
    foreach ($name in $taskBackups.Keys) {
      Register-ScheduledTask -TaskName $name -Xml $taskBackups[$name] -Force | Out-Null
      if ($taskWasRunning[$name]) { Start-ScheduledTask -TaskName $name }
    }
    throw $failure
  }
  if (@($legacyTaskNames | Where-Object { $taskBackups.ContainsKey($_) }).Count -gt 0) {
    $taskArchive = Join-Path (Join-Path $stateDir "legacy-scheduled-tasks") (Get-Date -Format "yyyyMMdd-HHmmss")
    New-Item -ItemType Directory -Force -Path $taskArchive | Out-Null
    foreach ($name in $legacyTaskNames) {
      if ($taskBackups.ContainsKey($name)) { [IO.File]::WriteAllText((Join-Path $taskArchive "$($name.Replace(' ', '-')).xml"), [string]$taskBackups[$name]) }
    }
  }
  Archive-LegacyProducts
  Write-Output "Stepsemble $latest is installed."
  Write-Output "Token: $tokenFile"
  Write-Output "Service: Get-ScheduledTask -TaskName '$taskName'"
} finally {
  if (Test-Path $temporary) { Remove-Item -Recurse -Force $temporary }
}

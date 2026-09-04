#requires -Version 5.1
<##
Pi Harbor one-click installer for Windows.

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
$repo = if ($env:PI_HARBOR_REPOSITORY) { $env:PI_HARBOR_REPOSITORY } else { "seehow624/pi-harbor" }
$installDir = Join-Path $HOME ".local\share\pi-harbor"
$binDir = Join-Path $HOME ".local\share\pi-harbor-bin"
$configDir = Join-Path $HOME ".config\pi-harbor"
$tokenFile = Join-Path $configDir "token"
$taskName = "Pi Harbor"
$updateTaskName = "Pi Harbor updater"

function Fail([string]$Message) { throw "Pi Harbor installer: $Message" }
function Require-Command([string]$Name) { if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { Fail "$Name is required" } }
function Test-SupportedNode {
  $parts = (& node -p "process.versions.node").Trim().Split('.') | ForEach-Object { [int]$_ }
  return ($parts[0] -gt 22 -or ($parts[0] -eq 22 -and ($parts[1] -gt 19 -or ($parts[1] -eq 19 -and $parts[2] -ge 0))))
}
function Test-ReleaseTag([string]$Tag) { return $Tag -match '^v\d+\.\d+\.\d+([-.][A-Za-z0-9.]+)?$' }
function Get-Release([string]$Requested) {
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'pi-harbor-installer' }
  $uri = if ($Requested) { "https://api.github.com/repos/$repo/releases/tags/$Requested" } else { "https://api.github.com/repos/$repo/releases/latest" }
  try { $release = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 180 } catch {
    $page = if ($Requested) { "https://github.com/$repo/releases/tag/$Requested" } else { "https://github.com/$repo/releases/latest" }
    $response = Invoke-WebRequest -Uri $page -MaximumRedirection 10 -MaximumRetryCount 2 -TimeoutSec 60
    $tag = $response.BaseResponse.ResponseUri.Segments[-1].TrimEnd('/')
    if (-not (Test-ReleaseTag $tag)) { Fail "could not read GitHub release metadata" }
    return [pscustomobject]@{ tag_name = $tag; archive = "https://github.com/$repo/releases/download/$tag/pi-harbor-$tag.tar.gz"; checksum = "https://github.com/$repo/releases/download/$tag/pi-harbor-$tag.tar.gz.sha256" }
  }
  $tag = [string]$release.tag_name
  $archive = $release.assets | Where-Object { $_.name -eq "pi-harbor-$tag.tar.gz" } | Select-Object -First 1
  $checksum = $release.assets | Where-Object { $_.name -eq "pi-harbor-$tag.tar.gz.sha256" } | Select-Object -First 1
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

if ($env:OS -ne 'Windows_NT') { Fail 'run this installer on Windows' }
Require-Command node; Require-Command curl.exe; Require-Command tar.exe
if (-not (Test-SupportedNode)) { Fail 'Node.js 22.19 or newer is required' }
if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Fail 'invalid GitHub repository' }

$temporary = Join-Path ([IO.Path]::GetTempPath()) ("pi-harbor-windows-{0}" -f ([guid]::NewGuid().ToString('N')))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
  $sourceRoot = $Source
  if ($sourceRoot) {
    $sourceRoot = (Resolve-Path $sourceRoot).Path
    if (-not (Test-Path (Join-Path $sourceRoot 'server.js'))) { Fail 'local source is not a Pi Harbor checkout' }
    $latest = Get-PackageVersion $sourceRoot
  } else {
    $release = Get-Release $Version
    $latest = [string]$release.tag_name
    if (-not (Test-ReleaseTag $latest)) { Fail 'release tag is invalid' }
    $current = Get-PackageVersion $installDir
    if ($current -and -not (Test-ReleaseNewer $current $latest)) { Write-Output "Pi Harbor $current is already up to date"; exit 0 }
    $archive = Join-Path $temporary 'pi-harbor.tar.gz'; $checksum = Join-Path $temporary 'pi-harbor.tar.gz.sha256'
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

  New-Item -ItemType Directory -Force -Path $configDir, $binDir | Out-Null
  $stage = "$installDir.update.$PID"; $backup = "$installDir.previous"
  if (Test-Path $backup) { Remove-Item -Recurse -Force $backup }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -Recurse -Force (Join-Path $sourceRoot '*') $stage
  if (Test-Path $installDir) { Move-Item $installDir $backup }
  try { Move-Item $stage $installDir } catch { if (Test-Path $backup) { Move-Item $backup $installDir }; Fail 'could not activate the release' }

  if (-not (Test-Path $tokenFile)) {
    $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [IO.File]::WriteAllText($tokenFile, (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') + "`n")
  }
  $node = (Get-Command node).Source
  $action = New-ScheduledTaskAction -Execute $node -Argument "`"$installDir\server.js`"" -WorkingDirectory $installDir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description 'Pi Harbor local Agent Hub' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  if (-not $NoUpdates) {
    $updateAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$installDir\install-windows.ps1`" -Yes"
    $updateTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(15)) -RepetitionInterval (New-TimeSpan -Hours 1)
    Register-ScheduledTask -TaskName $updateTaskName -Action $updateAction -Trigger $updateTrigger -Description 'Pi Harbor hourly release check' -Force | Out-Null
  } else {
    Unregister-ScheduledTask -TaskName $updateTaskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  Write-Output "Pi Harbor $latest is installed."
  Write-Output "Token: $tokenFile"
  Write-Output "Service: Get-ScheduledTask -TaskName '$taskName'"
} finally {
  if (Test-Path $temporary) { Remove-Item -Recurse -Force $temporary }
}

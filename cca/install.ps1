param(
  [switch]$Uninstall,
  [ValidateSet('node', 'bun')][string]$Runtime
)

$ErrorActionPreference = 'Stop'

$owner = if ($env:CCTK_OWNER) { $env:CCTK_OWNER } else { 'kostenuksoft' }
$repo = if ($env:CCTK_REPO) { $env:CCTK_REPO } else { 'cctk' }
$ref = if ($env:CCTK_REF) { $env:CCTK_REF } else { 'master' }
$cctkHome = if ($env:CCTK_HOME) { $env:CCTK_HOME } else { Join-Path $env:LOCALAPPDATA 'cctk' }

$bin = Join-Path $env:LOCALAPPDATA 'cca'
$shim = Join-Path $bin 'cca.cmd'

function Have($name) {
  return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function NodeOk {
  if (-not (Have node)) { return $false }
  $parts = (node -p 'process.versions.node').Split('.')
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  return ($major -gt 23) -or ($major -eq 23 -and $minor -ge 6)
}

function In-UserPath($target) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $current) { return $false }
  return @($current -split ';' | Where-Object { $_ -ieq $target }).Count -gt 0
}

if ($Uninstall) {
  if (Test-Path $shim) {
    Remove-Item $shim
    Write-Host "removed $shim"
  }
  else {
    Write-Host "no cca shim at $shim"
  }
  if (In-UserPath $bin) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($current -split ';' | Where-Object { $_ -ne '' -and $_ -ine $bin })
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    Write-Host 'removed from user PATH (restart terminals)'
  }
  Write-Host "note: fetched source (if any) left at $cctkHome"
  return
}

$selfDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }

if ($selfDir -and (Test-Path (Join-Path $selfDir 'cca.ts'))) {
  $src = $selfDir
  Write-Host "using local checkout: $src"
}
else {
  Write-Host "fetching $owner/$repo@$ref"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('cctk-' + [Guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'src.zip'
  Invoke-WebRequest -Uri "https://codeload.github.com/$owner/$repo/zip/refs/heads/$ref" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $extracted = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
  New-Item -ItemType Directory -Force -Path $cctkHome | Out-Null
  Copy-Item -Path (Join-Path $extracted.FullName '*') -Destination $cctkHome -Recurse -Force
  Remove-Item -Recurse -Force $tmp
  $src = Join-Path $cctkHome 'cca'
  if (-not (Test-Path (Join-Path $src 'cca.ts'))) {
    throw "download did not contain cca/cca.ts - is the repo public and CCTK_REF=$ref correct?"
  }
  Write-Host "fetched into $cctkHome"
}

if (-not $Runtime) {
  if (NodeOk) { $Runtime = 'node' }
  elseif (Have bun) { $Runtime = 'bun' }
  elseif (Have node) { throw "node $(node -p 'process.versions.node') cannot run TypeScript without a flag; use node >= 23.6 or install bun" }
  else { throw 'need node (>=23.6) or bun on PATH' }
}

if (-not (Have $Runtime)) { throw "$Runtime not found on PATH" }

if ($Runtime -eq 'node') {
  $ver = (node -p 'process.versions.node')
  $parts = $ver.Split('.')
  $major = [int]$parts[0]
  $minor = [int]$parts[1]
  if ($major -lt 23 -or ($major -eq 23 -and $minor -lt 6)) {
    throw "node $ver cannot run TypeScript without a flag; use node >= 23.6 or run with -Runtime bun"
  }
}

$runtimeBin = (Get-Command $Runtime).Source
$entry = Join-Path $src 'cca.ts'
New-Item -ItemType Directory -Force -Path $bin | Out-Null
Set-Content -Path $shim -Value "@echo off`r`n`"$runtimeBin`" `"$entry`" %*"
Write-Host "installed cca ($Runtime) -> $shim"

if (-not (In-UserPath $bin)) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $current) { $current = '' }
  $parts = @($current -split ';' | Where-Object { $_ -ne '' })
  $parts += $bin
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
  Write-Host 'added to user PATH (restart terminals to pick it up)'
}

param(
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$owner = if ($env:CCTK_OWNER) { $env:CCTK_OWNER } else { 'kostenuksoft' }
$repo = if ($env:CCTK_REPO) { $env:CCTK_REPO } else { 'cctk' }
$ref = if ($env:CCTK_REF) { $env:CCTK_REF } else { 'master' }
$cctkHome = if ($env:CCTK_HOME) { $env:CCTK_HOME } else { Join-Path $env:LOCALAPPDATA 'cctk' }

$cfgDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$dest = Join-Path $cfgDir 'statusline.py'
$settings = Join-Path $cfgDir 'settings.json'

function Have($name) {
  return $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

$py = if (Have python) { 'python' } elseif (Have python3) { 'python3' } else { throw 'need python on PATH' }

$edit = @'
import json, os, shutil, sys, time
path, cmd, remove = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
data = {}
if os.path.exists(path):
    shutil.copy(path, path + ".bak-" + time.strftime("%Y%m%d%H%M%S"))
    try:
        data = json.load(open(path))
    except ValueError as e:
        print("existing settings.json is not valid JSON:", e); sys.exit(1)
if remove:
    if data.pop("statusLine", None) is None:
        print("no statusLine key in", path); sys.exit(0)
    with open(path, "w") as f:
        json.dump(data, f, indent=2); f.write("\n")
    print("removed statusLine from", path); sys.exit(0)
current = data.get("statusLine")
merged = dict(current) if isinstance(current, dict) else {}
merged["type"] = "command"
merged["command"] = cmd
if current == merged:
    print("statusLine already points here - no change")
else:
    data["statusLine"] = merged
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2); f.write("\n")
    print("wired statusLine ->", cmd)
'@

if ($Uninstall) {
  $edit | & $py - $settings '' '1'
  if (Test-Path $dest) { Remove-Item $dest; Write-Host "removed $dest" }
  return
}

$selfDir = if ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }

if ($selfDir -and (Test-Path (Join-Path $selfDir 'statusline.py'))) {
  $src = Join-Path $selfDir 'statusline.py'
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
  $src = Join-Path $cctkHome 'statusline\statusline.py'
  if (-not (Test-Path $src)) {
    throw "download did not contain statusline\statusline.py - is the repo public and CCTK_REF=$ref correct?"
  }
}

New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
if ($src -ne $dest) { Copy-Item -Path $src -Destination $dest -Force }
Write-Host "installed statusline -> $dest"

$destCmd = $dest -replace '\\', '/'
$edit | & $py - $settings "$py `"$destCmd`"" '0'
Write-Host 'done - open a new Claude Code session to see it.'

# bootstrap.ps1 - one-liner installer for AI Workflow (Windows).
#
#   irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1 | iex
#
# To pass flags through to setup (irm|iex cannot take args), fetch then invoke with args:
#   $b = irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1
#   & ([scriptblock]::Create($b)) -Yes
#   & ([scriptblock]::Create($b)) -Mode yolo
#   & ([scriptblock]::Create($b)) -Flow cursor
#   & ([scriptblock]::Create($b)) -Target C:\proj
#   & ([scriptblock]::Create($b)) -WhatIf
#   & ([scriptblock]::Create($b)) -Help
#
# Lifecycle (AD-bootstrap-download-delete):
#   1) Resolve release pin from $env:AIWF_RELEASE (empty|latest|tag|https zip URL)
#   2) Download aiworkflow-install.zip + neighbor .sha256 over HTTPS (GitHub host allowlist)
#   3) Verify SHA-256 of the zip BEFORE extract / stamp; on fail retain partial + print path
#   4) Extract to a temp install cache (not flavor dest, not ~/.config/aiwf, not ~/.aiworkflow)
#   5) Run node tools/aiwf.ts setup from that cache with forwarded flags
#   6) On setup success ONLY: delete zip + extracted cache tree
#   7) On failure: retain cache and print its path
# Existing ~/.aiworkflow is NEVER deleted (may be a developer working copy).
# No git clone as install runtime root.
#
# Live flavors: omp|opencode|cursor|dsh|all (no claude/codex/both).
# Modes: full|key|soft|yolo (-Yes => yolo).
#
# ASCII-only (PS 5.1 parses .ps1 as cp1251 without a BOM).
param(
    [switch]$Yes,
    [switch]$SkipSmoke,
    [ValidateSet('omp','opencode','cursor','dsh','all')]
    [string]$Flow = 'all',
    [string]$Target = '',
    [switch]$KeepAgents,
    [ValidateSet('full','key','soft','yolo')]
    [string]$Mode = '',
    [switch]$Check,
    [switch]$WhatIf,
    [Alias('h')]
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

$OwnerRepo = 'ZhevlakovII/aiworkflow'
$ZipName   = 'aiworkflow-install.zip'
$ShaName   = 'aiworkflow-install.zip.sha256'
$AllowedHosts = @(
    'github.com',
    'release-assets.githubusercontent.com',
    'objects.githubusercontent.com',
    'github-releases.githubusercontent.com'
)

function Show-Help {
    @"
bootstrap.ps1 - download + verify + setup AI Workflow (Windows)

Usage:
  bootstrap.ps1 [-Yes] [-Mode full|key|soft|yolo] [-SkipSmoke] [-Flow <flow>]
                [-Target <dir>] [-KeepAgents] [-Check] [-WhatIf] [-Help]

Flow (live flavors only):
  omp | opencode | cursor | dsh | all
  default: all
  (claude / codex / both retired from installer UX)

Flags are forwarded to: node tools/aiwf.ts setup (from extracted install cache).
-Yes maps to --mode yolo.

Release pin via env AIWF_RELEASE:
  (empty) | latest     latest GitHub Release assets
  <tag>                release tag assets (no URL scheme)
  https://.../aiworkflow-install.zip
                       HTTPS zip URL; host must be GitHub allowlist;
                       SHA from neighbor .sha256 asset (same release)

Lifecycle:
  download zip+sha256 -> verify SHA-256 -> extract cache -> node setup from cache
  -> delete cache only on success; on failure retain + print path
  Does not delete existing ~/.aiworkflow. No git-clone install root.

-WhatIf: print resolved URLs and cache plan; do not download or stamp.
"@ | Write-Host
}

if ($Help) {
    Show-Help
    exit 0
}

function Test-AllowedHost([string]$HostName) {
    foreach ($h in $AllowedHosts) {
        if ($HostName -eq $h) { return $true }
    }
    return $false
}

function Get-Sha256FileLower([string]$Path) {
    $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return $hash.Hash.ToLowerInvariant()
}

function Get-PublishedSum([string]$ShaPath) {
    $line = (Get-Content -LiteralPath $ShaPath -TotalCount 1).Trim()
    if ($line -match '^([a-fA-F0-9]{64})') { return $Matches[1].ToLowerInvariant() }
    throw "cannot parse sha256 file: $ShaPath"
}

function Download-File([string]$Url, [string]$OutPath) {
    $uri = [Uri]$Url
    if ($uri.Scheme -ne 'https') { throw "refusing non-HTTPS URL: $Url" }
    if (-not (Test-AllowedHost $uri.Host)) { throw "host not allowlisted: $($uri.Host)" }
    Invoke-WebRequest -Uri $Url -OutFile $OutPath -UseBasicParsing
}

function Resolve-ReleaseAssets {
    $pin = if ($env:AIWF_RELEASE) { $env:AIWF_RELEASE.Trim() } else { '' }
    if ($pin -eq '' -or $pin -eq 'latest') {
        $api = "https://api.github.com/repos/$OwnerRepo/releases/latest"
        $rel = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'aiworkflow-bootstrap' }
        $zipAsset = $rel.assets | Where-Object { $_.name -eq $ZipName } | Select-Object -First 1
        $shaAsset = $rel.assets | Where-Object { $_.name -eq $ShaName } | Select-Object -First 1
        if (-not $zipAsset -or -not $shaAsset) { throw "latest release missing $ZipName / $ShaName" }
        return @{ ZipUrl = $zipAsset.browser_download_url; ShaUrl = $shaAsset.browser_download_url; Label = $rel.tag_name }
    }
    if ($pin -match '^https://') {
        $zipUrl = $pin
        $shaUrl = if ($pin -match '\.zip$') { $pin + '.sha256' } else { $pin + '.sha256' }
        return @{ ZipUrl = $zipUrl; ShaUrl = $shaUrl; Label = 'pin-url' }
    }
    $tag = $pin
    $api = "https://api.github.com/repos/$OwnerRepo/releases/tags/$tag"
    $rel = Invoke-RestMethod -Uri $api -Headers @{ 'User-Agent' = 'aiworkflow-bootstrap' }
    $zipAsset = $rel.assets | Where-Object { $_.name -eq $ZipName } | Select-Object -First 1
    $shaAsset = $rel.assets | Where-Object { $_.name -eq $ShaName } | Select-Object -First 1
    if (-not $zipAsset -or -not $shaAsset) { throw "release $tag missing $ZipName / $ShaName" }
    return @{ ZipUrl = $zipAsset.browser_download_url; ShaUrl = $shaAsset.browser_download_url; Label = $tag }
}

function Find-PayloadRoot([string]$ExtractDir) {
    $marker = Join-Path $ExtractDir 'tools\aiwf.ts'
    if (Test-Path -LiteralPath $marker) { return $ExtractDir }
    foreach ($d in Get-ChildItem -LiteralPath $ExtractDir -Directory -ErrorAction SilentlyContinue) {
        $m = Join-Path $d.FullName 'tools\aiwf.ts'
        if (Test-Path -LiteralPath $m) { return $d.FullName }
    }
    $legacy = Join-Path $ExtractDir 'tools\setup.ps1'
    if (Test-Path -LiteralPath $legacy) { return $ExtractDir }
    throw "extracted zip has no tools/aiwf.ts under $ExtractDir"
}

$cacheRoot = Join-Path $env:TEMP 'aiwf-bootstrap'
$cacheDir = Join-Path $cacheRoot ([guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $cacheDir $ZipName
$shaPath = Join-Path $cacheDir $ShaName
$extractDir = Join-Path $cacheDir 'extract'
$stampOk = $false

Write-Host "== AI Workflow bootstrap ==" -ForegroundColor Cyan
try {
    $rel = Resolve-ReleaseAssets
    Write-Host ("release: {0}" -f $rel.Label)
    Write-Host ("zip:     {0}" -f $rel.ZipUrl)
    Write-Host ("sha:     {0}" -f $rel.ShaUrl)
    Write-Host ("cache:   {0}" -f $cacheDir)

    if ($WhatIf) {
        Write-Host "WhatIf: would download, verify, extract, then: node tools/aiwf.ts setup ..." -ForegroundColor Yellow
        exit 0
    }

    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    Write-Host "== downloading install assets ==" -ForegroundColor Cyan
    Download-File $rel.ZipUrl $zipPath
    Download-File $rel.ShaUrl $shaPath

    Write-Host "== verifying SHA-256 ==" -ForegroundColor Cyan
    $expected = Get-PublishedSum $shaPath
    $actual = Get-Sha256FileLower $zipPath
    if ($actual -ne $expected) {
        throw "SHA-256 mismatch: expected $expected, got $actual"
    }
    Write-Host "SHA-256 OK ($actual)"

    Write-Host "== extracting to cache ==" -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $payloadRoot = Find-PayloadRoot $extractDir
    $aiwfTs = Join-Path $payloadRoot 'tools\aiwf.ts'
    Write-Host "payload: $payloadRoot"

    Write-Host "== running node tools/aiwf.ts setup from cache ==" -ForegroundColor Cyan
    $nodeArgs = @($aiwfTs, 'setup')
    if ($Yes) { $nodeArgs += @('--mode', 'yolo') }
    elseif ($Mode) { $nodeArgs += @('--mode', $Mode) }
    if ($Check) { $nodeArgs += '--check' }
    if ($SkipSmoke) { $nodeArgs += '--skip-smoke' }
    if ($KeepAgents) { $nodeArgs += '--keep-agents' }
    if ($Flow) { $nodeArgs += @('--flow', $Flow) }
    if ($Target) { $nodeArgs += @('--target', $Target) }

    $global:LASTEXITCODE = 0
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "setup exited with code $LASTEXITCODE"
    }
    $stampOk = $true
}
catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
    Write-Host "setup/stamp failed; retained cache: $cacheDir" -ForegroundColor Yellow
    exit 1
}

if ($stampOk) {
    Write-Host "== stamp OK; deleting install cache ==" -ForegroundColor Cyan
    try {
        Remove-Item -LiteralPath $cacheDir -Recurse -Force -ErrorAction Stop
        Write-Host "cache removed: $cacheDir"
    } catch {
        Write-Host "WARN: could not fully delete cache at $cacheDir : $_" -ForegroundColor Yellow
    }
    Write-Host "bootstrap done (flow: $Flow)." -ForegroundColor Green
    exit 0
}

Write-Host "retained cache: $cacheDir" -ForegroundColor Yellow
exit 1

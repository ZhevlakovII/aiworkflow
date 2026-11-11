# bootstrap.ps1 - one-liner installer for AI Workflow (Windows).
#
#   irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1 | iex
#
# To pass flags through to setup (irm|iex cannot take args), fetch then invoke with args:
#   $b = irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1
#   & ([scriptblock]::Create($b)) -Yes
#   & ([scriptblock]::Create($b)) -Install node,git
#   & ([scriptblock]::Create($b)) -Flow claude            # only Claude Code (~/.claude)
#   & ([scriptblock]::Create($b)) -Flow cursor            # only Cursor (~/.cursor)
#   & ([scriptblock]::Create($b)) -Flow dsh               # only DSH plugin
#   & ([scriptblock]::Create($b)) -Target C:\proj         # project-scoped, selected flows
#   & ([scriptblock]::Create($b)) -WhatIf                 # resolve pin / print plan; no download
#   & ([scriptblock]::Create($b)) -Help
#
# Lifecycle (AD-bootstrap-download-delete):
#   1) Resolve release pin from $env:AIWF_RELEASE (empty|latest|tag|https zip URL)
#   2) Download aiworkflow-install.zip + neighbor .sha256 over HTTPS (GitHub host allowlist)
#   3) Verify SHA-256 of the zip BEFORE extract / stamp; on fail retain partial + print path
#   4) Extract to a temp install cache (not flavor dest, not ~/.config/aiwf, not ~/.aiworkflow)
#   5) Run tools/setup.ps1 from that cache with forwarded flags
#   6) On setup success ONLY: delete zip + extracted cache tree
#   7) On failure: retain cache and print its path
# Existing ~/.aiworkflow is NEVER deleted (may be a developer working copy).
# No git clone as install runtime root.
#
# Pin ($env:AIWF_RELEASE):
#   empty or "latest"  -> GitHub Releases latest assets
#   tag (no scheme)    -> same two assets for that release tag
#   https URL          -> zip URL; host allowlist only; SHA from same-release neighbor .sha256
#
# Flow set matches live setup: omp|claude|opencode|cursor|dsh|all|both
#   default all includes cursor + dsh; both = omp+claude+opencode (no cursor).
#
# ASCII-only (PS 5.1 parses .ps1 as cp1251 without a BOM).
param(
    [switch]$Yes,
    [switch]$SkipSmoke,
    [string[]]$Install = @(),
    [ValidateSet('omp','claude','opencode','cursor','dsh','all','both')]
    [string]$Flow = 'all',
    [string]$Target = '',
    [switch]$KeepAgents,
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
  bootstrap.ps1 [-Yes] [-SkipSmoke] [-Install <cmds>] [-Flow <flow>]
                [-Target <dir>] [-KeepAgents] [-WhatIf] [-Help]

Flow (parity with tools/setup.ps1):
  omp | claude | opencode | cursor | dsh | all | both
  default: all  (includes cursor and dsh)
  both = omp+claude+opencode only (no cursor)

Flags are forwarded to tools/setup.ps1 from the extracted install cache.

Release pin via env AIWF_RELEASE:
  (empty) | latest     latest GitHub Release assets
  <tag>                release tag assets (no URL scheme)
  https://.../aiworkflow-install.zip
                       HTTPS zip URL; host must be GitHub allowlist;
                       SHA from neighbor .sha256 asset (same release)

Lifecycle:
  download zip+sha256 -> verify SHA-256 -> extract cache -> setup from cache
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

function Get-NeighborShaUrl([string]$ZipUrl) {
    if ($ZipUrl -match '\.sha256(\?.*)?$') {
        throw "AIWF_RELEASE must point at $ZipName, not the .sha256 asset"
    }
    if ($ZipUrl -match '\?') {
        $base = $ZipUrl.Substring(0, $ZipUrl.IndexOf('?'))
        $qs = $ZipUrl.Substring($ZipUrl.IndexOf('?'))
        if ($base.EndsWith($ZipName)) { return ($base + '.sha256' + $qs) }
    } else {
        if ($ZipUrl.EndsWith($ZipName)) { return ($ZipUrl + '.sha256') }
    }
    throw "Pin URL path must name $ZipName (got: $ZipUrl)"
}

function Resolve-ReleaseUrls {
    $pin = if ($null -eq $env:AIWF_RELEASE) { '' } else { "$($env:AIWF_RELEASE)".Trim() }
    if ($pin -eq '' -or $pin -eq 'latest') {
        $base = "https://github.com/$OwnerRepo/releases/latest/download"
        return @{
            Mode    = 'latest'
            ZipUrl  = "$base/$ZipName"
            ShaUrl  = "$base/$ShaName"
            Label   = 'latest'
        }
    }
    if ($pin -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        if ($pin -notmatch '^https://') {
            throw "AIWF_RELEASE URL must be https (refused: $pin)"
        }
        try {
            $uri = [Uri]$pin
        } catch {
            throw "AIWF_RELEASE is not a valid URL: $pin"
        }
        if (-not (Test-AllowedHost $uri.Host)) {
            throw "AIWF_RELEASE host '$($uri.Host)' not in allowlist ($($AllowedHosts -join ', '))"
        }
        if ($uri.AbsolutePath -notmatch [regex]::Escape($ZipName)) {
            throw "AIWF_RELEASE path must name $ZipName (got: $($uri.AbsolutePath))"
        }
        return @{
            Mode    = 'url'
            ZipUrl  = $pin
            ShaUrl  = (Get-NeighborShaUrl $pin)
            Label   = $pin
        }
    }
    # tag pin (no scheme)
    if ($pin -match '[\s\\/]') {
        throw "AIWF_RELEASE tag looks invalid: $pin"
    }
    $base = "https://github.com/$OwnerRepo/releases/download/$pin"
    return @{
        Mode    = 'tag'
        ZipUrl  = "$base/$ZipName"
        ShaUrl  = "$base/$ShaName"
        Label   = "tag:$pin"
    }
}

function Get-CacheRoot {
    if ($env:LOCALAPPDATA) {
        return (Join-Path $env:LOCALAPPDATA 'aiwf-install')
    }
    if ($env:TEMP) {
        return (Join-Path $env:TEMP 'aiwf-install')
    }
    return (Join-Path $HOME '.cache/aiwf-install')
}

function Get-Sha256FileLower([string]$Path) {
    $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    return $hash.Hash.ToLowerInvariant()
}

function Get-PublishedSum([string]$ShaFile) {
    if (-not (Test-Path -LiteralPath $ShaFile)) {
        throw "missing sha256 sidecar: $ShaFile"
    }
    $raw = (Get-Content -LiteralPath $ShaFile -Raw -ErrorAction Stop)
    if ($null -eq $raw -or "$raw".Trim() -eq '') {
        throw "empty sha256 sidecar: $ShaFile"
    }
    $line = ("$raw".Trim() -split '\r?\n')[0].Trim()
    # formats: "<hex>" or "<hex>  filename" or "<hex> *filename"
    if ($line -match '^([0-9a-fA-F]{64})\b') {
        return $Matches[1].ToLowerInvariant()
    }
    throw "sha256 sidecar is not 64 hex: $ShaFile"
}

function Download-File([string]$Url, [string]$OutPath) {
    Write-Host "  GET $Url" -ForegroundColor DarkGray
    # -UseBasicParsing for PS 5.1; follow redirects (GitHub release assets)
    Invoke-WebRequest -Uri $Url -OutFile $OutPath -UseBasicParsing
    if (-not (Test-Path -LiteralPath $OutPath)) {
        throw "download produced no file: $OutPath"
    }
}

function Find-PayloadRoot([string]$ExtractDir) {
    $direct = Join-Path $ExtractDir 'tools\setup.ps1'
    if (Test-Path -LiteralPath $direct) { return $ExtractDir }
    $kids = @(Get-ChildItem -LiteralPath $ExtractDir -Directory -ErrorAction SilentlyContinue)
    foreach ($k in $kids) {
        $cand = Join-Path $k.FullName 'tools\setup.ps1'
        if (Test-Path -LiteralPath $cand) { return $k.FullName }
    }
    throw "extracted zip has no tools/setup.ps1 under $ExtractDir"
}

# --- resolve pin (always; safe) --------------------------------------------
try {
    $rel = Resolve-ReleaseUrls
} catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
    exit 2
}

$cacheRoot = Get-CacheRoot
$cacheId   = [guid]::NewGuid().ToString('N').Substring(0, 12)
$cacheDir  = Join-Path $cacheRoot $cacheId
$zipPath   = Join-Path $cacheDir $ZipName
$shaPath   = Join-Path $cacheDir $ShaName
$extractDir = Join-Path $cacheDir 'extract'

Write-Host "== AI Workflow bootstrap ==" -ForegroundColor Cyan
Write-Host "release: $($rel.Label)"
Write-Host "flow:    $Flow"
Write-Host "cache:   $cacheDir"
Write-Host "zip:     $($rel.ZipUrl)"
Write-Host "sha256:  $($rel.ShaUrl)"

if ($WhatIf) {
    Write-Host ""
    Write-Host "WhatIf: would download zip+sha256, verify SHA-256, extract to cache," -ForegroundColor Yellow
    Write-Host "        run tools/setup.ps1 -Flow $Flow (plus forwarded flags), then" -ForegroundColor Yellow
    Write-Host "        delete cache only on setup success; retain+print path on failure." -ForegroundColor Yellow
    Write-Host "        Existing ~/.aiworkflow is never deleted. No git clone." -ForegroundColor Yellow
    exit 0
}

# --- download into cache ---------------------------------------------------
New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
$stampOk = $false
try {
    Write-Host "== downloading install assets ==" -ForegroundColor Cyan
    try {
        Download-File $rel.ZipUrl $zipPath
        Download-File $rel.ShaUrl $shaPath
    } catch {
        Write-Host "ERROR: download failed: $_" -ForegroundColor Red
        Write-Host "retained cache (partial): $cacheDir" -ForegroundColor Yellow
        exit 1
    }

    # --- verify BEFORE extract ---------------------------------------------
    Write-Host "== verifying SHA-256 ==" -ForegroundColor Cyan
    try {
        $expected = Get-PublishedSum $shaPath
        $actual = Get-Sha256FileLower $zipPath
        if ($actual -ne $expected) {
            throw "SHA-256 mismatch: expected $expected, got $actual"
        }
        Write-Host "SHA-256 OK ($actual)"
    } catch {
        Write-Host "ERROR: $_" -ForegroundColor Red
        Write-Host "refusing extract/stamp; retained: $cacheDir" -ForegroundColor Yellow
        Write-Host "  zip: $zipPath" -ForegroundColor Yellow
        exit 1
    }

    # --- extract to cache only ---------------------------------------------
    Write-Host "== extracting to cache ==" -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $extractDir -Force | Out-Null
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractDir -Force
    $payloadRoot = Find-PayloadRoot $extractDir
    $setupPs1 = Join-Path $payloadRoot 'tools\setup.ps1'
    Write-Host "payload: $payloadRoot"

    # --- run setup from cache ----------------------------------------------
    Write-Host "== running tools/setup.ps1 from cache ==" -ForegroundColor Cyan
    $setupArgs = @()
    if ($Yes)             { $setupArgs += '-Yes' }
    if ($SkipSmoke)       { $setupArgs += '-SkipSmoke' }
    if ($Install.Count)   { $setupArgs += '-Install'; $setupArgs += ($Install -join ',') }
    if ($Flow)            { $setupArgs += '-Flow'; $setupArgs += $Flow }
    if ($Target)          { $setupArgs += '-Target'; $setupArgs += $Target }
    if ($KeepAgents)      { $setupArgs += '-KeepAgents' }

    $global:LASTEXITCODE = 0
    & powershell -ExecutionPolicy Bypass -File $setupPs1 @setupArgs
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

# --- delete cache only after success ---------------------------------------
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

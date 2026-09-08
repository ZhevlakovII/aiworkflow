# bootstrap.ps1 - one-liner installer for AI Workflow (Windows).
#
#   irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1 | iex
#
# To pass flags through to setup (irm|iex cannot take args), fetch then invoke with args:
#   $b = irm https://raw.githubusercontent.com/ZhevlakovII/aiworkflow/main/bootstrap.ps1
#   & ([scriptblock]::Create($b)) -Yes
#   & ([scriptblock]::Create($b)) -Install node,git
#   & ([scriptblock]::Create($b)) -Flow claude            # only the Claude Code flavor (~/.claude)
#   & ([scriptblock]::Create($b)) -Flow opencode          # only the OpenCode flavor (~/.config/opencode)
#
# Clones (or updates) the public repo into %USERPROFILE%\.aiworkflow, then runs tools/setup.ps1.
# Override target/source with $env:AIWORKFLOW_HOME / $env:AIWORKFLOW_REPO.
# ASCII-only (PS 5.1 parses .ps1 as cp1251 without a BOM).
param(
    [switch]$Yes,
    [switch]$SkipSmoke,
    [string[]]$Install = @(),
    [ValidateSet('omp','claude','opencode','all','both')]
    [string]$Flow = 'all',
    [string]$Target = ''
)
$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:AIWORKFLOW_REPO) { $env:AIWORKFLOW_REPO } else { 'https://github.com/ZhevlakovII/aiworkflow.git' }
$Dest    = if ($env:AIWORKFLOW_HOME) { $env:AIWORKFLOW_HOME } else { Join-Path $HOME '.aiworkflow' }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "git is required to fetch AI Workflow. Install it: winget install Git.Git  (then re-run)." -ForegroundColor Red
    exit 1
}

if (Test-Path (Join-Path $Dest '.git')) {
    Write-Host "== updating $Dest ==" -ForegroundColor Cyan
    & git -C $Dest fetch --depth 1 origin main
    & git -C $Dest reset --hard origin/main
} else {
    Write-Host "== cloning $RepoUrl -> $Dest ==" -ForegroundColor Cyan
    & git clone --depth 1 $RepoUrl $Dest
}

Set-Location $Dest
Write-Host "== running tools/setup.ps1 ==" -ForegroundColor Cyan
$setupArgs = @()
if ($Yes)             { $setupArgs += '-Yes' }
if ($SkipSmoke)       { $setupArgs += '-SkipSmoke' }
if ($Install.Count)   { $setupArgs += '-Install'; $setupArgs += ($Install -join ',') }
if ($Flow)            { $setupArgs += '-Flow'; $setupArgs += $Flow }
if ($Target)          { $setupArgs += '-Target'; $setupArgs += $Target }
& powershell -ExecutionPolicy Bypass -File (Join-Path $Dest 'tools/setup.ps1') @setupArgs

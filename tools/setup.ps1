# setup.ps1 - ALL-IN-ONE installer for AI Workflow (Windows).
#
# Wraps install.ps1 (canon copy + product-block splice) with four extra steps:
#   1) prereq detection (OMP/Node/git/ast-index; opt Claude/Java/codex) + INTERACTIVE install via
#      the platform package manager (winget or scoop; npm for codex);
#   2) machine-head bootstrap - seed ~/.omp/agent/{models.yml, config.yml modelRoles} from tools/templates/
#      ONLY when absent (never overwrite a real machine-head);
#   2b) modelRoles bind - interactively pick a model per role from the REAL models.yml, validate,
#       notify on unset/unknown roles (setup_roles.ts). -DefaultRoles = non-interactive defaults;
#   3) install.ps1 - deploy product (preserves machine-head);
#   4) post-install load-smoke (omp -p exit 0).
#
# POSIX twin: tools/setup.sh (linux/macos), identical steps.
# NOTE: ASCII-only on purpose - PS 5.1 parses .ps1 as cp1251 without a BOM, so non-ASCII breaks it.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Check           # dry-run (writes nothing)
#   powershell -ExecutionPolicy Bypass -File tools/setup.ps1                  # prompts per missing prereq
#   powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Yes             # install every installable missing
#   powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Install node,git # install only named, no prompt
#   powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -SkipSmoke       # skip load-smoke
param(
    [switch]$Check,
    [switch]$Yes,
    [switch]$InstallMissing,     # back-compat alias of -Yes
    [string[]]$Install = @(),    # install only these (by cmd name), no prompt
    [switch]$SkipSmoke,
    [switch]$DefaultRoles        # bind modelRoles non-interactively (defaults from models.yml)
)
$ErrorActionPreference = 'Stop'
if ($InstallMissing) { $Yes = $true }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo      = Split-Path -Parent $ScriptDir
$Canon     = Join-Path $Repo '.omp'
$Global    = Join-Path $HOME '.omp/agent'
$Templates = Join-Path $ScriptDir 'templates'

function Probe([string]$cmd, [string[]]$verArgs) {
    $exe = Get-Command $cmd -ErrorAction SilentlyContinue
    if (-not $exe) { return $null }
    try {
        $out = & $cmd @verArgs 2>&1 | Select-Object -First 1
        if ($null -eq $out -or "$out" -eq '') { return '(installed)' }
        return "$out".Trim()
    } catch { return '(installed)' }
}

# Detect Windows package manager: prefer winget, fall back to scoop.
$PM = if (Get-Command winget -ErrorAction SilentlyContinue) { 'winget' }
      elseif (Get-Command scoop -ErrorAction SilentlyContinue) { 'scoop' }
      else { $null }

# PkgFor <cmd> -> install command line for detected PM ('' = no recipe -> hint only).
# omp/ast-index/claude have no unattended recipe. codex is PM-agnostic (npm, needs node).
function PkgFor([string]$cmd) {
    if ($cmd -eq 'codex') {
        if (Get-Command npm -ErrorAction SilentlyContinue) { return 'npm i -g @openai/codex' } else { return '' }
    }
    if (-not $PM) { return '' }
    switch ("$cmd`:$PM") {
        'node:winget' { 'winget install -e --id OpenJS.NodeJS --accept-source-agreements --accept-package-agreements' }
        'node:scoop'  { 'scoop install nodejs' }
        'git:winget'  { 'winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements' }
        'git:scoop'   { 'scoop install git' }
        'java:winget' { 'winget install -e --id EclipseAdoptium.Temurin.21.JDK --accept-source-agreements --accept-package-agreements' }
        'java:scoop'  { 'scoop install temurin21-jdk' }
        default       { '' }
    }
}

Write-Host "=== AI Workflow setup ===" -ForegroundColor Cyan
Write-Host "canon:  $Canon"
Write-Host "global: $Global`n"

# --- 1. Prereqs ---
$prereqs = @(
    @{ name='OMP (oh-my-pi)'; cmd='omp';       args=@('--version'); required=$true;  hint='https://omp.sh (native x64 binary)' },
    @{ name='Node.js >=24';   cmd='node';      args=@('--version'); required=$true;  hint='winget install OpenJS.NodeJS  (or nvm)' },
    @{ name='Claude CLI (opt)'; cmd='claude';  args=@('--version'); required=$false; hint='https://claude.ai/code (not npm; ToS-safe worker; needed only for claude delegation backend)' },
    @{ name='git';            cmd='git';       args=@('--version'); required=$true;  hint='winget install Git.Git' },
    @{ name='ast-index';      cmd='ast-index'; args=@('version');   required=$true;  hint='install ast-index CLI (Track A discovery)' },
    @{ name='Java 21 (opt)';  cmd='java';      args=@('-version');  required=$false; hint='only for KMP target (gradle test-cmd)' },
    @{ name='codex (opt)';    cmd='codex';     args=@('--version'); required=$false; hint='npm i -g @openai/codex + codex login (cross-vendor seam)' }
)

$pmLabel = if ($PM) { $PM } else { 'none detected' }
Write-Host "--- prereqs ---  (package manager: $pmLabel)" -ForegroundColor Cyan
$missingRequired = @()
foreach ($p in $prereqs) {
    $v = Probe $p.cmd $p.args
    if ($v) {
        Write-Host ("  [ok]      {0,-16} {1}" -f $p.name, $v) -ForegroundColor Green
        continue
    }

    $tag = if ($p.required) { '[MISSING]' } else { '[absent] ' }
    $col = if ($p.required) { 'Red' } else { 'DarkGray' }
    $cmdline = PkgFor $p.cmd

    if (-not $cmdline) {
        Write-Host ("  {0} {1,-16} -> {2}" -f $tag, $p.name, $p.hint) -ForegroundColor $col   # no recipe
        if ($p.required -and -not $Check) { $missingRequired += $p.name }
        continue
    }

    if ($Check) {
        Write-Host ("  {0} {1,-16} -> installable: {2}" -f $tag, $p.name, $cmdline) -ForegroundColor $col
        continue
    }

    Write-Host ("  {0} {1,-16} -> {2}" -f $tag, $p.name, $p.hint) -ForegroundColor $col

    $want = $false
    if ($Install.Count -gt 0) {
        if ($Install -contains $p.cmd) { $want = $true }        # explicit list = install only these
    } elseif ($Yes) {
        $want = $true
    } else {
        $ans = Read-Host ("            install via [{0}] ? [y/N]" -f $cmdline)
        if ($ans -match '^(y|yes)$') { $want = $true }
    }

    if ($want) {
        Write-Host ("            > {0}" -f $cmdline) -ForegroundColor Yellow
        try { & cmd /c $cmdline; Write-Host "            installed." -ForegroundColor Green }
        catch { Write-Host ("            install FAILED (do it manually: {0})" -f $p.hint) -ForegroundColor Red }
        if (-not (Get-Command $p.cmd -ErrorAction SilentlyContinue) -and $p.required) { $missingRequired += $p.name }
    } elseif ($p.required) {
        $missingRequired += $p.name
    }
}
Write-Host ""
Write-Host "  LM Studio (opt): cheap local lead - endpoint in ~/.omp/agent/models.yml (see bootstrap below)." -ForegroundColor DarkGray
Write-Host ""

if ($missingRequired.Count -gt 0 -and -not $Check) {
    Write-Host ("ABORT: missing required prereqs: {0}" -f ($missingRequired -join ', ')) -ForegroundColor Red
    Write-Host "Install them (hints above) and re-run setup. Use -Yes to auto-install installable ones."
    Write-Host "NOTE: winget/scoop may need a NEW shell for PATH to pick up freshly installed tools." -ForegroundColor DarkGray
    exit 1
}

# --- 2. Machine-head bootstrap (seed ONLY when absent; never touch a real head) ---
$modelsDst = Join-Path $Global 'models.yml'
$cfgDst    = Join-Path $Global 'config.yml'
$modelsTpl = Join-Path $Templates 'models.yml.example'
$headTpl   = Join-Path $Templates 'machine-head.yml.example'

function HasModelRoles([string]$cfg) {
    if (-not (Test-Path $cfg)) { return $false }
    $marker = '# ===== AIWORKFLOW PRODUCT'
    foreach ($line in Get-Content $cfg -Encoding UTF8) {
        if ($line -like "$marker*") { break }        # head = everything above MARKER
        if ($line -match '^\s*modelRoles\s*:') { return $true }
    }
    return $false
}

$seedModels = -not (Test-Path $modelsDst)
$seedHead   = -not (HasModelRoles $cfgDst)

Write-Host "--- machine-head ---" -ForegroundColor Cyan
if ($Check) {
    if ($seedModels) { Write-Host "  models.yml: ABSENT   -> would seed from template" } else { Write-Host "  models.yml: present  -> keep" }
    if ($seedHead)   { Write-Host "  modelRoles: ABSENT   -> would seed from template" } else { Write-Host "  modelRoles: present  -> keep" }
    Write-Host ""
} else {
    if (-not (Test-Path $Global)) { New-Item -ItemType Directory -Force -Path $Global | Out-Null }
    if ($seedModels) {
        Copy-Item $modelsTpl $modelsDst
        Write-Host "  [seed] models.yml <- template (EDIT endpoint/model for your machine!)" -ForegroundColor Yellow
    } else { Write-Host "  [keep] models.yml present - untouched" -ForegroundColor DarkGray }

    if ($seedHead) {
        $tpl = Get-Content $headTpl -Encoding UTF8 -Raw
        if (Test-Path $cfgDst) {
            $existing = Get-Content $cfgDst -Encoding UTF8 -Raw
            Set-Content -Path $cfgDst -Value ($tpl.TrimEnd() + "`n" + $existing) -Encoding UTF8 -NoNewline
        } else {
            Set-Content -Path $cfgDst -Value $tpl -Encoding UTF8 -NoNewline
        }
        Write-Host "  [seed] config.yml modelRoles <- template (Qwen cheap-default)" -ForegroundColor Yellow
    } else { Write-Host "  [keep] modelRoles present - untouched" -ForegroundColor DarkGray }
    Write-Host ""
}

# --- 2b. modelRoles bind: pick per-role model from models.yml (interactive) + validate ---
$rolesTool = Join-Path $ScriptDir 'setup_roles.ts'
Write-Host "--- modelRoles ---" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [skip] node absent - cannot bind/validate modelRoles." -ForegroundColor DarkGray
} elseif ($Check) {
    & node $rolesTool --check --config $cfgDst --models $modelsDst   # report only, writes nothing
} elseif ($DefaultRoles) {
    & node $rolesTool --defaults --config $cfgDst --models $modelsDst # non-interactive: defaults from models.yml
} else {
    & node $rolesTool --config $cfgDst --models $modelsDst           # interactive per-role pick
}
Write-Host ""

# --- 3. install.ps1 (deploy product; preserves machine-head) ---
$installer = Join-Path $ScriptDir 'install.ps1'
Write-Host "--- install.ps1 ---" -ForegroundColor Cyan
if ($Check) {
    & powershell -ExecutionPolicy Bypass -File $installer -Check
} else {
    & powershell -ExecutionPolicy Bypass -File $installer
}
if ($LASTEXITCODE -ne 0) { Write-Host "install.ps1 failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit $LASTEXITCODE }
Write-Host ""

# --- 4. Load-smoke ---
if ($Check) {
    Write-Host "CHECK done (nothing written; smoke skipped)." -ForegroundColor Cyan
    exit 0
}
if ($SkipSmoke) {
    Write-Host "SETUP done (load-smoke skipped via -SkipSmoke)." -ForegroundColor Green
    exit 0
}
Write-Host "--- load-smoke (omp -p) ---" -ForegroundColor Cyan
$ompExe = Get-Command omp -ErrorAction SilentlyContinue
if (-not $ompExe) {
    Write-Host "omp absent - smoke skipped." -ForegroundColor Yellow
    exit 0
}
try {
    $smoke = & omp -p "Reply exactly: LOADED" --yolo 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [ok] omp loaded config+customTools+hooks (exit 0)." -ForegroundColor Green
        Write-Host "`nSETUP done." -ForegroundColor Green
    } else {
        Write-Host "  [warn] omp smoke exit ${LASTEXITCODE}:" -ForegroundColor Yellow
        Write-Host ("$smoke" | Select-Object -First 20)
        Write-Host "`nSETUP done with warning (check config)." -ForegroundColor Yellow
    }
} catch {
    Write-Host "  [warn] smoke did not run: $_" -ForegroundColor Yellow
}

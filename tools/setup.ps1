# setup.ps1 - ALL-IN-ONE installer for AI Workflow (Windows).
#
# Wraps install.ps1 (canon copy + product-block splice) with four extra steps:
#   1) prereq detection (OMP/Node/git/ast-index; opt Claude/Java/codex) + INTERACTIVE install via
#      the platform package manager (winget or scoop; npm for codex);
#   2) shared-head bootstrap - seed ~/.config/aiwf (any omp|opencode|dsh flow) from tools/templates/
#      ONLY when absent (never overwrite a real shared head); migrate legacy once;
#   2b) modelRoles bind - interactively pick a model per role from the REAL models.yml, validate,
#       notify on unset/unknown roles (setup_roles.ts). -DefaultRoles = non-interactive defaults;
#   3) install.ps1 - deploy product (preserves machine-head);
#   4) post-install load-smoke (omp -p exit 0).
#
# -Target <dir> is forwarded to flavor installers (A3 req 5) - omp/claude/opencode/cursor
# each get their own project-scoped install under <dir>/.omp, <dir>/.claude, <dir>/.opencode,
# <dir>/.cursor. -KeepAgents is likewise forwarded (project-scoped: never overwrite an
# agents/*.md already at dest - A3 req 4).
#
# Flow notes: `all` includes cursor; `both` stays omp+claude+opencode ONLY (no cursor).
# Multi-flow installs only flavors whose CLI is present; aborts if none of
# OMP/Claude/OpenCode/DSH is available (exception: -Flow cursor only).
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
#   powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Target C:\proj  # project-scoped, all flavors
#   powershell -ExecutionPolicy Bypass -File tools/setup.ps1 -Flow cursor
param(
    [switch]$Check,
    [switch]$Yes,
    [switch]$InstallMissing,     # back-compat alias of -Yes
    [string[]]$Install = @(),    # install only these (by cmd name), no prompt
    [switch]$SkipSmoke,
    [switch]$DefaultRoles,       # bind modelRoles non-interactively (defaults from models.yml)
    [ValidateSet('omp','claude','opencode','cursor','dsh','all','both')]
    [string]$Flow = 'all',       # which flow flavor: OMP / Claude / OpenCode / Cursor / DSH / all (both = omp+claude+opencode, NO cursor)
    [string]$Target = '',        # project dir for a project-scoped install (default global)
    [switch]$KeepAgents          # project-scoped: never overwrite an agents/*.md already at dest (A3 req 4)
)
$ErrorActionPreference = 'Stop'
if ($InstallMissing) { $Yes = $true }
$doOmp      = ($Flow -eq 'omp'      -or $Flow -eq 'all' -or $Flow -eq 'both')
$doClaude   = ($Flow -eq 'claude'   -or $Flow -eq 'all' -or $Flow -eq 'both')
$doOpencode = ($Flow -eq 'opencode' -or $Flow -eq 'all' -or $Flow -eq 'both')
$doCursor   = ($Flow -eq 'cursor'   -or $Flow -eq 'all')   # both deliberately excludes cursor
$doDsh      = ($Flow -eq 'dsh'      -or $Flow -eq 'all')

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo      = Split-Path -Parent $ScriptDir
$Canon     = Join-Path $Repo 'ports\omp'
$Global    = Join-Path $HOME '.omp/agent'
$SharedHead = if ($env:AIWF_CONFIG_HOME) { $env:AIWF_CONFIG_HOME } elseif ($env:XDG_CONFIG_HOME) { Join-Path $env:XDG_CONFIG_HOME 'aiwf' } else { Join-Path $HOME '.config/aiwf' }
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
# omp = upstream installer (PM-agnostic); ast-index = winget; codex = npm (needs node); claude = hint only.
function PkgFor([string]$cmd) {
    if ($cmd -eq 'codex') {
        if (Get-Command npm -ErrorAction SilentlyContinue) { return 'npm i -g @openai/codex' } else { return '' }
    }
    if ($cmd -eq 'omp') { return 'irm https://omp.sh/install.ps1 | iex' }   # upstream installer, run via Invoke-Expression
    if ($cmd -eq 'opencode') {
        if (Get-Command npm -ErrorAction SilentlyContinue) { return 'npm i -g opencode-ai' } else { return '' }
    }
    if (-not $PM) { return '' }
    switch ("$cmd`:$PM") {
        'node:winget'      { 'winget install -e --id OpenJS.NodeJS --accept-source-agreements --accept-package-agreements' }
        'node:scoop'       { 'scoop install nodejs' }
        'git:winget'       { 'winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements' }
        'git:scoop'        { 'scoop install git' }
        'ast-index:winget' { 'winget install -e --id defendend.ast-index --accept-source-agreements --accept-package-agreements' }
        'java:winget'      { 'winget install -e --id EclipseAdoptium.Temurin.21.JDK --accept-source-agreements --accept-package-agreements' }
        'java:scoop'       { 'scoop install temurin21-jdk' }
        default            { '' }
    }
}

Write-Host "=== AI Workflow setup ===" -ForegroundColor Cyan
Write-Host "flow:   $Flow  (omp=$doOmp claude=$doClaude opencode=$doOpencode cursor=$doCursor dsh=$doDsh)" -ForegroundColor Cyan
Write-Host "canon:  $Canon"
Write-Host "shared-head: $SharedHead  (legacy agent: $Global)`n"

# --- 1. Prereqs ---
# Harness CLIs (omp/claude/opencode/dsh) are soft/optional: still probe + offer install recipes,
# but NEVER enter missingRequired solely because the flow flag selected them. After the loop,
# soft-disable selected flavors whose CLI is still absent. git/ast-index stay hard-required.
# Node becomes required when any remaining selected flavor needs render/install (via node).
# T7-6 (contract L-3): python prereq removed - the rails/drivers were all ported to node
# (core/src/**), no tools/*.py left, nothing here shells out to python anymore.
$claudeHint = 'https://claude.ai/code (not npm; ToS-safe worker) - optional; skipped if absent'
$prereqs = @(
    @{ name='OMP (oh-my-pi)'; cmd='omp';       args=@('--version'); required=$false; hint='https://omp.sh (native x64 binary) - optional; skipped if absent' },
    @{ name='Node.js >=24';   cmd='node';      args=@('--version'); required=$false; hint='winget install OpenJS.NodeJS  (or nvm) - needed to render/install flavors' },
    @{ name='Claude CLI';     cmd='claude';    args=@('--version'); required=$false; hint=$claudeHint },
    @{ name='OpenCode';       cmd='opencode';  args=@('--version'); required=$false; hint='https://opencode.ai (TUI/Desktop) - optional; skipped if absent' },
    @{ name='DSH (DeepSeek)'; cmd='dsh';      args=@('--version'); required=$false; hint='DeepSeek Harness (Cordis) - optional; skipped if absent' },
    @{ name='git';            cmd='git';       args=@('--version'); required=$true;     hint='winget install Git.Git' },
    @{ name='ast-index';      cmd='ast-index'; args=@('version');   required=$true;     hint='install ast-index CLI (Track A discovery)' },
    @{ name='Java 21 (opt)';  cmd='java';      args=@('-version');  required=$false;    hint='only for KMP target (gradle test-cmd)' },
    @{ name='codex (opt)';    cmd='codex';     args=@('--version'); required=$false;    hint='npm i -g @openai/codex + codex login (cross-vendor seam)' }
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
        try {
            if ($p.cmd -eq 'omp') { Invoke-Expression (Invoke-RestMethod 'https://omp.sh/install.ps1') }
            else { & cmd /c $cmdline }
            Write-Host "            installed." -ForegroundColor Green
        } catch { Write-Host ("            install FAILED (do it manually: {0})" -f $p.hint) -ForegroundColor Red }
        # refresh PATH from machine+user env so a freshly installed tool is visible this run
        $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')
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

# Soft-disable selected flavors whose harness CLI is still missing (re-probe after optional installs).
if ($doOmp -and -not (Get-Command omp -ErrorAction SilentlyContinue)) {
    Write-Host '[skip] OMP CLI absent - omp flavor not installed' -ForegroundColor Yellow
    $doOmp = $false
}
if ($doClaude -and -not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host '[skip] Claude CLI absent - claude flavor not installed' -ForegroundColor Yellow
    $doClaude = $false
}
if ($doOpencode -and -not (Get-Command opencode -ErrorAction SilentlyContinue)) {
    Write-Host '[skip] OpenCode CLI absent - opencode flavor not installed' -ForegroundColor Yellow
    $doOpencode = $false
}
if ($doDsh -and -not (Get-Command dsh -ErrorAction SilentlyContinue)) {
    Write-Host '[skip] DSH CLI absent - dsh flavor not installed' -ForegroundColor Yellow
    $doDsh = $false
}

# Soft-skip Cursor when the app/CLI is not detectable (PATH + Windows LocalAppData).
function Test-CursorPresent {
    if (Get-Command cursor -ErrorAction SilentlyContinue) { return $true }
    $la = $env:LOCALAPPDATA
    if ($la) {
        $c1 = Join-Path $la 'Programs\cursor\Cursor.exe'
        $c2 = Join-Path $la 'Programs\Cursor\Cursor.exe'
        if (Test-Path -LiteralPath $c1) { return $true }
        if (Test-Path -LiteralPath $c2) { return $true }
    }
    return $false
}
if ($doCursor -and -not (Test-CursorPresent)) {
    Write-Host '[skip] Cursor absent - cursor flavor not installed' -ForegroundColor Yellow
    $doCursor = $false
}

if (-not $Check) {
    # Abort when none of the four harness CLIs can back a selected flavor (cursor-only is the exception).
    $anyHarness = $doOmp -or $doClaude -or $doOpencode -or $doDsh
    if (-not $anyHarness -and $Flow -ne 'cursor') {
        $anyPresent = (Get-Command omp -ErrorAction SilentlyContinue) -or
            (Get-Command claude -ErrorAction SilentlyContinue) -or
            (Get-Command opencode -ErrorAction SilentlyContinue) -or
            (Get-Command dsh -ErrorAction SilentlyContinue)
        if (-not $anyPresent) {
            Write-Host 'ABORT: none of OMP/Claude/OpenCode/DSH CLI is present; need at least one harness (or use -Flow cursor).' -ForegroundColor Red
            Write-Host 'Install one of those harness CLIs and re-run setup.'
        } else {
            Write-Host ("ABORT: selected flow '{0}' has no installable harness CLI on PATH." -f $Flow) -ForegroundColor Red
            Write-Host 'Install the matching CLI for that flow, or use -Flow all to install whatever is present.'
        }
        exit 1
    }
    # Node required when any remaining selected flavor still runs (installers render via node).
    if ($doOmp -or $doClaude -or $doOpencode -or $doCursor -or $doDsh) {
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            Write-Host 'ABORT: missing required prereqs: Node.js >=24' -ForegroundColor Red
            Write-Host 'Install them (hints above) and re-run setup. Use -Yes to auto-install installable ones.'
            Write-Host 'NOTE: winget/scoop may need a NEW shell for PATH to pick up freshly installed tools.' -ForegroundColor DarkGray
            exit 1
        }
    }
}

# --- 2. Shared head (neutral): any resolving flow (omp|opencode|dsh), not only doOmp ---
# Claude/cursor-only skip seed. Seed-if-absent + legacy import-once + modelRoles sync to OMP.
$needHead = $doOmp -or $doOpencode -or $doDsh
if ($needHead) {
$headCli = Join-Path $ScriptDir 'aiwf_head_cli.ts'
Write-Host "--- shared-head ---" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [skip] node absent - cannot ensure shared head." -ForegroundColor DarkGray
} elseif ($Check) {
    & node $headCli ensure --check --templates $Templates
} else {
    & node $headCli ensure --templates $Templates
    if ($LASTEXITCODE -ne 0) { Write-Host ("shared head ensure failed (exit " + $LASTEXITCODE + ")") -ForegroundColor Red; exit $LASTEXITCODE }
}
Write-Host ""

# --- 2b. modelRoles bind against shared head ---
$rolesTool = Join-Path $ScriptDir 'setup_roles.ts'
Write-Host "--- modelRoles ---" -ForegroundColor Cyan
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  [skip] node absent - cannot bind/validate modelRoles." -ForegroundColor DarkGray
} elseif ($Check) {
    & node $rolesTool --check
} elseif ($DefaultRoles) {
    & node $rolesTool --defaults
} else {
    & node $rolesTool
}
Write-Host ""
}

if ($doOmp) {
# --- 3. install.ps1 (deploy product; head already ensured above) ---
$installer = Join-Path $ScriptDir 'install.ps1'
Write-Host "--- install.ps1 ---" -ForegroundColor Cyan
$ompArgs = @()
if ($Check)      { $ompArgs += '-Check' }
if ($Target)     { $ompArgs += '-Target'; $ompArgs += $Target }
if ($KeepAgents) { $ompArgs += '-KeepAgents' }
& powershell -ExecutionPolicy Bypass -File $installer @ompArgs
if ($LASTEXITCODE -ne 0) { Write-Host "install.ps1 failed" -ForegroundColor Red; exit $LASTEXITCODE }
Write-Host ""

# --- 4. Load-smoke (omp) ---
if (-not $Check -and -not $SkipSmoke) {
    Write-Host "--- load-smoke (omp -p) ---" -ForegroundColor Cyan
    $ompExe = Get-Command omp -ErrorAction SilentlyContinue
    if (-not $ompExe) {
        Write-Host "omp absent - smoke skipped." -ForegroundColor Yellow
    } else {
        try {
            $smoke = & omp -p "Reply exactly: LOADED" --yolo 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  [ok] omp loaded config+customTools+hooks (exit 0)." -ForegroundColor Green
            } else {
                Write-Host ("  [warn] omp smoke exit " + $LASTEXITCODE) -ForegroundColor Yellow
                Write-Host ($smoke | Select-Object -First 20)
            }
        } catch {
            Write-Host ("  [warn] smoke did not run: " + $_) -ForegroundColor Yellow
        }
    }
    Write-Host ""
}
}  # end if ($doOmp)


# --- 5. Claude Code flavor (agents + commands + hooks + settings) ---
if ($doClaude) {
    $ccInstaller = Join-Path $ScriptDir 'install-claude.ps1'
    Write-Host "--- install-claude.ps1 ---" -ForegroundColor Cyan
    $ccArgs = @()
    if ($Check)      { $ccArgs += '-Check' }
    if ($Target)     { $ccArgs += '-Target'; $ccArgs += $Target }
    if ($KeepAgents) { $ccArgs += '-KeepAgents' }
    & powershell -ExecutionPolicy Bypass -File $ccInstaller @ccArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "install-claude.ps1 failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit $LASTEXITCODE }
    Write-Host ""
}

# --- 6. OpenCode flavor (TS tools + plugins + agents + commands + opencode.json) ---
if ($doOpencode) {
    $ocInstaller = Join-Path $ScriptDir 'install-opencode.ps1'
    Write-Host "--- install-opencode.ps1 ---" -ForegroundColor Cyan
    $ocArgs = @()
    if ($Check)      { $ocArgs += '-Check' }
    if ($Target)     { $ocArgs += '-Target'; $ocArgs += $Target }
    if ($KeepAgents) { $ocArgs += '-KeepAgents' }
    & powershell -ExecutionPolicy Bypass -File $ocInstaller @ocArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "install-opencode.ps1 failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit $LASTEXITCODE }
    Write-Host ""
}

# --- 7. DSH flavor (Cordis plugin + .dsh-aiwf overlay) ---
if ($doDsh) {
    $dshInstaller = Join-Path $ScriptDir 'install-dsh.ps1'
    Write-Host "--- install-dsh.ps1 ---" -ForegroundColor Cyan
    $dshArgs = @()
    if ($Check)  { $dshArgs += '-Check' }
    if ($Target) { $dshArgs += '-Target'; $dshArgs += $Target }
    & powershell -ExecutionPolicy Bypass -File $dshInstaller @dshArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "install-dsh.ps1 failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit $LASTEXITCODE }
    Write-Host ""
}

# --- 8. Cursor flavor (agents + skills + hooks.json) ---
if ($doCursor) {
    $cuInstaller = Join-Path $ScriptDir 'install-cursor.ps1'
    Write-Host "--- install-cursor.ps1 ---" -ForegroundColor Cyan
    $cuArgs = @()
    if ($Check)      { $cuArgs += '-Check' }
    if ($Target)     { $cuArgs += '-Target'; $cuArgs += $Target }
    if ($KeepAgents) { $cuArgs += '-KeepAgents' }
    & powershell -ExecutionPolicy Bypass -File $cuInstaller @cuArgs
    if ($LASTEXITCODE -ne 0) { Write-Host "install-cursor.ps1 failed (exit $LASTEXITCODE)" -ForegroundColor Red; exit $LASTEXITCODE }
    Write-Host ""
}

if ($Check) { Write-Host "CHECK done (nothing written)." -ForegroundColor Cyan }
else        { Write-Host "SETUP done (flow: $Flow)." -ForegroundColor Green }

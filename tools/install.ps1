<#
.SYNOPSIS
  Install AI Workflow flow-layer from canon (<repo>/.omp) into global OMP (~/.omp/agent).

.DESCRIPTION
  Prod layout (P9 2026-08-29): product ships as GLOBAL OMP config, not a per-repo junction.
  Canon = <repo>/.omp (git). Installer:
    1) mirrors tools/ hooks/ agents/ (robocopy /MIR - removes stale files);
    2) copies RULES.md AGENTS.md WATCHDOG.md WATCHDOG.yml;
    3) splices the PRODUCT block into ~/.omp/agent/config.yml (paths ./.omp/ -> ~/.omp/agent/,
       tilde because relative paths resolve against CWD not the config file), PRESERVING the
       machine-head (modelRoles/theme/...).
  Project <repo>/.omp/config.yml + zonemap.yml are untouched (OMP merges them per-key on top).
  Idempotent: re-running does not duplicate.

.PARAMETER Check
  Dry-run: report divergences only, write nothing.
#>
[CmdletBinding()]
param([switch]$Check)

$ErrorActionPreference = "Stop"
$repo   = Split-Path -Parent $PSScriptRoot          # tools/ -> repo
$canon  = Join-Path $repo ".omp"
$global = Join-Path $env:USERPROFILE ".omp\agent"
$MARKER = "# ===== AIWORKFLOW PRODUCT - managed by tools/install.ps1 (do not edit below) ====="

if (-not (Test-Path $canon))  { throw "canon not found: $canon" }
if (-not (Test-Path $global)) { New-Item -ItemType Directory -Force -Path $global | Out-Null }

Write-Host "canon:  $canon"
Write-Host "global: $global"
Write-Host ""

# --- 1. Mirror trees (tools/hooks/agents) ---
$trees = @("tools", "hooks", "agents")
foreach ($t in $trees) {
    $src = Join-Path $canon $t
    $dst = Join-Path $global $t
    if (-not (Test-Path $src)) { continue }
    if ($Check) {
        $changes = robocopy $src $dst /MIR /L /NJH /NJS /NDL /NP /NC /NS
        $n = ($changes | Where-Object { $_.Trim() -ne "" }).Count
        Write-Host ("[check] {0}: {1} file(s) would change" -f $t, $n)
    } else {
        robocopy $src $dst /MIR /NJH /NJS /NDL /NP /NC /NS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy $t failed (exit $LASTEXITCODE)" }
        Write-Host ("[sync] {0}/ mirrored" -f $t)
    }
}

# --- 2. Copy md files ---
$files = @("RULES.md", "AGENTS.md", "WATCHDOG.md", "WATCHDOG.yml")
foreach ($f in $files) {
    $src = Join-Path $canon $f
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $global $f
    if ($Check) {
        $differ = (-not (Test-Path $dst)) -or ((Get-FileHash $src).Hash -ne (Get-FileHash $dst).Hash)
        $state = if ($differ) { "would change" } else { "in sync" }
        Write-Host ("[check] {0}: {1}" -f $f, $state)
    } else {
        Copy-Item $src $dst -Force
        Write-Host ("[sync] {0}" -f $f)
    }
}

# --- 3. Splice PRODUCT block into global config.yml ---
$canonCfg  = Join-Path $canon "config.yml"
$globalCfg = Join-Path $global "config.yml"
if (-not (Test-Path $canonCfg)) { throw "canon config.yml not found" }

# product body = canon from first 'extensions:' line to EOF, with tilde paths.
# -Encoding UTF8: canon has Cyrillic comments; default ANSI read would mojibake them on rewrite.
$canonLines = Get-Content $canonCfg -Encoding UTF8
$extLine = ($canonLines | Select-String -Pattern '^extensions:' | Select-Object -First 1)
if (-not $extLine) { throw "canon config.yml has no 'extensions:'" }
$extIdx = $extLine.LineNumber - 1
$productBody = ($canonLines[$extIdx..($canonLines.Count - 1)] -join "`n") -replace '\./\.omp/', '~/.omp/agent/'

# machine-head = global up to first of {MARKER, a PRODUCT-header divider, 'extensions:'}.
$headText = ""
if (Test-Path $globalCfg) {
    $g = Get-Content $globalCfg -Encoding UTF8
    $cut = $g.Count
    # Precise cut: our MARKER (re-runs) or first top-level 'extensions:' (first migration).
    # NOTE: do NOT match on substrings like 'PRODUCT' or Cyrillic letters — machine-head comments
    # can contain them and would truncate modelRoles (bug fixed 2026-08-30).
    for ($i = 0; $i -lt $g.Count; $i++) {
        if ($g[$i] -eq $MARKER -or $g[$i] -match '^extensions:') { $cut = $i; break }
    }
    $headLines = @()
    if ($cut -gt 0) { $headLines = @($g[0..($cut - 1)]) }
    while ($headLines.Count -gt 0 -and ($headLines[-1].Trim() -eq "" -or $headLines[-1] -match '^#\s*={3,}')) {
        $headLines = @($headLines[0..($headLines.Count - 2)])
    }
    $headText = ($headLines -join "`n")
}

$newCfg = ($headText.TrimEnd() + "`n`n" + $MARKER + "`n" + $productBody).TrimEnd() + "`n"

if ($Check) {
    # Read as UTF-8 explicitly (PS5.1 Get-Content default-decodes as ANSI -> false diff on Cyrillic comments).
    $cur = if (Test-Path $globalCfg) { [System.IO.File]::ReadAllText($globalCfg) } else { "" }
    if ($cur -ne $newCfg) { Write-Host "[check] config.yml: would change (product block rebuilt)" }
    else                  { Write-Host "[check] config.yml: in sync" }
} else {
    # UTF-8 WITHOUT BOM (PS5.1 Set-Content -Encoding utf8 adds a BOM; YAML parsers dislike it).
    [System.IO.File]::WriteAllText($globalCfg, $newCfg, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "[sync] config.yml: product block rebuilt (machine-head preserved)"
}

Write-Host ""
if ($Check) { Write-Host "CHECK done (nothing written)." }
else        { Write-Host "INSTALL done. Verify: omp in a project sees the global tools." }

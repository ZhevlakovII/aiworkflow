<#
.SYNOPSIS
  Install the AI Workflow OPENCODE flavor (TS tools + plugins + agents + commands + opencode.json).

.DESCRIPTION
  OpenCode port of the flow (docs/design/omp-to-opencode-port-2026-09-08.md). Deploys the .opencode
  layer so OpenCode (TUI/Desktop) auto-discovers custom-tools, plugins, subagents and slash-commands.

  Default target = user-global ~/.config/opencode. -Target <dir> stamps <dir>/.opencode (project-scoped)
  and writes <dir>/opencode.json.

  Unlike the claude flavor: TS tools are self-contained (relative ../lib imports + PATH binaries
  git/gh/claude/opencode/codex/ast-index) -> NO path rewrite. opencode.json is MERGED (permission +
  instructions spliced, existing user keys preserved). agents/ is OVERLAID (does not delete the user's
  own agents in a shared global dir); tools/plugins/lib/commands are full mirrors. Idempotent.

  ASCII-only on purpose (PS 5.1 parses .ps1 as cp1251 without a BOM).

.PARAMETER Check   Dry-run: report what would change, write nothing.
.PARAMETER Target  Project dir for a project-scoped install (default: global ~/.config/opencode).
#>
[CmdletBinding()]
param([switch]$Check, [string]$Target = '')

$ErrorActionPreference = 'Stop'
$repo    = Split-Path -Parent $PSScriptRoot
$src     = Join-Path $repo '.opencode'
$srcJson = Join-Path $repo 'opencode.json'
if (-not (Test-Path $src))     { throw "canon .opencode not found: $src" }
if (-not (Test-Path $srcJson)) { throw "canon opencode.json not found: $srcJson" }

$projectScoped = [bool]$Target
if ($projectScoped) {
    $dest = Join-Path $Target '.opencode'; $jsonDst = Join-Path $Target 'opencode.json'
} else {
    $cfgRoot = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }
    $dest = Join-Path $cfgRoot 'opencode'; $jsonDst = Join-Path $dest 'opencode.json'
}
$agentsDst = Join-Path $dest 'AGENTS.md'

Write-Host "flavor: opencode" -ForegroundColor Cyan
Write-Host "canon:  $src"
Write-Host "dest:   $dest  ($(if ($projectScoped){'project-scoped'}else{'global'}))`n"

if (-not $Check) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }

# --- 1a. full-mirror subtrees (ours: safe to delete stale within) ---
foreach ($t in @('tools','plugins','lib','commands')) {
    $s = Join-Path $src $t; $d = Join-Path $dest $t
    if (-not (Test-Path $s)) { continue }
    if ($Check) {
        $chg = robocopy $s $d /MIR /L /NJH /NJS /NDL /NP /NC /NS
        Write-Host ("[check] {0}/: {1} file(s) would change" -f $t, (($chg | Where-Object { $_.Trim() -ne '' }).Count))
    } else {
        robocopy $s $d /MIR /NJH /NJS /NDL /NP /NC /NS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy $t failed ($LASTEXITCODE)" }
        Write-Host "[sync] $t/ mirrored"
    }
}

# --- 1b. overlay subtree (agents: shared with user agents -> copy ours, keep theirs) ---
foreach ($t in @('agents')) {
    $s = Join-Path $src $t; $d = Join-Path $dest $t
    if (-not (Test-Path $s)) { continue }
    if ($Check) {
        $chg = robocopy $s $d /E /L /NJH /NJS /NDL /NP /NC /NS
        Write-Host ("[check] {0}/ (overlay): {1} file(s) would change" -f $t, (($chg | Where-Object { $_.Trim() -ne '' }).Count))
    } else {
        robocopy $s $d /E /NJH /NJS /NDL /NP /NC /NS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy $t failed ($LASTEXITCODE)" }
        Write-Host "[sync] $t/ overlaid (user files kept)"
    }
}

# --- 1c. top-level files ---
foreach ($f in @('AGENTS.md','delegation.yml','zonemap.yml')) {
    $s = Join-Path $src $f; $d = Join-Path $dest $f
    if (-not (Test-Path $s)) { continue }
    if ($Check) {
        $same = (Test-Path $d) -and ((Get-Content $s -Raw) -eq (Get-Content $d -Raw))
        Write-Host ("[check] {0}: {1}" -f $f, $(if ($same) { 'in sync' } else { 'would change' }))
    } else {
        Copy-Item $s $d -Force
    }
}
if (-not $Check) { Write-Host "[sync] AGENTS.md + delegation.yml + zonemap.yml" }

# --- 2. opencode.json MERGE (permission + instructions; preserve existing user keys) ---
$canon = Get-Content $srcJson -Encoding UTF8 -Raw | ConvertFrom-Json
$cfg = $null
if (Test-Path $jsonDst) { try { $cfg = Get-Content $jsonDst -Encoding UTF8 -Raw | ConvertFrom-Json } catch { $cfg = $null } }
if (-not $cfg) { $cfg = [pscustomobject]@{} }

function Ensure-Prop($obj, $name, $default) {
    if (-not ($obj.PSObject.Properties.Name -contains $name)) {
        $obj | Add-Member -NotePropertyName $name -NotePropertyValue $default
    }
    return $obj.$name
}

# permission: overlay canon keys; bash pattern-map merged (keep user's extra patterns)
$perm  = Ensure-Prop $cfg 'permission' ([pscustomobject]@{})
$cperm = $canon.permission
if ($cperm) {
    foreach ($k in $cperm.PSObject.Properties.Name) {
        $cv = $cperm.$k
        if ($k -eq 'bash' -and ($perm.PSObject.Properties.Name -contains 'bash') -and ($perm.bash -is [pscustomobject])) {
            foreach ($bk in $cv.PSObject.Properties.Name) {
                if ($perm.bash.PSObject.Properties.Name -contains $bk) { $perm.bash.$bk = $cv.$bk }
                else { $perm.bash | Add-Member -NotePropertyName $bk -NotePropertyValue $cv.$bk }
            }
        } elseif ($perm.PSObject.Properties.Name -contains $k) { $perm.$k = $cv }
        else { $perm | Add-Member -NotePropertyName $k -NotePropertyValue $cv }
    }
}

# instructions: ensure our deployed AGENTS.md is referenced (scoped=relative/portable, global=absolute)
$instrPath = if ($projectScoped) { '.opencode/AGENTS.md' } else { ($agentsDst -replace '\\','/') }
$instr = @()
if (($cfg.PSObject.Properties.Name -contains 'instructions') -and $cfg.instructions) { $instr = @($cfg.instructions) }
if (($instr -notcontains $instrPath) -and ($instr -notcontains './AGENTS.md') -and ($instr -notcontains '.opencode/AGENTS.md')) {
    $instr += $instrPath
}
if ($cfg.PSObject.Properties.Name -contains 'instructions') { $cfg.instructions = $instr }
else { $cfg | Add-Member -NotePropertyName 'instructions' -NotePropertyValue $instr }

# $schema passthrough
if (-not ($cfg.PSObject.Properties.Name -contains '$schema') -and ($canon.PSObject.Properties.Name -contains '$schema')) {
    $cfg | Add-Member -NotePropertyName '$schema' -NotePropertyValue $canon.'$schema'
}

$json = $cfg | ConvertTo-Json -Depth 20
if ($Check) {
    $cur = if (Test-Path $jsonDst) { Get-Content $jsonDst -Encoding UTF8 -Raw } else { '' }
    Write-Host ("[check] opencode.json: {0}" -f $(if ($cur.Trim() -ne $json.Trim()) { 'would change (permission/instructions merged)' } else { 'in sync' }))
} else {
    $parent = Split-Path -Parent $jsonDst
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [System.IO.File]::WriteAllText($jsonDst, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
    Write-Host "[sync] opencode.json (permission + instructions merged, existing keys preserved)"
}

Write-Host ""
if ($Check) {
    Write-Host "CHECK done (nothing written)." -ForegroundColor Cyan
} else {
    Write-Host "OPENCODE flavor installed." -ForegroundColor Green
    if (-not $projectScoped) {
        Write-Host "  Global: tools/plugins/commands/agents in $dest (visible in every project)." -ForegroundColor DarkGray
        Write-Host "  NOTE: driver-tools read .opencode/{agents,delegation.yml,zonemap.yml} relative to the PROJECT cwd." -ForegroundColor DarkGray
        Write-Host "        For the full flow keep a project-local .opencode/ OR install project-scoped (-Target)." -ForegroundColor DarkGray
    } else {
        Write-Host "  Project-scoped: <target>/.opencode + <target>/opencode.json (tools resolve everything cwd-relative)." -ForegroundColor DarkGray
    }
    Write-Host "  Open the project in OpenCode: flow runs with no command (AGENTS.md -> build agent) or via /aiwf-* commands." -ForegroundColor Yellow
}

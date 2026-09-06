<#
.SYNOPSIS
  Install the AI Workflow CLAUDE-CODE flavor (agents + commands + hooks + settings).

.DESCRIPTION
  CC port of the flow (docs/design/omp-to-claude-code-port-2026-09-06.md). Deploys the
  .claude layer so Claude Code sees the subagents, slash-commands and enforcement hooks.

  Default target = user-global ~/.claude (available in every project). -Target <dir>
  stamps into <dir>/.claude instead (project-scoped) and also copies CLAUDE.md.

  Tool/hook paths are rewritten to ABSOLUTE clone paths (<repo>/tools, <repo>/.claude/hooks)
  so commands/hooks work from any project cwd. Hooks are cwd-aware (read target project
  root from the hook stdin), so a single global copy serves every project.

  settings.json is MERGED (not overwritten): our PreToolUse/PostToolUse hooks and
  permissions.deny are spliced in, preserving any existing user settings (statusline, etc.).

.PARAMETER Check   Dry-run: report what would change, write nothing.
.PARAMETER Target  Project dir for a project-scoped install (default: global ~/.claude).
#>
[CmdletBinding()]
param([switch]$Check, [string]$Target = '')

$ErrorActionPreference = 'Stop'
$repo    = Split-Path -Parent $PSScriptRoot
$src     = Join-Path $repo '.claude'
$repoFwd = ($repo -replace '\\','/')
if (-not (Test-Path $src)) { throw "canon .claude not found: $src" }

$projectScoped = [bool]$Target
$dest = if ($projectScoped) { Join-Path $Target '.claude' } else { Join-Path $HOME '.claude' }

Write-Host "flavor: claude-code" -ForegroundColor Cyan
Write-Host "canon:  $src"
Write-Host "dest:   $dest  ($(if ($projectScoped){'project-scoped'}else{'global'}))`n"

if (-not $Check) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }

# --- 1. Mirror agents/ (verbatim) ---
foreach ($t in @('agents')) {
    $s = Join-Path $src $t; $d = Join-Path $dest $t
    if (-not (Test-Path $s)) { continue }
    if ($Check) {
        $chg = robocopy $s $d /MIR /L /NJH /NJS /NDL /NP /NC /NS
        Write-Host ("[check] {0}: {1} file(s) would change" -f $t, (($chg | Where-Object { $_.Trim() -ne '' }).Count))
    } else {
        robocopy $s $d /MIR /NJH /NJS /NDL /NP /NC /NS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy $t failed ($LASTEXITCODE)" }
        Write-Host "[sync] $t/ mirrored"
    }
}

# --- 2. commands/ (rewrite `python tools/X.py` -> absolute clone path) ---
$cmdSrc = Join-Path $src 'commands'
$cmdDst = Join-Path $dest 'commands'
if (Test-Path $cmdSrc) {
    if (-not $Check) { New-Item -ItemType Directory -Force -Path $cmdDst | Out-Null }
    foreach ($f in Get-ChildItem $cmdSrc -Filter *.md) {
        $body = Get-Content $f.FullName -Encoding UTF8 -Raw
        $body = [regex]::Replace($body, 'python tools/(\S+\.py)', ('python "' + $repoFwd + '/tools/$1"'))
        $out  = Join-Path $cmdDst $f.Name
        if ($Check) {
            $cur = if (Test-Path $out) { Get-Content $out -Encoding UTF8 -Raw } else { '' }
            Write-Host ("[check] commands/{0}: {1}" -f $f.Name, $(if ($cur -ne $body) { 'would change' } else { 'in sync' }))
        } else {
            [System.IO.File]::WriteAllText($out, $body, (New-Object System.Text.UTF8Encoding $false))
        }
    }
    if (-not $Check) { Write-Host "[sync] commands/ (tool paths -> clone)" }
}

# --- 3. settings.json MERGE (hooks + permissions.deny; preserve existing keys) ---
$setDst = Join-Path $dest 'settings.json'
$zg  = 'python "' + $repoFwd + '/.claude/hooks/zone-guard.py"'
$tel = 'python "' + $repoFwd + '/.claude/hooks/telemetry.py"'

$cfg = $null
if (Test-Path $setDst) {
    try { $cfg = Get-Content $setDst -Encoding UTF8 -Raw | ConvertFrom-Json } catch { $cfg = $null }
}
if (-not $cfg) { $cfg = [pscustomobject]@{} }

function Ensure-Prop($obj, $name, $default) {
    if (-not ($obj.PSObject.Properties.Name -contains $name)) {
        $obj | Add-Member -NotePropertyName $name -NotePropertyValue $default
    }
    return $obj.$name
}

# permissions.deny
$perm = Ensure-Prop $cfg 'permissions' ([pscustomobject]@{})
$deny = @(Ensure-Prop $perm 'deny' @())
foreach ($d in @('Bash(rm -rf:*)','Bash(nc:*)','Bash(ssh:*)','PowerShell(Remove-Item -Recurse -Force:*)')) {
    if ($deny -notcontains $d) { $deny += $d }
}
$perm.deny = $deny

# hooks (dedupe by 'zone-guard'/'telemetry' substring so re-run does not duplicate)
$hooks = Ensure-Prop $cfg 'hooks' ([pscustomobject]@{})
function Set-HookGroup($hooksObj, $event, $matcher, $cmd, $tag) {
    $arr = @()
    if ($hooksObj.PSObject.Properties.Name -contains $event) {
        $arr = @($hooksObj.$event | Where-Object {
            -not ($_.hooks | Where-Object { "$($_.command)" -like "*$tag*" })
        })
    }
    $arr += [pscustomobject]@{ matcher = $matcher; hooks = @([pscustomobject]@{ type = 'command'; command = $cmd }) }
    if ($hooksObj.PSObject.Properties.Name -contains $event) { $hooksObj.$event = $arr }
    else { $hooksObj | Add-Member -NotePropertyName $event -NotePropertyValue $arr }
}
Set-HookGroup $hooks 'PreToolUse'  'Bash|Write|Edit|MultiEdit|NotebookEdit' $zg  'zone-guard'
Set-HookGroup $hooks 'PostToolUse' ''                                        $tel 'telemetry'

$json = $cfg | ConvertTo-Json -Depth 20
if ($Check) {
    $cur = if (Test-Path $setDst) { Get-Content $setDst -Encoding UTF8 -Raw } else { '' }
    Write-Host ("[check] settings.json: {0}" -f $(if ($cur.Trim() -ne $json.Trim()) { 'would change (hooks/deny merged)' } else { 'in sync' }))
} else {
    [System.IO.File]::WriteAllText($setDst, $json, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "[sync] settings.json (hooks + permissions.deny merged, existing keys preserved)"
}

# --- 4. CLAUDE.md (project-scoped only; global install skips it to avoid ambient rules) ---
$claudeSrc = Join-Path $repo 'CLAUDE.md'
if ($projectScoped -and (Test-Path $claudeSrc)) {
    $claudeDst = Join-Path $Target 'CLAUDE.md'
    if ($Check) {
        Write-Host ("[check] CLAUDE.md: {0}" -f $(if (Test-Path $claudeDst) { 'exists (will NOT overwrite)' } else { 'would create' }))
    } elseif (Test-Path $claudeDst) {
        Write-Host "[keep] CLAUDE.md exists in target - not overwritten" -ForegroundColor DarkGray
    } else {
        Copy-Item $claudeSrc $claudeDst
        Write-Host "[sync] CLAUDE.md -> target project"
    }
}

Write-Host ""
if ($Check) {
    Write-Host "CHECK done (nothing written)." -ForegroundColor Cyan
} else {
    Write-Host "CLAUDE-CODE flavor installed." -ForegroundColor Green
    if (-not $projectScoped) {
        Write-Host "  Global: agents+commands+hooks live in ~/.claude and every project." -ForegroundColor DarkGray
        Write-Host "  Per-project lead protocol: copy $claudeSrc into a project as CLAUDE.md (opt-in)." -ForegroundColor DarkGray
    }
    Write-Host "  Reload Claude Code (restart session) for settings.json hooks to take effect." -ForegroundColor Yellow
}

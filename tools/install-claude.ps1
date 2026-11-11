<#
.SYNOPSIS
  Install the AI Workflow CLAUDE-CODE flavor (agents + commands + hooks + settings).

.DESCRIPTION
  CC port of the flow (docs/design/omp-to-claude-code-port-2026-09-06.md). Deploys the
  .claude layer so Claude Code sees the subagents, slash-commands and enforcement hooks.

  Default target = user-global ~/.claude (available in every project). -Target <dir>
  stamps into <dir>/.claude instead (project-scoped) and also copies root AGENTS.md
  (if-absent; never overwrites).
  Tool/hook paths are rewritten to ABSOLUTE paths inside <dest> (<dest>/core/...) so
  commands/hooks work from any project cwd after core is vendored into dest. Hooks are
  cwd-aware (read target project root from the hook stdin), so a single global copy
  serves every project.

  The enforcement PreToolUse hook is the TS command-hook shim
  (core/src/shim/command-hook.ts); the L1-L3 rails (core/src/rails/cli.ts) are invoked
  by the copied slash-commands. Both run on Node's native TS strip (Node >=22.6 or
  >=23) - the old python zone-guard.py / gated_*.py / zone_check.py rails are retired,
  and so is the design-stage driver (design_stage.py/gate_setup.py/claude_worker.py/
  gate_lint.py, ported to core/src/design/*-cli.ts) - no copied slash-command shells
  out to python anymore. The PostToolUse telemetry hook is also TS now
  (core/src/ops/telemetry-hook.ts, ported from .claude/hooks/telemetry.py) - this
  installer script needs no python at all (uses ConvertFrom-Json natively).

  settings.json is MERGED (not overwritten): our PreToolUse/PostToolUse hooks and
  permissions.deny are spliced in, preserving any existing user settings (statusline, etc.).

  Agents/*.md are NOT copied verbatim from the committed `.claude/agents` port copy
  (A3 req 2): every install renders `canon/roles` + `tools/adapters/claude.yml`
  into a fresh temp dir (`node core/src/render/cli.ts render --out <tmp> --clients
  claude`) and installs FROM THAT RENDER — a broken/missing node aborts the
  installer, no silent fallback. Global mode mirrors (deletes stale); project mode
  OVERLAYS (never deletes a project's own extra agents/*.md; -KeepAgents freezes
  any file already present at the dest — A3 req 4).

.PARAMETER Check   Dry-run: report what would change, write nothing.
.PARAMETER Target  Project dir for a project-scoped install (default: global ~/.claude).
.PARAMETER KeepAgents  Project-scoped only: never overwrite an agents/*.md already at dest.
#>
[CmdletBinding()]
param([switch]$Check, [string]$Target = '', [switch]$KeepAgents)

$ErrorActionPreference = 'Stop'
$repo    = Split-Path -Parent $PSScriptRoot
$src     = Join-Path $repo 'ports\claude'
$repoFwd = ($repo -replace '\\','/')
$canonRoleRoot = Join-Path $repo 'canon'
$adaptersRoot  = Join-Path $repo 'tools\adapters'
if (-not (Test-Path $src)) { throw "canon .claude not found: $src" }

$projectScoped = [bool]$Target
$dest = if ($projectScoped) { Join-Path $Target '.claude' } else { Join-Path $HOME '.claude' }
# Tracked while walking the project agents-overlay loop below (A3b): see install.ps1 for rationale.
$canonAgentNames = @()
$keptAgentOverlayNames = @()

# A3b fix: a -KeepAgents-frozen canon-named file is a REAL project overlay (needs the `!`
# un-ignore exception) only if its content actually differs from the freshly rendered canon
# file - a byte-identical (CRLF/LF-insensitive) kept file is just a plain canon copy from a
# prior install and should stay ignored.
function Test-SameAgentContent($srcFile, $dstFile) {
    if (-not (Test-Path $dstFile)) { return $false }
    $a = (Get-Content $srcFile -Raw -Encoding UTF8) -replace "`r`n","`n"
    $b = (Get-Content $dstFile -Raw -Encoding UTF8) -replace "`r`n","`n"
    return $a -eq $b
}

# A3b: writes/replaces the managed `# >>> aiworkflow <flavor> (managed) >>> ... <<<` block in
# <targetRoot>/.gitignore (project-scoped installs only). See install.ps1 for full rationale.
function Set-ManagedGitignoreBlock($targetRoot, $flavor, [string[]]$ignoreLines, [string[]]$exceptionLines, $check) {
    $ignPath = Join-Path $targetRoot ".gitignore"
    $begin = "# >>> aiworkflow $flavor (managed) >>>"
    $end   = "# <<< aiworkflow $flavor (managed) <<<"
    $bodyLines = @($ignoreLines) + @($exceptionLines | ForEach-Object { "!$_" })
    $block = @($begin) + $bodyLines + @($end)

    $existing = if (Test-Path $ignPath) { [System.IO.File]::ReadAllText($ignPath) } else { "" }
    $lines = if ($existing -ne "") { ($existing -replace "`r`n","`n") -split "`n" } else { @() }

    $startIdx = -1; $endIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -eq $begin -and $startIdx -lt 0) { $startIdx = $i }
        elseif ($lines[$i] -eq $end -and $startIdx -ge 0 -and $endIdx -lt 0) { $endIdx = $i }
    }

    if ($startIdx -ge 0 -and $endIdx -ge $startIdx) {
        $before = if ($startIdx -gt 0) { @($lines[0..($startIdx - 1)]) } else { @() }
        $after  = if ($endIdx -lt $lines.Count - 1) { @($lines[($endIdx + 1)..($lines.Count - 1)]) } else { @() }
        $newLines = @($before) + @($block) + @($after)
    } elseif ($lines.Count -gt 0) {
        $newLines = @($lines) + @("") + @($block)
    } else {
        $newLines = @($block)
    }
    $newText = (($newLines -join "`n").TrimEnd() + "`n")
    $existingNorm = if ($existing -ne "") { (($existing -replace "`r`n","`n").TrimEnd() + "`n") } else { "" }

    if ($check) {
        $state = if ($existingNorm -ne $newText) { "would change" } else { "in sync" }
        Write-Host ("[check] .gitignore ({0} block): {1}" -f $flavor, $state)
    } else {
        [System.IO.File]::WriteAllText($ignPath, $newText, (New-Object System.Text.UTF8Encoding $false))
        Write-Host ("[sync] .gitignore ({0} managed block)" -f $flavor)
    }
}

Write-Host "flavor: claude-code" -ForegroundColor Cyan
Write-Host "canon:  $src"
Write-Host "dest:   $dest  ($(if ($projectScoped){'project-scoped'}else{'global'}))"

# node is required at run time by the PreToolUse hook (command-hook.ts) and the L1-L3
# rails (rails/cli.ts) - both run via `node <script>.ts` (native TS strip, Node >=22.6/23) -
# and now ALSO at install-time to render canon agents (A3 req 2) - hard requirement, no
# silent fallback (a missing/broken node must abort the installer, not skip agents).
$nodeVersion = $null
try { $nodeVersion = (& node --version) 2>$null } catch { $nodeVersion = $null }
if (-not $nodeVersion) {
    throw "node not found on PATH - required to render canon agents (core/src/render/cli.ts) and by the PreToolUse hook/rails at run time (native TS strip, Node >=22.6 or >=23)."
} else {
    Write-Host "node:   $nodeVersion"
}
Write-Host ""

$runtimeTs = Join-Path $repo 'tools\install-runtime.ts'
$destFwd = ($dest -replace '\\', '/')

function Invoke-InstallRuntime {
    param([Parameter(Mandatory = $true)][string[]]$RtArgs)
    $out = & node $runtimeTs @RtArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("install-runtime failed ({0}): {1}" -f $LASTEXITCODE, ($out | Out-String))
    }
    foreach ($line in @($out)) {
        if (("$line").Trim().Length -gt 0) { Write-Host $line }
    }
}

if (-not $Check) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
if ($Check) {
    Write-Host ("[check] would vendor core/src -> {0}/core/src" -f $destFwd)
} else {
    Invoke-InstallRuntime @('vendor', '--repo', $repo, '--dest', $dest)
}


# --- 1. agents/: render canon fresh (A3 req 2 - never install from a committed port copy) ---
$renderTmp = Join-Path $env:TEMP ("aiwf-render-claude-" + [guid]::NewGuid().ToString("N"))
try {
    $rendererScript = Join-Path $repo 'core\src\render\cli.ts'
    $renderOut = & node $rendererScript render --out $renderTmp --clients claude --canon $canonRoleRoot --adapters $adaptersRoot 2>&1
    if ($LASTEXITCODE -ne 0) { throw "canon render failed (exit $LASTEXITCODE): $renderOut" }

    $agentsSrc = Join-Path $renderTmp '.claude\agents'
    $agentsDst = Join-Path $dest 'agents'
    if (Test-Path $agentsSrc) {
        if (-not $projectScoped) {
            # Global: full mirror (delete stale) - same semantics this installer always had.
            if ($Check) {
                $chg = robocopy $agentsSrc $agentsDst /MIR /L /NJH /NJS /NDL /NP /NC /NS
                Write-Host ("[check] agents: {0} file(s) would change" -f (($chg | Where-Object { $_.Trim() -ne '' }).Count))
            } else {
                robocopy $agentsSrc $agentsDst /MIR /NJH /NJS /NDL /NP /NC /NS | Out-Null
                if ($LASTEXITCODE -ge 8) { throw "robocopy agents failed ($LASTEXITCODE)" }
                Write-Host "[sync] agents/ mirrored (rendered from canon)"
            }
        } else {
            # Project: OVERLAY - never delete a project's own extra agents/*.md (A3 req 4).
            # -KeepAgents freezes ANY file already present at dest (canon-named or not).
            if (-not $Check) { New-Item -ItemType Directory -Force -Path $agentsDst | Out-Null }
            $changed = 0
            foreach ($f in Get-ChildItem $agentsSrc -Filter *.md) {
                $outFile = Join-Path $agentsDst $f.Name
                $exists = Test-Path $outFile
                $canonAgentNames += $f.Name
                if ($exists -and $KeepAgents) {
                    if (-not (Test-SameAgentContent $f.FullName $outFile)) { $keptAgentOverlayNames += $f.Name }
                    continue
                }
                if ($Check) {
                    $same = $exists -and ((Get-FileHash $f.FullName).Hash -eq (Get-FileHash $outFile).Hash)
                    if (-not $same) { $changed++ }
                } else {
                    Copy-Item $f.FullName $outFile -Force
                }
            }
            if ($Check) { Write-Host ("[check] agents/ (project overlay): {0} file(s) would change" -f $changed) }
            else        { Write-Host "[sync] agents/ overlaid from rendered canon (project extras kept)" }
        }
    }
} finally {
    Remove-Item -Recurse -Force $renderTmp -ErrorAction SilentlyContinue
}

# --- 2. commands/ (rewrite core refs -> absolute path inside dest) ---
$cmdSrc = Join-Path $src 'commands'
$cmdDst = Join-Path $dest 'commands'
if (Test-Path $cmdSrc) {
    if (-not $Check) { New-Item -ItemType Directory -Force -Path $cmdDst | Out-Null }
    $cmdFiles = @()
    foreach ($f in Get-ChildItem $cmdSrc -Filter *.md) {
        $body = Get-Content $f.FullName -Encoding UTF8 -Raw
        # Legacy python tools path (retired rails) - leave repo tools if still present.
        $body = [regex]::Replace($body, 'python tools/(\S+\.py)', ('python "' + $repoFwd + '/tools/$1"'))
        # Core rails/hooks: dest abs (cwd-resolved host), not clone.
        $body = $body.Replace('$CLAUDE_PROJECT_DIR/core/', ($destFwd + '/core/'))
        $out  = Join-Path $cmdDst $f.Name
        if ($Check) {
            $cur = if (Test-Path $out) { Get-Content $out -Encoding UTF8 -Raw } else { '' }
            Write-Host ("[check] commands/{0}: {1}" -f $f.Name, $(if ($cur -ne $body) { 'would change' } else { 'in sync' }))
        } else {
            [System.IO.File]::WriteAllText($out, $body, (New-Object System.Text.UTF8Encoding $false))
            $cmdFiles += $out
        }
    }
    if (-not $Check) {
        if ($cmdFiles.Count -gt 0) {
            $rcArgs = @('rewrite-commands', '--dest', $dest, '--clone-root', $repo)
            foreach ($cf in $cmdFiles) { $rcArgs += @('--file', $cf) }
            Invoke-InstallRuntime $rcArgs
        }
        Write-Host "[sync] commands/ (tool paths -> dest)"
    }
}

# --- 3. settings.json MERGE (hooks + permissions.deny; preserve existing keys) ---
$setDst = Join-Path $dest 'settings.json'
$hookCmd = 'node "' + $destFwd + '/core/src/shim/command-hook.ts" claude'
$tel     = 'node "' + $destFwd + '/core/src/ops/telemetry-hook.ts"'

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

# hooks (dedupe by tag substrings so re-run REPLACES a stale entry instead of duplicating -
# 'zone-guard' catches the old python hook, 'command-hook' catches a prior TS install).
# Matcher = required ∪ displaced group's matcher so reinstall never strips tokens
# (e.g. PowerShell or an extra tool X already recorded).
$hooks = Ensure-Prop $cfg 'hooks' ([pscustomobject]@{})
function Union-Matcher([string]$Required, [string]$Existing = '') {
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($raw in @($Required, $Existing)) {
        if ([string]::IsNullOrWhiteSpace($raw)) { continue }
        foreach ($tok in ($raw -split '\|')) {
            $t = $tok.Trim()
            if ($t.Length -eq 0) { continue }
            if ($seen.Add($t)) { [void]$out.Add($t) }
        }
    }
    return ($out -join '|')
}
function Set-HookGroup($hooksObj, $event, $matcher, $cmd, $tags) {
    $arr = @()
    $displacedMatchers = @()
    if ($hooksObj.PSObject.Properties.Name -contains $event) {
        foreach ($grp in @($hooksObj.$event)) {
            $hit = $false
            foreach ($h in @($grp.hooks)) {
                $hc = "$($h.command)"
                foreach ($tag in $tags) {
                    if ($hc -like "*$tag*") { $hit = $true; break }
                }
                if ($hit) { break }
            }
            if ($hit) {
                if ($null -ne $grp.matcher -and "$($grp.matcher)" -ne '') {
                    $displacedMatchers += "$($grp.matcher)"
                }
            } else {
                $arr += $grp
            }
        }
    }
    $finalMatcher = $matcher
    foreach ($m in $displacedMatchers) {
        $finalMatcher = Union-Matcher $finalMatcher $m
    }
    $arr += [pscustomobject]@{ matcher = $finalMatcher; hooks = @([pscustomobject]@{ type = 'command'; command = $cmd }) }
    if ($hooksObj.PSObject.Properties.Name -contains $event) { $hooksObj.$event = $arr }
    else { $hooksObj | Add-Member -NotePropertyName $event -NotePropertyValue $arr }
}
Set-HookGroup $hooks 'PreToolUse'  'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit' $hookCmd @('zone-guard', 'command-hook')
Set-HookGroup $hooks 'PostToolUse' ''                                        $tel     @('telemetry')

$json = $cfg | ConvertTo-Json -Depth 20
if ($Check) {
    $cur = if (Test-Path $setDst) { Get-Content $setDst -Encoding UTF8 -Raw } else { '' }
    Write-Host ("[check] settings.json: {0}" -f $(if ($cur.Trim() -ne $json.Trim()) { 'would change (hooks/deny merged)' } else { 'in sync' }))
} else {
    [System.IO.File]::WriteAllText($setDst, $json, (New-Object System.Text.UTF8Encoding $false))
    Invoke-InstallRuntime @('rewrite-commands', '--dest', $dest, '--file', $setDst, '--clone-root', $repo)
    Write-Host "[sync] settings.json (hooks + permissions.deny merged, existing keys preserved)"
}

# --- 4. AGENTS.md (project-scoped only; global install skips it to avoid ambient rules) ---
$agentsMdSrc = Join-Path $repo 'AGENTS.md'
if ($projectScoped -and (Test-Path $agentsMdSrc)) {
    $agentsMdDst = Join-Path $Target 'AGENTS.md'
    if ($Check) {
        Write-Host ("[check] AGENTS.md: {0}" -f $(if (Test-Path $agentsMdDst) { 'exists (will NOT overwrite)' } else { 'would create' }))
    } elseif (Test-Path $agentsMdDst) {
        Write-Host "[keep] AGENTS.md exists in target - not overwritten" -ForegroundColor DarkGray
    } else {
        Copy-Item $agentsMdSrc $agentsMdDst
        Write-Host "[sync] AGENTS.md -> target project"
    }
}

# --- 5. Project .gitignore managed block (A3b, project-scoped ONLY) ---
# Ignores installed FLAVOR artifacts (commands/, settings.json + canon-named agents/*.md); never
# ignores project data (a canon-named overlay -KeepAgents froze gets an explicit `!` exception;
# AGENTS.md is a project-owned seed, never touched here).
if ($projectScoped) {
    $ignoreLines = @('.claude/commands/', '.claude/settings.json')
    foreach ($n in $canonAgentNames) { $ignoreLines += ".claude/agents/$n" }
    $exceptionLines = @()
    foreach ($n in $keptAgentOverlayNames) { $exceptionLines += ".claude/agents/$n" }
    Set-ManagedGitignoreBlock $Target 'claude' $ignoreLines $exceptionLines $Check
}

Write-Host ""
if ($Check) {
    Write-Host "CHECK done (nothing written)." -ForegroundColor Cyan
} else {
    Write-Host "CLAUDE-CODE flavor installed." -ForegroundColor Green
    if (-not $projectScoped) {
        Write-Host "  Global: agents+commands+hooks live in ~/.claude and every project." -ForegroundColor DarkGray
        Write-Host "  Per-project lead protocol: copy $repo\AGENTS.md into a project as AGENTS.md (opt-in)." -ForegroundColor DarkGray
    }
    Write-Host "  Governance: the hook/rails read <target-project-cwd>/policy.yml (git-tracked, per-project)." -ForegroundColor DarkGray
    Write-Host "  No policy.yml in a target project -> NOT deny-all: falls back to profile 'assist' (interactive) or 'guarded' (headless/CI)." -ForegroundColor DarkGray
    Write-Host "  That default is a reasonable fail-closed floor, not a copy of this repo's own policy.yml (repo-specific quality_gate.cmd/protected paths) -" -ForegroundColor DarkGray
    Write-Host "  copy $repo\policy.yml into a target project yourself and adjust it if you want the guarded-with-protected-extras profile this repo runs." -ForegroundColor DarkGray
    Write-Host "  Reload Claude Code (restart session) for settings.json hooks to take effect." -ForegroundColor Yellow
}

<#
.SYNOPSIS
  Install the AI Workflow CURSOR flavor (agents + skills + hooks.json + lead protocol).

.DESCRIPTION
  Cursor port (docs/design/cursor-port-2026-10-28.md). Deploys the .cursor layer so Cursor
  sees subagents, skills and native hooks.json.

  Default target = user-global ~/.cursor. -Target <dir> stamps into <dir>/.cursor
  (project-scoped).

  Templates in the repo keep the literal token <clone>. On install, Rewrite-Clone replaces
  every <clone> with the ABSOLUTE path inside <dest> (hooks.json + skills + agents) after
  core/src is vendored into dest. Hook command becomes node "<dest>/core/src/shim/...".

  Agents/*.md are NOT copied from a committed port copy: every install renders
  canon/roles + tools/adapters/cursor.yml into a temp dir
  (node core/src/render/cli.ts render --out <tmp> --clients cursor) and installs FROM THAT
  RENDER. Missing/broken node aborts. Global mirrors (delete stale); project OVERLAYS;
  -KeepAgents freezes any agents/*.md already at dest.

  Lead protocol: root AGENTS.md = SSOT (project-scoped seed if-absent).
  Rule file tools/templates/lead-protocol.md -> .cursor/rules/aiwf-lead.mdc
  (if-absent short include; rule must not duplicate body).

  ASCII-only on purpose (PS 5.1 parses .ps1 as cp1251 without a BOM).

.PARAMETER Check   Dry-run: report what would change, write nothing.
.PARAMETER Target  Project dir for a project-scoped install (default: global ~/.cursor).
.PARAMETER KeepAgents  Project-scoped only: never overwrite an agents/*.md already at dest.
#>
[CmdletBinding()]
param([switch]$Check, [string]$Target = '', [switch]$KeepAgents)

$ErrorActionPreference = 'Stop'
$repo    = Split-Path -Parent $PSScriptRoot
$src     = Join-Path $repo 'ports\cursor'
$repoFwd = ($repo -replace '\\','/')
$canonRoleRoot = Join-Path $repo 'canon'
$adaptersRoot  = Join-Path $repo 'tools\adapters'
$leadTpl       = Join-Path $repo 'tools\templates\lead-protocol.md'
$agentsMdSrc   = Join-Path $repo 'AGENTS.md'
if (-not (Test-Path $src)) { throw "canon ports/cursor not found: $src" }

$projectScoped = [bool]$Target
$dest = if ($projectScoped) { Join-Path $Target '.cursor' } else { Join-Path $HOME '.cursor' }
$canonAgentNames = @()
$keptAgentOverlayNames = @()

function Test-SameAgentContent($srcFile, $dstFile) {
    if (-not (Test-Path $dstFile)) { return $false }
    $a = (Get-Content $srcFile -Raw -Encoding UTF8) -replace "`r`n","`n"
    $b = (Get-Content $dstFile -Raw -Encoding UTF8) -replace "`r`n","`n"
    return $a -eq $b
}

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

function Rewrite-Clone([string]$text) {
    # <clone> -> dest abs (not repo). rewrite-commands also heals leftover clone roots.
    return $text.Replace('<clone>', $destFwd)
}

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

Write-Host "flavor: cursor" -ForegroundColor Cyan
Write-Host "canon:  $src"
Write-Host "dest:   $dest  ($(if ($projectScoped){'project-scoped'}else{'global'}))"

$nodeVersion = $null
try { $nodeVersion = (& node --version) 2>$null } catch { $nodeVersion = $null }
if (-not $nodeVersion) {
    throw "node not found on PATH - required to render canon agents (core/src/render/cli.ts) and by hooks/rails at run time (native TS strip, Node >=22.6 or >=23)."
} else {
    Write-Host "node:   $nodeVersion"
}
Write-Host ""

if (-not $Check) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }
if ($Check) {
    Write-Host ("[check] would vendor core/src -> {0}/core/src" -f $destFwd)
} else {
    Invoke-InstallRuntime @('vendor', '--repo', $repo, '--dest', $dest)
}


# --- 1. agents/: render canon fresh ---
$renderTmp = Join-Path $env:TEMP ("aiwf-render-cursor-" + [guid]::NewGuid().ToString("N"))
try {
    $rendererScript = Join-Path $repo 'core\src\render\cli.ts'
    $renderOut = & node $rendererScript render --out $renderTmp --clients cursor --canon $canonRoleRoot --adapters $adaptersRoot 2>&1
    if ($LASTEXITCODE -ne 0) { throw "canon render failed (exit $LASTEXITCODE): $renderOut" }

    $agentsSrc = Join-Path $renderTmp '.cursor\agents'
    $agentsDst = Join-Path $dest 'agents'
    if (Test-Path $agentsSrc) {
        if (-not $projectScoped) {
            if ($Check) {
                $chg = robocopy $agentsSrc $agentsDst /MIR /L /NJH /NJS /NDL /NP /NC /NS
                Write-Host ("[check] agents: {0} file(s) would change" -f (($chg | Where-Object { $_.Trim() -ne '' }).Count))
            } else {
                robocopy $agentsSrc $agentsDst /MIR /NJH /NJS /NDL /NP /NC /NS | Out-Null
                if ($LASTEXITCODE -ge 8) { throw "robocopy agents failed ($LASTEXITCODE)" }
                Write-Host "[sync] agents/ mirrored (rendered from canon)"
            }
        } else {
            if (-not $Check) { New-Item -ItemType Directory -Force -Path $agentsDst | Out-Null }
            $changed = 0
            foreach ($f in Get-ChildItem $agentsSrc -Filter *.md) {
                $outFile = Join-Path $agentsDst $f.Name
                $exists = Test-Path $outFile
                $canonAgentNames += $f.Name
                $body = Rewrite-Clone (Get-Content $f.FullName -Encoding UTF8 -Raw)
                if ($exists -and $KeepAgents) {
                    if (-not (Test-SameAgentContent $f.FullName $outFile)) { $keptAgentOverlayNames += $f.Name }
                    continue
                }
                if ($Check) {
                    $cur = if ($exists) { Get-Content $outFile -Encoding UTF8 -Raw } else { '' }
                    if ($cur -ne $body) { $changed++ }
                } else {
                    [System.IO.File]::WriteAllText($outFile, $body, (New-Object System.Text.UTF8Encoding $false))
                }
            }
            if ($Check) { Write-Host ("[check] agents/ (project overlay): {0} file(s) would change" -f $changed) }
            else        { Write-Host "[sync] agents/ overlaid from rendered canon (project extras kept)" }
        }
        # Global mirror: still rewrite <clone> inside rendered agents after robocopy
        if (-not $projectScoped -and -not $Check -and (Test-Path $agentsDst)) {
            foreach ($f in Get-ChildItem $agentsDst -Filter *.md) {
                $body = Rewrite-Clone (Get-Content $f.FullName -Encoding UTF8 -Raw)
                [System.IO.File]::WriteAllText($f.FullName, $body, (New-Object System.Text.UTF8Encoding $false))
            }
        }
    }
} finally {
    Remove-Item -Recurse -Force $renderTmp -ErrorAction SilentlyContinue
}

# --- 2. skills/ (rewrite <clone> -> absolute dest path) ---
$skillsSrc = Join-Path $src 'skills'
$skillsDst = Join-Path $dest 'skills'
$cmdRewriteFiles = New-Object System.Collections.Generic.List[string]
if (Test-Path $skillsSrc) {
    if (-not $Check) { New-Item -ItemType Directory -Force -Path $skillsDst | Out-Null }
    foreach ($dir in Get-ChildItem $skillsSrc -Directory) {
        $skillFile = Join-Path $dir.FullName 'SKILL.md'
        if (-not (Test-Path $skillFile)) { continue }
        $body = Rewrite-Clone (Get-Content $skillFile -Encoding UTF8 -Raw)
        $outDir = Join-Path $skillsDst $dir.Name
        $out = Join-Path $outDir 'SKILL.md'
        if ($Check) {
            $cur = if (Test-Path $out) { Get-Content $out -Encoding UTF8 -Raw } else { '' }
            Write-Host ("[check] skills/{0}/SKILL.md: {1}" -f $dir.Name, $(if ($cur -ne $body) { 'would change' } else { 'in sync' }))
        } else {
            New-Item -ItemType Directory -Force -Path $outDir | Out-Null
            [System.IO.File]::WriteAllText($out, $body, (New-Object System.Text.UTF8Encoding $false))
            [void]$cmdRewriteFiles.Add($out)
        }
    }
    if (-not $Check) { Write-Host "[sync] skills/ (<clone> -> dest)" }
}

# --- 3. hooks.json (rewrite <clone> -> dest) ---
$hooksSrc = Join-Path $src 'hooks.json'
$hooksDst = Join-Path $dest 'hooks.json'
if (Test-Path $hooksSrc) {
    $body = Rewrite-Clone (Get-Content $hooksSrc -Encoding UTF8 -Raw)
    if ($Check) {
        $cur = if (Test-Path $hooksDst) { Get-Content $hooksDst -Encoding UTF8 -Raw } else { '' }
        Write-Host ("[check] hooks.json: {0}" -f $(if ($cur.Trim() -ne $body.Trim()) { 'would change' } else { 'in sync' }))
    } else {
        [System.IO.File]::WriteAllText($hooksDst, $body, (New-Object System.Text.UTF8Encoding $false))
        [void]$cmdRewriteFiles.Add($hooksDst)
        Write-Host "[sync] hooks.json (<clone> -> dest)"
    }
}

# Heal any leftover clone-root refs in written command files + agents.
if (-not $Check) {
    $agentsDst = Join-Path $dest 'agents'
    if (Test-Path $agentsDst) {
        Get-ChildItem $agentsDst -Filter *.md -File -ErrorAction SilentlyContinue | ForEach-Object {
            [void]$cmdRewriteFiles.Add($_.FullName)
        }
    }
    if ($cmdRewriteFiles.Count -gt 0) {
        $rcArgs = @('rewrite-commands', '--dest', $dest, '--clone-root', $repo)
        foreach ($cf in $cmdRewriteFiles) { $rcArgs += @('--file', $cf) }
        Invoke-InstallRuntime $rcArgs
    }
}


# --- 4. Lead: root AGENTS.md = SSOT (project-scoped if-absent); rule is short include, must not duplicate body ---
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

if (Test-Path $leadTpl) {
    $rulesDir = Join-Path $dest 'rules'
    $leadDst = Join-Path $rulesDir 'aiwf-lead.mdc'
    $leadBody = Rewrite-Clone (Get-Content $leadTpl -Encoding UTF8 -Raw)
    if ($Check) {
        Write-Host ("[check] rules/aiwf-lead.mdc: {0}" -f $(if (Test-Path $leadDst) { 'exists (will NOT overwrite)' } else { 'would create' }))
    } elseif (Test-Path $leadDst) {
        Write-Host "[keep] rules/aiwf-lead.mdc exists - not overwritten" -ForegroundColor DarkGray
    } else {
        New-Item -ItemType Directory -Force -Path $rulesDir | Out-Null
        [System.IO.File]::WriteAllText($leadDst, $leadBody, (New-Object System.Text.UTF8Encoding $false))
        Write-Host "[sync] rules/aiwf-lead.mdc (short AGENTS.md include, if-absent)"
    }
}

# --- 5. Project .gitignore managed block (A3b, project-scoped ONLY) ---
if ($projectScoped) {
    $ignoreLines = @('.cursor/skills/', '.cursor/hooks.json')
    foreach ($n in $canonAgentNames) { $ignoreLines += ".cursor/agents/$n" }
    $exceptionLines = @()
    foreach ($n in $keptAgentOverlayNames) { $exceptionLines += ".cursor/agents/$n" }
    Set-ManagedGitignoreBlock $Target 'cursor' $ignoreLines $exceptionLines $Check
}

Write-Host ""
if ($Check) {
    Write-Host "CHECK done (nothing written)." -ForegroundColor Cyan
} else {
    Write-Host "CURSOR flavor installed." -ForegroundColor Green
    if (-not $projectScoped) {
        Write-Host "  Global: agents+skills+hooks live in ~/.cursor." -ForegroundColor DarkGray
        Write-Host "  Per-project lead protocol: copy $repo\AGENTS.md into a project as AGENTS.md (opt-in); rule is a short include." -ForegroundColor DarkGray
    }
    Write-Host "  Governance: hook/rails read <target-project-cwd>/policy.yml." -ForegroundColor DarkGray
    Write-Host "  Reload Cursor (restart Agent session) for hooks.json to take effect." -ForegroundColor Yellow
}

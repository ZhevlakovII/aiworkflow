<#
.SYNOPSIS
  Install the AI Workflow OPENCODE flavor (TS tools + plugins + agents + commands + opencode.json).

.DESCRIPTION
  OpenCode port of the flow (docs/design/omp-to-opencode-port-2026-09-08.md). Deploys the .opencode
  layer so OpenCode (TUI/Desktop) auto-discovers custom-tools, plugins, subagents and slash-commands.

  Default target = user-global ~/.config/opencode. -Target <dir> stamps <dir>/.opencode (project-scoped)
  and writes <dir>/opencode.json.

  TS tools use PATH binaries (git/gh/claude/opencode/codex/ast-index) at run time -> no rewrite
  needed for those. BUT .opencode/lib/*.ts re-export from core/src/... via relative imports
  ((../)+core/src/...). Install vendors core/src into <dest>/core/src and rewrites those
  imports file-relative via tools/install-runtime.ts (not absolute clone). opencode.json is
  MERGED (permission + instructions spliced, existing user keys preserved). tools/plugins/lib/commands
  are full mirrors. Idempotent.

  agents/*.md are NOT copied verbatim from `ports/opencode/agents` (A3 req 2):
  every install renders `canon/roles` + `tools/adapters/opencode.yml` into a fresh temp dir (`node
  core/src/render/cli.ts render --out <tmp> --clients opencode`) and installs FROM THAT RENDER - a
  broken/missing node aborts the installer, no silent fallback. agents/ is OVERLAID (never deletes
  the user's/project's own extra agents/*.md); -KeepAgents freezes any file already present at dest
  (A3 req 4).

  zonemap.yml/delegation.yml are project-scoped ONLY (A3 req 3): seeded from the canon SKELETON
  (`canon/{zonemap,delegation}.yml`) ONLY if the project doesn't already have one - an existing file
  is NEVER overwritten. Global mode installs neither (this repo's own filled `.opencode/{zonemap,
  delegation}.yml` are FinManage's product data, never copied by this installer).

  ASCII-only on purpose (PS 5.1 parses .ps1 as cp1251 without a BOM).

.PARAMETER Check   Dry-run: report what would change, write nothing.
.PARAMETER Target  Project dir for a project-scoped install (default: global ~/.config/opencode).
.PARAMETER KeepAgents  Never overwrite an agents/*.md already at dest (freezes a customized overlay).
#>
[CmdletBinding()]
param([switch]$Check, [string]$Target = '', [switch]$KeepAgents)

$ErrorActionPreference = 'Stop'
$repo    = Split-Path -Parent $PSScriptRoot
$repoFwd = ($repo -replace '\\','/')
$src     = Join-Path $repo 'ports\opencode'
$srcJson = Join-Path $repo 'ports\opencode\opencode.json'
if (-not (Test-Path $src))     { throw "ports/opencode not found: $src" }
if (-not (Test-Path $srcJson)) { throw "ports/opencode/opencode.json not found: $srcJson" }

$projectScoped = [bool]$Target
if ($projectScoped) {
    $dest = Join-Path $Target '.opencode'; $jsonDst = Join-Path $Target 'opencode.json'
} else {
    $cfgRoot = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME '.config' }
    $dest = Join-Path $cfgRoot 'opencode'; $jsonDst = Join-Path $dest 'opencode.json'
}
$agentsDst = Join-Path $dest 'AGENTS.md'
# Tracked while walking the agents-overlay loop below (A3b): see install.ps1 for rationale.
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

Write-Host "flavor: opencode" -ForegroundColor Cyan
Write-Host "ports/opencode SRC:  $src"
Write-Host "dest:   $dest  ($(if ($projectScoped){'project-scoped'}else{'global'}))`n"

if (-not $Check) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }

# Vendor + rewrite-imports via install-runtime (ADR AD-runtime-per-dest-vendor).
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

function Invoke-AiwfVendor {
    if ($Check) {
        Write-Host ("[check] would vendor core/src -> {0}/core/src" -f $destFwd)
    } else {
        Invoke-InstallRuntime @('vendor', '--repo', $repo, '--dest', $dest)
    }
}

function New-ImportRewrittenShadow([string]$srcDir, [string]$relUnder) {
    $shadowRoot = Join-Path $env:TEMP ("aiwf-install-" + [guid]::NewGuid().ToString('N'))
    $shadowSub = Join-Path $shadowRoot $relUnder
    $parent = Split-Path -Parent $shadowSub
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -Recurse -Force $srcDir $shadowSub
    Invoke-InstallRuntime @('rewrite-imports', '--dest', $shadowRoot, '--under', $shadowSub)
    return @{ Root = $shadowRoot; Sub = $shadowSub }
}

Invoke-AiwfVendor

# --- 1a. full-mirror subtrees (ours: safe to delete stale within) ---
$oursDirs = @('tools', 'plugins', 'lib', 'commands')
foreach ($t in $oursDirs) {
    $s = Join-Path $src $t; $d = Join-Path $dest $t
    if (-not (Test-Path $s)) { continue }
    $shaped = New-ImportRewrittenShadow $s $t
    try {
        if ($Check) {
            $chg = robocopy $shaped.Sub $d /MIR /L /NJH /NJS /NDL /NP /NC /NS
            Write-Host ("[check] {0}/: {1} file(s) would change" -f $t, (($chg | Where-Object { $_.Trim() -ne '' }).Count))
        } else {
            robocopy $shaped.Sub $d /MIR /NJH /NJS /NDL /NP /NC /NS | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "robocopy $t failed ($LASTEXITCODE)" }
            Write-Host "[sync] $t/ mirrored"
        }
    } finally {
        Remove-Item -Recurse -Force $shaped.Root -ErrorAction SilentlyContinue
    }
}
if (-not $Check) {
    $underArgs = @('rewrite-imports', '--dest', $dest)
    foreach ($t in $oursDirs) {
        $p = Join-Path $dest $t
        if (Test-Path $p) { $underArgs += @('--under', $p) }
    }
    if ($underArgs.Count -gt 3) { Invoke-InstallRuntime $underArgs }
}

# --- 1b. agents/: render canon fresh, OVERLAY (shared with user agents -> copy ours,
# keep theirs; never delete). A3 req 2: NOT from ports/opencode/agents -
# every install renders `canon/roles` + `tools/adapters/opencode.yml` into a fresh temp
# dir (a broken/missing node aborts the installer, no silent fallback). -KeepAgents
# (project-scoped use) freezes any file already present at dest (A3 req 4).
$nodeExe = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeExe) { throw "node not found on PATH - required to render canon agents (core/src/render/cli.ts)" }

$renderTmp = Join-Path $env:TEMP ("aiwf-render-opencode-" + [guid]::NewGuid().ToString("N"))
try {
    $rendererScript = Join-Path $repo 'core\src\render\cli.ts'
    $canonRoleRoot = Join-Path $repo 'canon'
    $adaptersRoot  = Join-Path $repo 'tools\adapters'
    $renderOut = & node $rendererScript render --out $renderTmp --clients opencode --canon $canonRoleRoot --adapters $adaptersRoot 2>&1
    if ($LASTEXITCODE -ne 0) { throw "canon render failed (exit $LASTEXITCODE): $renderOut" }

    $agentsSrc = Join-Path $renderTmp '.opencode\agents'
    $agentsDirDst = Join-Path $dest 'agents'
    if (Test-Path $agentsSrc) {
        if (-not $Check) { New-Item -ItemType Directory -Force -Path $agentsDirDst | Out-Null }
        $changed = 0
        foreach ($f in Get-ChildItem $agentsSrc -Filter *.md) {
            $outFile = Join-Path $agentsDirDst $f.Name
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
        if ($Check) { Write-Host ("[check] agents/ (overlay): {0} file(s) would change" -f $changed) }
        else        { Write-Host "[sync] agents/ overlaid from rendered canon (user/project files kept)" }
    }
} finally {
    Remove-Item -Recurse -Force $renderTmp -ErrorAction SilentlyContinue
}

# --- 1b2. Port-static oneshot agents (AD-opencode-native-oneshot) after live render ---
$agentsDirDst = Join-Path $dest 'agents'
$staticAgents = @('aiwf-oneshot.md', 'aiwf-reason.md')
$staticChanged = 0
foreach ($name in $staticAgents) {
    $s = Join-Path $src ("agents\$name")
    if (-not (Test-Path $s)) { continue }
    $outFile = Join-Path $agentsDirDst $name
    $exists = Test-Path $outFile
    if ($exists -and $KeepAgents) {
        if (-not (Test-SameAgentContent $s $outFile)) { $keptAgentOverlayNames += $name }
        continue
    }
    if ($Check) {
        $same = $exists -and ((Get-FileHash $s).Hash -eq (Get-FileHash $outFile).Hash)
        if (-not $same) { $staticChanged++ }
    } else {
        if (-not (Test-Path $agentsDirDst)) { New-Item -ItemType Directory -Force -Path $agentsDirDst | Out-Null }
        Copy-Item $s $outFile -Force
    }
}
if ($Check) { Write-Host ("[check] agents/ (oneshot static): {0} file(s) would change" -f $staticChanged) }
elseif ($staticAgents.Count -gt 0) { Write-Host "[sync] agents/ oneshot static (aiwf-oneshot, aiwf-reason)" }


# --- 1c. AGENTS.md (top-level, both modes; verbatim from ports/opencode) ---
$agentsMd = 'AGENTS.md'
$sAgentsMd = Join-Path $src $agentsMd; $dAgentsMd = Join-Path $dest $agentsMd
if (Test-Path $sAgentsMd) {
    if ($Check) {
        $same = (Test-Path $dAgentsMd) -and ((Get-Content $sAgentsMd -Raw) -eq (Get-Content $dAgentsMd -Raw))
        Write-Host ("[check] {0}: {1}" -f $agentsMd, $(if ($same) { 'in sync' } else { 'would change' }))
    } else {
        Copy-Item $sAgentsMd $dAgentsMd -Force
        Write-Host "[sync] $agentsMd"
    }
}

# --- 1d. Project config seed: delegation.yml only (zonemap NOT seeded) (project-scoped ONLY, A3 req 3) ---
# Seeded from the canon SKELETON (`canon/{zonemap,delegation}.yml`), NEVER from this repo's
# own filled `.opencode/{zonemap,delegation}.yml` (FinManage's product data, not installer
# payload - copying those would clobber a real project config with an empty canon skeleton
# on every re-run). An existing project file is NEVER overwritten. Global mode installs neither.
if ($projectScoped) {
    $canonRoleRootCfg = Join-Path $repo 'canon'
    foreach ($cfgName in @('delegation')) {
        $s = Join-Path $canonRoleRootCfg "$cfgName.yml"
        $d = Join-Path $dest "$cfgName.yml"
        if (Test-Path $d) {
            $tag = if ($Check) { 'check' } else { 'keep' }
            Write-Host ("[{0}] {1}.yml: exists - kept (never overwritten)" -f $tag, $cfgName)
        } elseif ($Check) {
            Write-Host ("[check] {0}.yml: ABSENT -> would seed from canon skeleton" -f $cfgName)
        } else {
            Copy-Item $s $d
            Write-Host ("[sync] {0}.yml <- canon skeleton (seeded; fill in-project)" -f $cfgName)
        }
    }
}

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

# --- 3. Project .gitignore managed block (A3b, project-scoped ONLY) ---
# Ignores installed FLAVOR artifacts (tools/plugins/lib/commands, AGENTS.md, opencode.json, canon-
# named agents/*.md); never ignores project data (zonemap.yml/delegation.yml, non-canon agent
# overlays, or a canon-named overlay -KeepAgents froze - explicit `!` exception above).
if ($projectScoped) {
    $ignoreLines = @('.opencode/tools/', '.opencode/plugins/', '.opencode/lib/', '.opencode/commands/', '.opencode/AGENTS.md', 'opencode.json')
    foreach ($n in $canonAgentNames) { $ignoreLines += ".opencode/agents/$n" }
    $exceptionLines = @()
    foreach ($n in $keptAgentOverlayNames) { $exceptionLines += ".opencode/agents/$n" }
    Set-ManagedGitignoreBlock $Target 'opencode' $ignoreLines $exceptionLines $Check
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

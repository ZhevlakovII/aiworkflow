<#
.SYNOPSIS
  Install AI Workflow flow-layer from canon into OMP — global (~/.omp/agent) or
  project-scoped (<Target>/.omp), same unified -Target interface as install-claude.ps1
  / install-opencode.ps1 (A3).

.DESCRIPTION
  Canon = two sources: `<repo>/ports/omp` (tools/hooks/RULES/AGENTS/WATCHDOG/config.yml —
  non-role product code, copied verbatim) and `<repo>/canon` (role definitions +
  zonemap/delegation SKELETON, rendered/seeded, never copied verbatim — A3 req 2/3).
  Installer:
    1) mirrors tools/ hooks/ (robocopy /MIR - removes stale files; copied .ts files
       importing `(../)+core/src/...` (e.g. tools/_lib/*.ts) get that rewritten to
       the absolute clone path since core/ itself is not copied - phase-b1.1);
    1b) agents/: renders `canon/roles` + `tools/adapters/omp.yml` into a fresh temp
       dir (`node core/src/render/cli.ts render --out <tmp> --clients omp`) and
       installs FROM THAT RENDER, never from a committed port copy (A3 req 2 — a
       broken/missing node aborts the installer, no silent fallback). Global mode
       mirrors (deletes stale); project mode OVERLAYS (never deletes a project's
       own extra `agents/*.md`; same-named canon files are updated unless
       -KeepAgents is given, which freezes any file already present at the dest);
    2) copies RULES.md AGENTS.md WATCHDOG.md WATCHDOG.yml (global: Force-sync all;
       project: RULES.md seed-if-absent only — never Force-overwrite; others Force);
    3) project-scoped ONLY: seeds delegation.yml from the canon
       SKELETON (`canon/{zonemap,delegation}.yml`) — ONLY if the project does not
       already have one (an existing file is NEVER touched). Global mode never
       installs these (A3 req 3) — this repo's own filled `.omp/{zonemap,
       delegation}.yml` are product data, not installer payload, and are never
       copied by this script;
    4) splices the PRODUCT block into config.yml, PRESERVING any existing head.
       Global: paths `./.omp/` -> `~/.omp/agent/` (tilde because relative paths
       resolve against CWD not the config file). Project: paths stay `./.omp/`
       as-is (they resolve against the project cwd where omp will actually run).
  Idempotent: re-running does not duplicate.

.PARAMETER Check
  Dry-run: report divergences only, write nothing (still renders canon into a
  throwaway temp dir to compute the agents diff — the temp dir itself is not
  "the install", nothing under -Target/global is touched).

.PARAMETER Target
  Project dir for a project-scoped install (`<Target>/.omp`). Omitted = global
  (`~/.omp/agent`, unchanged behaviour).

.PARAMETER KeepAgents
  Project-scoped only: never overwrite an agents/*.md file that already exists at
  the destination (freezes a committed project overlay of a canon-named role, e.g.
  a customized `executor.md`). Without this flag, canon-named files are updated
  on every install (default); files with no canon counterpart are always kept
  regardless of this flag (overlay never deletes).
#>
[CmdletBinding()]
param([switch]$Check, [string]$Target = '', [switch]$KeepAgents)

$ErrorActionPreference = "Stop"
$repo    = Split-Path -Parent $PSScriptRoot          # tools/ -> repo
$repoFwd = ($repo -replace '\\','/')
$canon   = Join-Path $repo "ports\omp"
$canonRoleRoot = Join-Path $repo "canon"
$adaptersRoot  = Join-Path $repo "tools\adapters"
$MARKER = "# ===== AIWORKFLOW PRODUCT - managed by tools/install.ps1 (do not edit below) ====="

$projectScoped = [bool]$Target
$dest = if ($projectScoped) { Join-Path $Target ".omp" } else { Join-Path $env:USERPROFILE ".omp\agent" }
# Tracked while walking the project agents-overlay loop below (A3b): canon-role file names
# rendered for this flavor (always ignored by the managed .gitignore block, §A3b) and, among
# those, the subset -KeepAgents froze because a project overlay already existed at dest (must
# be UN-ignored via a `!` exception - it's project data, not an installer artifact).
$canonAgentNames = @()
$keptAgentOverlayNames = @()

# A3b fix: a -KeepAgents-frozen canon-named file is a REAL project overlay (needs the `!`
# un-ignore exception) only if its content actually differs from the freshly rendered canon
# file - a byte-identical (CRLF/LF-insensitive) kept file is just a plain canon copy from a
# prior install and should stay ignored (bug: FinManage reinstall exposed every untouched
# canon agent getting a spurious `!` exception, re-tracking it).
function Test-SameAgentContent($srcFile, $dstFile) {
    if (-not (Test-Path $dstFile)) { return $false }
    $a = (Get-Content $srcFile -Raw -Encoding UTF8) -replace "`r`n","`n"
    $b = (Get-Content $dstFile -Raw -Encoding UTF8) -replace "`r`n","`n"
    return $a -eq $b
}

# A3b: writes/replaces the managed `# >>> aiworkflow <flavor> (managed) >>> ... <<<` block in
# <targetRoot>/.gitignore (project-scoped installs only). Idempotent: locates its own prior
# block by the exact marker lines and replaces just that span, leaving the rest of the file
# (and any other flavor's block) untouched. `$check` reports drift only, writes nothing.
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

if (-not (Test-Path $canon))  { throw "canon not found: $canon" }
if (-not $Check) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }

Write-Host "canon:  $canon"
Write-Host "dest:   $dest  ($(if ($projectScoped){'project-scoped'}else{'global'}))"
Write-Host ""

# Rewrite copied .ts imports of `(../)+core/src/...` -> absolute clone `$repoFwd/core/src/...`
# (precedent: tools/install-claude.ps1). core/ is not copied, so relative imports in the deployed
# tools/_lib/*.ts would otherwise point into a void. Applied to a temp SHADOW copy of the source
# tree before robocopy runs (both -Check and the real copy operate on the shadow), so drift-check
# and the real copy always agree post-rewrite - no perpetual false drift (contract L-3).
$coreRe  = '(\.\./)+core/src/'
$coreAbs = ($repoFwd + '/core/src/')
function New-RewrittenShadow($srcDir) {
    $shadow = Join-Path $env:TEMP ("aiwf-install-" + [guid]::NewGuid().ToString("N"))
    Copy-Item -Recurse -Force $srcDir $shadow
    Get-ChildItem -Recurse -File -Filter *.ts -Path $shadow | ForEach-Object {
        $content = Get-Content $_.FullName -Encoding UTF8 -Raw
        if ($content -match $coreRe) {
            # Preserve the ORIGINAL (pre-rewrite) LastWriteTime: WriteAllText below stamps "now",
            # which would make robocopy's default size+time comparison flag this file as "changed"
            # forever (both at real-install time and at every later -Check) even when the rewritten
            # content is byte-identical to what's already installed - perpetual false drift
            # (contract L-3). Restoring the source's own timestamp keeps it deterministic instead:
            # same canon source -> same shadow timestamp -> matches the dest stamped the same way
            # at install time.
            $origTime = $_.LastWriteTimeUtc
            $rewritten = [regex]::Replace($content, $coreRe, $coreAbs)
            [System.IO.File]::WriteAllText($_.FullName, $rewritten, (New-Object System.Text.UTF8Encoding $false))
            $_.LastWriteTimeUtc = $origTime
        }
    }
    return $shadow
}

# --- 1. Mirror tools/hooks (agents are handled separately in 1b, from canon render) ---
$trees = @("tools", "hooks")
foreach ($t in $trees) {
    $src = Join-Path $canon $t
    $dst = Join-Path $dest $t
    if (-not (Test-Path $src)) { continue }
    $shadowSrc = New-RewrittenShadow $src
    try {
        if ($Check) {
            $changes = robocopy $shadowSrc $dst /MIR /L /NJH /NJS /NDL /NP /NC /NS
            $n = ($changes | Where-Object { $_.Trim() -ne "" }).Count
            Write-Host ("[check] {0}: {1} file(s) would change" -f $t, $n)
        } else {
            robocopy $shadowSrc $dst /MIR /NJH /NJS /NDL /NP /NC /NS | Out-Null
            if ($LASTEXITCODE -ge 8) { throw "robocopy $t failed (exit $LASTEXITCODE)" }
            Write-Host ("[sync] {0}/ mirrored" -f $t)
        }
    } finally {
        Remove-Item -Recurse -Force $shadowSrc -ErrorAction SilentlyContinue
    }
}

# --- 1b. Agents: render canon fresh (A3 req 2 - never install from a committed port copy) ---
$nodeExe = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeExe) { throw "node not found on PATH - required to render canon agents (core/src/render/cli.ts)" }

$renderTmp = Join-Path $env:TEMP ("aiwf-render-omp-" + [guid]::NewGuid().ToString("N"))
try {
    $rendererScript = Join-Path $repo "core\src\render\cli.ts"
    $renderOut = & node $rendererScript render --out $renderTmp --clients omp --canon $canonRoleRoot --adapters $adaptersRoot 2>&1
    if ($LASTEXITCODE -ne 0) { throw "canon render failed (exit $LASTEXITCODE): $renderOut" }

    $agentsSrc = Join-Path $renderTmp ".omp\agents"
    $agentsDst = Join-Path $dest "agents"
    if (Test-Path $agentsSrc) {
        if (-not $projectScoped) {
            # Global: full mirror (delete stale) - same semantics install.ps1 always had.
            if ($Check) {
                $changes = robocopy $agentsSrc $agentsDst /MIR /L /NJH /NJS /NDL /NP /NC /NS
                $n = ($changes | Where-Object { $_.Trim() -ne "" }).Count
                Write-Host ("[check] agents: {0} file(s) would change" -f $n)
            } else {
                robocopy $agentsSrc $agentsDst /MIR /NJH /NJS /NDL /NP /NC /NS | Out-Null
                if ($LASTEXITCODE -ge 8) { throw "robocopy agents failed (exit $LASTEXITCODE)" }
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

# --- 2. Copy md files ---
# RULES.md: global Force-sync (sole protocol copy). Project: seed-if-absent only
# (no -Force) so an existing project RULES is kept — avoids dual-load overwrite.
$files = @("RULES.md", "AGENTS.md", "WATCHDOG.md", "WATCHDOG.yml")
foreach ($f in $files) {
    $src = Join-Path $canon $f
    if (-not (Test-Path $src)) { continue }
    $dst = Join-Path $dest $f
    if ($projectScoped -and $f -eq "RULES.md") {
        if (Test-Path $dst) {
            $tag = if ($Check) { "check" } else { "keep" }
            Write-Host ("[{0}] {1}: exists - kept (no Force overwrite)" -f $tag, $f)
        } elseif ($Check) {
            Write-Host ("[check] {0}: ABSENT -> would seed once" -f $f)
        } else {
            Copy-Item $src $dst
            Write-Host ("[sync] {0} (seeded once)" -f $f)
        }
        continue
    }
    if ($Check) {
        $differ = (-not (Test-Path $dst)) -or ((Get-FileHash $src).Hash -ne (Get-FileHash $dst).Hash)
        $state = if ($differ) { "would change" } else { "in sync" }
        Write-Host ("[check] {0}: {1}" -f $f, $state)
    } else {
        Copy-Item $src $dst -Force
        Write-Host ("[sync] {0}" -f $f)
    }
}

# --- 3. Project config seed: delegation.yml only (zonemap NOT seeded) (project-scoped ONLY, A3 req 3) ---
# Seeded from the canon SKELETON (empty map/native-default), NEVER from this repo's own
# filled `.omp/{zonemap,delegation}.yml` (that's FinManage's product data, not installer
# payload). An existing project file is NEVER overwritten. Global mode installs neither.
if ($projectScoped) {
    foreach ($cfgName in @("delegation")) {
        $src = Join-Path $canonRoleRoot "$cfgName.yml"
        $dst = Join-Path $dest "$cfgName.yml"
        if (Test-Path $dst) {
            $tag = if ($Check) { "check" } else { "keep" }
            Write-Host ("[{0}] {1}.yml: exists - kept (never overwritten)" -f $tag, $cfgName)
        } elseif ($Check) {
            Write-Host ("[check] {0}.yml: ABSENT -> would seed from canon skeleton" -f $cfgName)
        } else {
            Copy-Item $src $dst
            Write-Host ("[sync] {0}.yml <- canon skeleton (seeded; fill in-project)" -f $cfgName)
        }
    }
}

# --- 4. Splice PRODUCT block into config.yml ---
$canonCfg = Join-Path $canon "config.yml"
$destCfg  = Join-Path $dest "config.yml"
if (-not (Test-Path $canonCfg)) { throw "canon config.yml not found" }

# product body = canon from first 'extensions:' line to EOF. Global: tilde paths
# (`./.omp/` -> `~/.omp/agent/`, since relative paths resolve against CWD not the
# global config file). Project: paths stay `./.omp/` as-is - they resolve against
# the project cwd where omp actually runs (A3 req 1).
# -Encoding UTF8: canon has Cyrillic comments; default ANSI read would mojibake them on rewrite.
$canonLines = Get-Content $canonCfg -Encoding UTF8
$extLine = ($canonLines | Select-String -Pattern '^extensions:' | Select-Object -First 1)
if (-not $extLine) { throw "canon config.yml has no 'extensions:'" }
$extIdx = $extLine.LineNumber - 1
$productBody = ($canonLines[$extIdx..($canonLines.Count - 1)] -join "`n")
if (-not $projectScoped) {
    $productBody = $productBody -replace '\./\.omp/', '~/.omp/agent/'
}

# head = dest config up to first of {MARKER, a PRODUCT-header divider, 'extensions:'}.
$headText = ""
if (Test-Path $destCfg) {
    $g = Get-Content $destCfg -Encoding UTF8
    $cut = $g.Count
    # Precise cut: our MARKER (re-runs) or first top-level 'extensions:' (first migration).
    # NOTE: do NOT match on substrings like 'PRODUCT' or Cyrillic letters — machine-head comments
    # can contain them and would truncate modelRoles (bug fixed 2026-08-30).
    for ($i = 0; $i -lt $g.Count; $i++) {
        if ($g[$i] -eq $MARKER -or $g[$i] -match '^extensions:') { $cut = $i; break }
    }
    $headLines = @()
    if ($cut -gt 0) { $headLines = @($g[0..($cut - 1)]) }
    # Trim trailing blank/divider lines by shrinking a count, not by re-slicing the array with a
    # negative upper bound: when Count reaches 1, `$headLines[0..($headLines.Count - 2)]` becomes
    # `$headLines[0..-1]`, and PowerShell's `..` range operator treats a negative endpoint as an
    # index from the end (here, the same single element again) rather than "empty range" - the
    # array never shrinks to 0 and the loop spins forever (bug, T7-10).
    $n = $headLines.Count
    while ($n -gt 0 -and ($headLines[$n - 1].Trim() -eq "" -or $headLines[$n - 1] -match '^#\s*={3,}')) {
        $n--
    }
    $headLines = if ($n -gt 0) { @($headLines[0..($n - 1)]) } else { @() }
    $headText = ($headLines -join "`n")
}

$newCfg = ($headText.TrimEnd() + "`n`n" + $MARKER + "`n" + $productBody).TrimEnd() + "`n"

if ($Check) {
    # Read as UTF-8 explicitly (PS5.1 Get-Content default-decodes as ANSI -> false diff on Cyrillic comments).
    $cur = if (Test-Path $destCfg) { [System.IO.File]::ReadAllText($destCfg) } else { "" }
    if ($cur -ne $newCfg) { Write-Host "[check] config.yml: would change (product block rebuilt)" }
    else                  { Write-Host "[check] config.yml: in sync" }
} else {
    # UTF-8 WITHOUT BOM (PS5.1 Set-Content -Encoding utf8 adds a BOM; YAML parsers dislike it).
    [System.IO.File]::WriteAllText($destCfg, $newCfg, (New-Object System.Text.UTF8Encoding $false))
    Write-Host "[sync] config.yml: product block rebuilt (head preserved)"
}

# --- 5. Project .gitignore managed block (A3b, project-scoped ONLY) ---
# Ignores installed FLAVOR artifacts (tools/hooks/RULES/AGENTS/WATCHDOG/config.yml + canon-named
# agents/*.md); never ignores project data (zonemap.yml/delegation.yml, non-canon agent overlays,
# or a canon-named overlay -KeepAgents froze - that gets an explicit `!` exception above).
if ($projectScoped) {
    $ignoreLines = @(".omp/tools/", ".omp/hooks/", ".omp/RULES.md", ".omp/AGENTS.md", ".omp/WATCHDOG.md", ".omp/WATCHDOG.yml", ".omp/config.yml")
    foreach ($n in $canonAgentNames) { $ignoreLines += ".omp/agents/$n" }
    $exceptionLines = @()
    foreach ($n in $keptAgentOverlayNames) { $exceptionLines += ".omp/agents/$n" }
    Set-ManagedGitignoreBlock $Target "omp" $ignoreLines $exceptionLines $Check
}

Write-Host ""
if ($Check) { Write-Host "CHECK done (nothing written)." }
elseif ($projectScoped) { Write-Host "INSTALL done. Verify: run omp from inside the project - it sees <Target>/.omp." }
else        { Write-Host "INSTALL done. Verify: omp in a project sees the global tools." }

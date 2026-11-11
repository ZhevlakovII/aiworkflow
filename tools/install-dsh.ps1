<#
.SYNOPSIS
  Install AI Workflow DSH Cordis plugin + optional project overlay (.dsh-aiwf/).

.PARAMETER Check
  Dry-run only.
.PARAMETER Profile
  DSH profile name (default headless).
.PARAMETER Target
  Project directory for overlay.
.PARAMETER WithXaiOauth
  Append documented oauth patch stanza only (no login).
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [string]$Profile = 'headless',
  [string]$Target = '',
  [switch]$WithXaiOauth
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$repoFwd = ($repo -replace '\\', '/')
$src = Join-Path $repo 'ports\dsh'
$frag = Join-Path $src 'cordis.patch.fragment.yml'
if (-not (Test-Path $src)) { throw "ports/dsh not found: $src" }

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome "profiles\$Profile"
$pluginDest = Join-Path $profileDir 'plugins\aiwf'
$patchDst = Join-Path $profileDir 'cordis.patch.yml'
$overlay = if ($Target) { Join-Path $Target '.dsh-aiwf' } else { '' }

$runtimeTs = Join-Path $repo 'tools\install-runtime.ts'
$destFwd = ($pluginDest -replace '\\', '/')

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

Write-Host "flavor: dsh"
Write-Host "plugin:  $pluginDest"
Write-Host "patch:   $patchDst"
Write-Host "overlay: $(if ($overlay) { $overlay } else { '<none>' })"

function New-ImportRewrittenShadow([string]$srcDir) {
  $shadowRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("aiwf-dsh-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $shadowRoot | Out-Null
  Copy-Item -Path (Join-Path $srcDir '*') -Destination $shadowRoot -Recurse -Force
  Invoke-InstallRuntime @('rewrite-imports', '--dest', $shadowRoot, '--under', $shadowRoot)
  return $shadowRoot
}

function Sync-Plugin {
  $shadow = New-ImportRewrittenShadow $src
  try {
    if ($Check) {
      Write-Host "[check] would vendor core/src -> $pluginDest/core/src"
      Write-Host "[check] plugin -> $pluginDest"
    } else {
      New-Item -ItemType Directory -Force -Path $pluginDest | Out-Null
      Invoke-InstallRuntime @('vendor', '--repo', $repo, '--dest', $pluginDest)
      Copy-Item -Path (Join-Path $shadow '*') -Destination $pluginDest -Recurse -Force
      Invoke-InstallRuntime @('rewrite-imports', '--dest', $pluginDest, '--under', $pluginDest)
      Write-Host "[sync] plugin -> $pluginDest"
    }
  } finally {
    Remove-Item -Recurse -Force $shadow -ErrorAction SilentlyContinue
  }
}

function Merge-Patch {
  $body = Get-Content $frag -Raw -Encoding UTF8
  if ($WithXaiOauth) {
    $body += "`noauth_plugin_hint:`n  npm: dsh-llm-xai-oauth@0.2.0`n"
  }
  if ($Check) {
    Write-Host "[check] cordis.patch.yml merge"
    return
  }
  New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
  if ((Test-Path $patchDst) -and (Select-String -Path $patchDst -Pattern 'aiwf-dsh' -Quiet)) {
    Write-Host "[sync] cordis.patch.yml already has aiwf block"
  } elseif (Test-Path $patchDst) {
    Add-Content -Path $patchDst -Value "`n# --- aiworkflow dsh (managed) ---`n$body" -Encoding UTF8
    Write-Host "[sync] cordis.patch.yml merged"
  } else {
    Set-Content -Path $patchDst -Value $body -Encoding UTF8
    Write-Host "[sync] cordis.patch.yml created"
  }
}

function Render-Overlay {
  if (-not $overlay) { return }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("aiwf-render-" + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $renderCli = Join-Path $repo 'core\src\render\cli.ts'
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node required for agent render' }
  & node $renderCli render --out $tmp --clients dsh --canon (Join-Path $repo 'canon') --adapters (Join-Path $repo 'tools\adapters')
  if ($LASTEXITCODE -ne 0) { throw "render failed exit $LASTEXITCODE" }
  if ($Check) {
    Write-Host "[check] overlay -> $overlay"
    Remove-Item -Recurse -Force $tmp
    return
  }
  New-Item -ItemType Directory -Force -Path $overlay | Out-Null
  foreach ($f in @('AGENTS.md', 'RULES.md', 'WATCHDOG.md', 'WATCHDOG.yml')) {
    $from = Join-Path $src $f
    if (Test-Path $from) { Copy-Item $from (Join-Path $overlay $f) -Force }
  }
  $agentsSrc = Join-Path $tmp 'agents'
  if (Test-Path $agentsSrc) {
    $agentsDst = Join-Path $overlay 'agents'
    New-Item -ItemType Directory -Force -Path $agentsDst | Out-Null
    Copy-Item -Path (Join-Path $agentsSrc '*') -Destination $agentsDst -Recurse -Force
  }
  foreach ($seed in @('delegation.yml')) {
    $dst = Join-Path $overlay $seed
    if (-not (Test-Path $dst)) {
      $canonSeed = Join-Path $repo "canon\$seed"
      if (Test-Path $canonSeed) { Copy-Item $canonSeed $dst } else { Copy-Item (Join-Path $src $seed) $dst }
      Write-Host "[seed] $dst"
    }
  }
  Remove-Item -Recurse -Force $tmp
  Write-Host "[sync] overlay -> $overlay"
}

Sync-Plugin
Merge-Patch
Render-Overlay
Write-Host "done (check=$($Check.IsPresent))"

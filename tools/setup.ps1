# setup.ps1 - thin delegate to node tools/aiwf.ts setup (Windows).
# ASCII-only (PS 5.1 parses .ps1 as cp1251 without a BOM).
# Maps -Yes to --mode yolo. Live flavors: omp|opencode|cursor|dsh|all (no claude/codex/both).
param(
    [switch]$Check,
    [switch]$Yes,
    [switch]$InstallMissing,
    [string[]]$Install = @(),
    [switch]$SkipSmoke,
    [switch]$DefaultRoles,
    [ValidateSet('omp','opencode','cursor','dsh','all')]
    [string]$Flow = 'all',
    [string]$Target = '',
    [switch]$KeepAgents,
    [ValidateSet('full','key','soft','yolo')]
    [string]$Mode = ''
)
$ErrorActionPreference = 'Stop'
if ($InstallMissing) { $Yes = $true }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $ScriptDir 'aiwf.ts'

$nodeArgs = @($Cli, 'setup')
if ($Yes) { $nodeArgs += @('--mode', 'yolo') }
elseif ($Mode) { $nodeArgs += @('--mode', $Mode) }
if ($Check) { $nodeArgs += '--check' }
if ($SkipSmoke) { $nodeArgs += '--skip-smoke' }
if ($KeepAgents) { $nodeArgs += '--keep-agents' }
if ($Flow) { $nodeArgs += @('--flow', $Flow) }
if ($Target) { $nodeArgs += @('--target', $Target) }
# -DefaultRoles is implied by yolo/key/soft in the Node CLI; full mode prompts.
# -Install list is retired (no mid-flight package install from thin shell).

& node @nodeArgs
exit $LASTEXITCODE

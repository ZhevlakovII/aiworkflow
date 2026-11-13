# install-cursor.ps1 - thin delegate: node tools/aiwf.ts install cursor
# ASCII-only.
param([switch]$Check, [string]$Target = '', [switch]$KeepAgents)
$ErrorActionPreference = 'Stop'
$Cli = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'aiwf.ts'
$argsList = @($Cli, 'install', 'cursor')
if ($Check) { $argsList += '--check' }
if ($Target) { $argsList += @('--target', $Target) }
if ($KeepAgents) { $argsList += '--keep-agents' }
& node @argsList
exit $LASTEXITCODE

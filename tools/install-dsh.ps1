# install-dsh.ps1 - thin delegate: node tools/aiwf.ts install dsh
# ASCII-only.
param([switch]$Check, [string]$Target = '', [string]$Profile = 'headless')
$ErrorActionPreference = 'Stop'
if ($Profile) { $env:AIWF_DSH_PROFILE = $Profile }
$Cli = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'aiwf.ts'
$argsList = @($Cli, 'install', 'dsh')
if ($Check) { $argsList += '--check' }
if ($Target) { $argsList += @('--target', $Target) }
& node @argsList
exit $LASTEXITCODE

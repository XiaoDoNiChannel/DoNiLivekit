# Compatibility entry point for older local release instructions.
[CmdletBinding()]
param([string]$OutputDirectory = "")
$ErrorActionPreference = 'Stop'
Write-Host 'Client releases now use the portable EXE / GitHub update channel.'
& (Join-Path $PSScriptRoot 'Build-PortableRelease.ps1') -OutputDirectory $OutputDirectory

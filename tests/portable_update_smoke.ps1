# Exercise the actual release EXE's helper entry point without production keys.
[CmdletBinding()]
param(
    [string]$BinaryPath = (Join-Path $PSScriptRoot '..\src-tauri\target\x86_64-pc-windows-msvc\release\app.exe')
)
$ErrorActionPreference = 'Stop'
$binary = (Resolve-Path -LiteralPath $BinaryPath).Path
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $tempBase ('donichannel-portable-smoke-' + [guid]::NewGuid().ToString('N'))
$testRoot = [IO.Path]::GetFullPath($testRoot)
$child = $null
try {
    [IO.Directory]::CreateDirectory($testRoot) | Out-Null
    $target = Join-Path $testRoot '豆泥 测试.exe'
    Copy-Item -LiteralPath $binary -Destination $target
    $originalHash = (Get-FileHash -LiteralPath $target).Hash
    foreach ($scenario in @('wrong-signature', 'invalid-exe')) {
        $stage = Join-Path $testRoot ('.donichannel-update-' + $scenario)
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        Copy-Item -LiteralPath $binary -Destination (Join-Path $stage 'helper.exe')
        if ($scenario -eq 'wrong-signature') {
            Copy-Item -LiteralPath $binary -Destination (Join-Path $stage 'next.exe')
        } else {
            [IO.File]::WriteAllText((Join-Path $stage 'next.exe'), '{"not":"an executable"}')
        }
        $job = @{
            target_name = [IO.Path]::GetFileName($target)
            parent_pid = $PID
            signature = 'invalid-signature'
        } | ConvertTo-Json
        [IO.File]::WriteAllText((Join-Path $stage 'job.json'), $job, [Text.UTF8Encoding]::new($false))
        $child = Start-Process -FilePath (Join-Path $stage 'helper.exe') -ArgumentList '--donichannel-apply-update' -WindowStyle Hidden -PassThru
        if (-not $child.WaitForExit(10000)) { throw "$scenario helper did not reject the update in time" }
        if (Test-Path -LiteralPath (Join-Path $stage 'ready')) { throw "$scenario unexpectedly authorized shutdown" }
        if (-not (Test-Path -LiteralPath (Join-Path $stage 'error.txt'))) { throw "$scenario did not report an error" }
        if ((Get-FileHash -LiteralPath $target).Hash -ne $originalHash) { throw "$scenario modified the original EXE" }
        Write-Host "PASS: $scenario rejected before shutdown; original EXE unchanged"
    }
} finally {
    if ($child -and -not $child.HasExited) { $child.Kill(); $child.WaitForExit() }
    if ($testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($testRoot).StartsWith('donichannel-portable-smoke-', [StringComparison]::Ordinal)) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

$ErrorActionPreference = "Stop"
$serverRoot = $PSScriptRoot

foreach ($serviceKey in @("backend", "livekit")) {
    Set-Content -LiteralPath (Join-Path $serverRoot "$serviceKey.stop") -Value "stop" -Encoding ascii
}

function Stop-PackagedProcess {
    param(
        [string]$Name,
        [string]$PidFile,
        [string]$ExpectedPath
    )

    $expectedFullPath = [IO.Path]::GetFullPath($ExpectedPath)
    $processName = [IO.Path]::GetFileNameWithoutExtension($ExpectedPath)
    $matched = @()
    foreach ($process in @(Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
        try {
            $processPath = [IO.Path]::GetFullPath($process.Path)
            if ($processPath -eq $expectedFullPath) {
                $matched += $process
            }
        } catch {}
    }

    if ($matched.Count -eq 0) {
        Write-Host "$Name 已经停止" -ForegroundColor Yellow
    } else {
        foreach ($process in $matched) {
            Stop-Process -Id $process.Id -Force
            Write-Host "$Name 已停止，PID=$($process.Id)" -ForegroundColor Green
        }
    }

    Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
}

Stop-PackagedProcess -Name "Python 后端" -PidFile (Join-Path $serverRoot "backend.pid") -ExpectedPath (Join-Path $serverRoot "donichannel-backend.exe")
Stop-PackagedProcess -Name "LiveKit" -PidFile (Join-Path $serverRoot "livekit.pid") -ExpectedPath (Join-Path $serverRoot "livekit-server.exe")

Start-Sleep -Milliseconds 800
foreach ($serviceKey in @("backend", "livekit")) {
    $consolePidFile = Join-Path $serverRoot "$serviceKey.console.pid"
    if (Test-Path -LiteralPath $consolePidFile -PathType Leaf) {
        $consolePid = Get-Content -LiteralPath $consolePidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($consolePid -match '^\d+$') {
            $consoleProcess = Get-Process -Id ([int]$consolePid) -ErrorAction SilentlyContinue
            if ($consoleProcess -and $consoleProcess.ProcessName -match '^powershell$') {
                Stop-Process -Id $consoleProcess.Id -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath $consolePidFile -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath (Join-Path $serverRoot "$serviceKey.stop") -Force -ErrorAction SilentlyContinue
}

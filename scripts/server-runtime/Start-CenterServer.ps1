$ErrorActionPreference = "Stop"
$serverRoot = $PSScriptRoot
$logsDir = Join-Path $serverRoot "logs"
$uploadsDir = Join-Path $serverRoot "uploads"
$downloadsDir = Join-Path $serverRoot "downloads"
$livekitExe = Join-Path $serverRoot "livekit-server.exe"
$backendExe = Join-Path $serverRoot "donichannel-backend.exe"

New-Item -ItemType Directory -Path $logsDir, $uploadsDir, $downloadsDir -Force | Out-Null

if (-not (Test-Path -LiteralPath $livekitExe -PathType Leaf)) {
    throw "缺少 livekit-server.exe"
}
if (-not (Test-Path -LiteralPath $backendExe -PathType Leaf)) {
    throw "缺少 donichannel-backend.exe"
}

function Get-RunningPackagedProcess {
    param(
        [string]$PidFile,
        [string]$ExpectedPath
    )

    $expectedFullPath = [IO.Path]::GetFullPath($ExpectedPath)
    if (Test-Path -LiteralPath $PidFile -PathType Leaf) {
        $savedPid = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($savedPid -match '^\d+$') {
            $savedProcess = Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
            if ($savedProcess) {
                try {
                    if ([IO.Path]::GetFullPath($savedProcess.Path) -eq $expectedFullPath) {
                        return $savedProcess
                    }
                } catch {}
            }
        }
    }

    $processName = [IO.Path]::GetFileNameWithoutExtension($ExpectedPath)
    foreach ($candidate in @(Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
        try {
            if ([IO.Path]::GetFullPath($candidate.Path) -eq $expectedFullPath) {
                return $candidate
            }
        } catch {}
    }
    return $null
}

$livekitPidFile = Join-Path $serverRoot "livekit.pid"
$backendPidFile = Join-Path $serverRoot "backend.pid"
$livekitProcess = Get-RunningPackagedProcess -PidFile $livekitPidFile -ExpectedPath $livekitExe
$backendProcess = Get-RunningPackagedProcess -PidFile $backendPidFile -ExpectedPath $backendExe

if (-not $livekitProcess) {
    $livekitProcess = Start-Process `
        -FilePath $livekitExe `
        -ArgumentList @("--dev", "--bind", "0.0.0.0", "--node-ip", "10.126.126.67") `
        -WorkingDirectory $serverRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logsDir "livekit.stdout.log") `
        -RedirectStandardError (Join-Path $logsDir "livekit.stderr.log") `
        -PassThru
    Set-Content -LiteralPath $livekitPidFile -Value $livekitProcess.Id -Encoding ascii
    Write-Host "LiveKit 已启动，PID=$($livekitProcess.Id)" -ForegroundColor Green
} else {
    Write-Host "LiveKit 已在运行，PID=$($livekitProcess.Id)" -ForegroundColor Yellow
}

$env:DONICHANNEL_BASE_DIR = $serverRoot
$env:DONICHANNEL_DB_PATH = Join-Path $serverRoot "rooms.db"
$env:DONICHANNEL_UPLOADS_DIR = $uploadsDir
$env:DONICHANNEL_DOWNLOADS_DIR = $downloadsDir
$env:LIVEKIT_API_KEY = "devkey"
$env:LIVEKIT_API_SECRET = "secret"
$env:LIVEKIT_URL = "http://127.0.0.1:7880"

if (-not $backendProcess) {
    $backendProcess = Start-Process `
        -FilePath $backendExe `
        -WorkingDirectory $serverRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $logsDir "backend.stdout.log") `
        -RedirectStandardError (Join-Path $logsDir "backend.stderr.log") `
        -PassThru
    Set-Content -LiteralPath $backendPidFile -Value $backendProcess.Id -Encoding ascii
    Write-Host "Python 后端已启动，PID=$($backendProcess.Id)" -ForegroundColor Green
} else {
    Write-Host "Python 后端已在运行，PID=$($backendProcess.Id)" -ForegroundColor Yellow
}

function Wait-LocalPort {
    param(
        [int]$Port,
        [int]$TimeoutSeconds = 25
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        $client = [Net.Sockets.TcpClient]::new()
        try {
            $attempt = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
            if ($attempt.AsyncWaitHandle.WaitOne(500)) {
                $client.EndConnect($attempt)
                return $true
            }
        } catch {
        } finally {
            $client.Close()
        }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

$livekitReady = Wait-LocalPort -Port 7880
$backendReady = Wait-LocalPort -Port 5000
if (-not $livekitReady -or -not $backendReady) {
    Write-Host "服务启动超时，请检查 logs 目录。" -ForegroundColor Red
    & (Join-Path $serverRoot "Stop-CenterServer.ps1")
    exit 1
}

Write-Host ""
Write-Host "中心服务器已启动" -ForegroundColor Green
Write-Host "FastAPI: http://10.126.126.67:5000"
Write-Host "LiveKit: ws://10.126.126.67:7880"
Write-Host "日志目录: $logsDir"

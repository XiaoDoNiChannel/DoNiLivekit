[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("LiveKit", "Backend")]
    [string]$Service,
    [ValidateRange(1, 1024)]
    [int]$MaxLogSizeMB = 10,
    [ValidateRange(1, 20)]
    [int]$MaxLogFiles = 5
)

$ErrorActionPreference = "Stop"
$serverRoot = $PSScriptRoot
$logsDir = Join-Path $serverRoot "logs"
$stopSignalPath = Join-Path $serverRoot ("{0}.stop" -f $Service.ToLowerInvariant())
$consolePidPath = Join-Path $serverRoot ("{0}.console.pid" -f $Service.ToLowerInvariant())
$maxLogBytes = [int64]$MaxLogSizeMB * 1MB

New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
Remove-Item -LiteralPath $stopSignalPath -Force -ErrorAction SilentlyContinue
Set-Content -LiteralPath $consolePidPath -Value $PID -Encoding ascii

if ($Service -eq "LiveKit") {
    $displayName = "LiveKit"
    $executable = Join-Path $serverRoot "livekit-server.exe"
    $executableArguments = @("--dev", "--bind", "0.0.0.0", "--node-ip", "10.126.126.67")
    $logPath = Join-Path $logsDir "livekit.log"
} else {
    $displayName = "Python Backend"
    $executable = Join-Path $serverRoot "donichannel-backend.exe"
    $executableArguments = @()
    $logPath = Join-Path $logsDir "backend.log"
}

try {
    $Host.UI.RawUI.WindowTitle = "DoNiChannel - $displayName"
} catch {}

function Rotate-LogIfNeeded {
    if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) {
        return
    }
    if ((Get-Item -LiteralPath $logPath).Length -lt $maxLogBytes) {
        return
    }

    if ($MaxLogFiles -le 1) {
        Remove-Item -LiteralPath $logPath -Force
        return
    }

    $oldestArchive = "$logPath.$($MaxLogFiles - 1)"
    Remove-Item -LiteralPath $oldestArchive -Force -ErrorAction SilentlyContinue
    for ($index = $MaxLogFiles - 2; $index -ge 1; $index--) {
        $source = "$logPath.$index"
        $destination = "$logPath.$($index + 1)"
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            Move-Item -LiteralPath $source -Destination $destination -Force
        }
    }
    Move-Item -LiteralPath $logPath -Destination "$logPath.1" -Force
}

function Write-ServiceLine {
    param([string]$Line)

    Rotate-LogIfNeeded
    Write-Host $Line
    Add-Content -LiteralPath $logPath -Value $Line -Encoding UTF8
}

$exitCode = 1
try {
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "Executable not found: $executable"
    }

    Write-ServiceLine "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] starting $displayName"
    Write-ServiceLine "log=$logPath max_file_size=${MaxLogSizeMB}MB files=$MaxLogFiles"
    Write-Host "关闭服务请使用 STOP_SERVER.cmd，不要直接关闭本窗口。" -ForegroundColor Cyan
    Write-Host ""

    $savedErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 wraps native stderr lines as ErrorRecord objects.
        # LiveKit and Uvicorn legitimately write normal startup logs to stderr, so
        # keep those lines in the merged stream instead of treating them as fatal.
        $ErrorActionPreference = "Continue"
        & $executable @executableArguments 2>&1 | ForEach-Object {
            Write-ServiceLine ([string]$_)
        }
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedErrorActionPreference
    }
} catch {
    $exitCode = 1
    Write-ServiceLine "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] launcher_error=$([string]$_.Exception.Message)"
} finally {
    Write-ServiceLine "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] $displayName exited code=$exitCode"
    Remove-Item -LiteralPath $consolePidPath -Force -ErrorAction SilentlyContinue

    if (Test-Path -LiteralPath $stopSignalPath -PathType Leaf) {
        Remove-Item -LiteralPath $stopSignalPath -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host ""
        Write-Host "$displayName 意外退出，错误已经写入：$logPath" -ForegroundColor Red
        Read-Host "按回车关闭窗口"
    }
}

exit $exitCode

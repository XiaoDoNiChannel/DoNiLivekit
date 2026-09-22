[CmdletBinding()]
param(
    [string]$Version = "",
    [switch]$SkipChecks,
    [switch]$SkipCompile
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$serverVersionPath = Join-Path $projectRoot "server\VERSION"
$defaultVersion = if (Test-Path -LiteralPath $serverVersionPath -PathType Leaf) {
    (Get-Content -LiteralPath $serverVersionPath -Raw -Encoding UTF8).Trim()
} else {
    "1.0.0"
}

if ([string]::IsNullOrWhiteSpace($Version)) {
    $enteredVersion = Read-Host "请输入中心服务器包版本（直接回车使用 $defaultVersion）"
    $Version = if ([string]::IsNullOrWhiteSpace($enteredVersion)) { $defaultVersion } else { $enteredVersion.Trim().TrimStart('v') }
}

if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "版本号格式不正确，应类似 0.2.0"
}

Set-Content -LiteralPath $serverVersionPath -Value $Version -Encoding UTF8

function Invoke-CheckedCommand {
    param(
        [string]$DisplayName,
        [scriptblock]$Command
    )
    Write-Host "`n==> $DisplayName" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$DisplayName 失败，退出码: $LASTEXITCODE"
    }
}

if (-not $SkipChecks -and -not $SkipCompile) {
    Invoke-CheckedCommand "Python 后端测试" {
        python -m unittest discover -s tests -p "*_tests.py" -v
    }
}

if (-not $SkipCompile) {
    Invoke-CheckedCommand "构建服务端 Web 静态资源" {
        npm run build --prefix ui
    }

    try {
        python -m PyInstaller --version | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "PyInstaller unavailable" }
    } catch {
        throw "没有安装 PyInstaller。请先运行: python -m pip install -r requirements-dev.txt"
    }

    Invoke-CheckedCommand "构建 Python 独立后端" {
        python -m PyInstaller --noconfirm --clean donichannel-backend.spec
    }
}

$backendExe = Join-Path $projectRoot "dist\donichannel-backend.exe"
$livekitExe = Join-Path $projectRoot "livekit-server.exe"
if (-not (Test-Path -LiteralPath $backendExe -PathType Leaf)) {
    throw "没有找到 PyInstaller 输出: $backendExe"
}
if (-not (Test-Path -LiteralPath $livekitExe -PathType Leaf)) {
    throw "没有找到 LiveKit 服务端: $livekitExe"
}

$releaseBase = [IO.Path]::GetFullPath((Join-Path $projectRoot "server-release"))
$stageDirectory = [IO.Path]::GetFullPath((Join-Path $releaseBase "DoNiChannel-Server-v$Version"))
if (-not $stageDirectory.StartsWith($releaseBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "服务端暂存目录越界，拒绝继续"
}

New-Item -ItemType Directory -Path $releaseBase -Force | Out-Null
if (Test-Path -LiteralPath $stageDirectory) {
    Remove-Item -LiteralPath $stageDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $stageDirectory -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDirectory "uploads"), (Join-Path $stageDirectory "downloads"), (Join-Path $stageDirectory "logs") -Force | Out-Null

Copy-Item -LiteralPath $backendExe -Destination $stageDirectory -Force
Copy-Item -LiteralPath $livekitExe -Destination $stageDirectory -Force
Copy-Item -Path (Join-Path $projectRoot "scripts\server-runtime\*") -Destination $stageDirectory -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\Publish-LanUpdate.ps1") -Destination $stageDirectory -Force

$uiTarget = Join-Path $stageDirectory "ui\dist"
New-Item -ItemType Directory -Path $uiTarget -Force | Out-Null
Copy-Item -Path (Join-Path $projectRoot "ui\dist\*") -Destination $uiTarget -Recurse -Force

Set-Content -LiteralPath (Join-Path $stageDirectory "server-version.txt") -Value $Version -Encoding UTF8

$readme = @"
DoNiChannel 中心服务器 v$Version
================================

目标地址：10.126.126.67
FastAPI：  http://10.126.126.67:5000
LiveKit：  ws://10.126.126.67:7880

首次部署：
1. 解压整个目录到中心服务器。
2. 双击 OPEN_FIREWALL.cmd，以管理员身份放行 5000/7880/7881/TCP 和 7882/UDP。
3. 双击 START_SERVER.cmd。

停止服务：双击 STOP_SERVER.cmd。

发布客户端更新：双击 PUBLISH_CLIENT_UPDATE.cmd，然后输入包含 latest.json 和 .nsis.zip 的目录。

升级：
1. 先运行旧目录中的 STOP_SERVER.cmd。
2. 解压新包并覆盖程序文件。
3. 必须保留 rooms.db、uploads、downloads。
4. 再运行 START_SERVER.cmd。

运行数据：
- rooms.db：房间、聊天、用户资料数据库。
- uploads：用户上传文件。
- downloads：客户端自动更新包。
- logs：LiveKit 与 Python 后端日志。

这个压缩包不需要服务器安装 Python、Node.js 或 Rust。
"@
Set-Content -LiteralPath (Join-Path $stageDirectory "README-SERVER.txt") -Value $readme -Encoding UTF8

$zipPath = Join-Path $releaseBase "DoNiChannel-Server-v$Version.zip"
if (Test-Path -LiteralPath $zipPath -PathType Leaf) {
    Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -LiteralPath $stageDirectory -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host "`n中心服务器便携包构建成功" -ForegroundColor Green
Write-Host "目录: $stageDirectory"
Write-Host "ZIP:  $zipPath"
Write-Host "把 ZIP 复制到 10.126.126.67，解压后先运行 OPEN_FIREWALL.cmd，再运行 START_SERVER.cmd。"

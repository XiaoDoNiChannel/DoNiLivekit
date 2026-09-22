[CmdletBinding()]
param(
    [string]$Version = "",
    [ValidateSet("github", "local", "")]
    [string]$Mode = "",
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$tauriConfigPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$currentVersion = [string]$tauriConfig.version

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Value
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Value, $encoding)
}

function Get-NextPatchVersion {
    param([string]$Value)
    if ($Value -match '^(\d+)\.(\d+)\.(\d+)$') {
        return "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
    }
    return "0.1.1"
}

$suggestedVersion = Get-NextPatchVersion -Value $currentVersion
if ([string]::IsNullOrWhiteSpace($Version)) {
    $enteredVersion = Read-Host "请输入新客户端版本（当前 $currentVersion，直接回车使用 $suggestedVersion）"
    $Version = if ([string]::IsNullOrWhiteSpace($enteredVersion)) { $suggestedVersion } else { $enteredVersion.Trim().TrimStart('v') }
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "版本号格式不正确，应类似 0.1.1"
}
if ($Version -eq $currentVersion) {
    throw "新版本号必须不同于当前版本 $currentVersion"
}

Write-Host "请输入更新说明，每行一条；直接输入空行结束：" -ForegroundColor Cyan
$noteLines = [Collections.Generic.List[string]]::new()
while ($true) {
    $line = Read-Host "-"
    if ([string]::IsNullOrWhiteSpace($line)) { break }
    $noteLines.Add($line.Trim())
}
if ($noteLines.Count -eq 0) {
    $noteLines.Add("稳定性改进与问题修复")
}

if ([string]::IsNullOrWhiteSpace($Mode)) {
    Write-Host ""
    Write-Host "请选择发布方式："
    Write-Host "  1. GitHub Actions 标准发布（推荐）"
    Write-Host "  2. 本机签名构建（GitHub 不可用时）"
    $modeChoice = Read-Host "直接回车选择 1"
    $Mode = if ($modeChoice -eq "2") { "local" } else { "github" }
}

function Set-FirstRegexValue {
    param(
        [string]$Path,
        [string]$Pattern,
        [string]$NewValue
    )
    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    $regex = [regex]::new($Pattern)
    if (-not $regex.IsMatch($content)) {
        throw "无法在 $Path 中找到版本字段"
    }
    $updated = $regex.Replace(
        $content,
        { param($match) $match.Groups[1].Value + $NewValue + $match.Groups[2].Value },
        1
    )
    Write-Utf8NoBom -Path $Path -Value $updated
}

Set-FirstRegexValue -Path (Join-Path $projectRoot "src-tauri\tauri.conf.json") -Pattern '("version"\s*:\s*")[^"]+("\s*,)' -NewValue $Version
Set-FirstRegexValue -Path (Join-Path $projectRoot "src-tauri\Cargo.toml") -Pattern '(?m)^(version\s*=\s*")[^"]+("\s*)$' -NewValue $Version
Set-FirstRegexValue -Path (Join-Path $projectRoot "package.json") -Pattern '("version"\s*:\s*")[^"]+("\s*,)' -NewValue $Version
Set-FirstRegexValue -Path (Join-Path $projectRoot "ui\package.json") -Pattern '("version"\s*:\s*")[^"]+("\s*,)' -NewValue $Version

$releaseNotes = @("# DoNiChannel $Version", "")
$releaseNotes += $noteLines | ForEach-Object { "- $_" }
Write-Utf8NoBom `
    -Path (Join-Path $projectRoot "RELEASE_NOTES.md") `
    -Value (($releaseNotes -join [Environment]::NewLine) + [Environment]::NewLine)

function Invoke-CheckedCommand {
    param(
        [string]$DisplayName,
        [scriptblock]$Command
    )
    Write-Host "`n==> $DisplayName" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$DisplayName 失败，退出码: $LASTEXITCODE。版本文件已修改，但尚未提交或发布。"
    }
}

Push-Location $projectRoot
try {
    if (-not $SkipChecks) {
        Invoke-CheckedCommand "前端测试" { npm test --prefix ui }
        Invoke-CheckedCommand "前端生产构建" { npm run build --prefix ui }
        Invoke-CheckedCommand "Python 后端测试" { python -m unittest discover -s tests -p "*_tests.py" -v }
        Invoke-CheckedCommand "Rust 格式检查" { cargo fmt --manifest-path src-tauri\Cargo.toml --all -- --check }
        Invoke-CheckedCommand "同步 Rust 锁文件" { cargo check --manifest-path src-tauri\Cargo.toml }
        Invoke-CheckedCommand "Rust 编译检查" { cargo check --manifest-path src-tauri\Cargo.toml --locked }
        Invoke-CheckedCommand "Rust 测试" { cargo test --manifest-path src-tauri\Cargo.toml --locked }
    }

    if ($Mode -eq "local") {
        $originalKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
        $originalKey = $env:TAURI_SIGNING_PRIVATE_KEY
        $originalPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
        try {
            if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY) -and [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)) {
                $keyPath = Read-Host "请输入 donichannel.key 的完整路径"
                if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
                    throw "私钥文件不存在: $keyPath"
                }
                $env:TAURI_SIGNING_PRIVATE_KEY_PATH = [IO.Path]::GetFullPath($keyPath)
            }
            if ($null -eq $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
                $securePassword = Read-Host "请输入签名密钥密码" -AsSecureString
                $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
                try {
                    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
                } finally {
                    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
                }
            }

            & (Join-Path $PSScriptRoot "Build-LanRelease.ps1")
            if ($LASTEXITCODE -ne 0) { throw "本地签名构建失败" }
        } finally {
            $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $originalKeyPath
            $env:TAURI_SIGNING_PRIVATE_KEY = $originalKey
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $originalPassword
        }

        $publishNow = Read-Host "是否把更新产物发布到当前项目的 downloads？仅在本机就是中心服务器时输入 y"
        if ($publishNow -match '^(y|yes)$') {
            & (Join-Path $PSScriptRoot "Publish-LanUpdate.ps1") -SourceDirectory (Join-Path $projectRoot "release-assets\v$Version")
            if ($LASTEXITCODE -ne 0) { throw "局域网更新发布失败" }
        }
        Write-Host "`n客户端本地发布准备完成。" -ForegroundColor Green
        exit 0
    }

    Write-Host "`n即将提交并推送以下修改：" -ForegroundColor Yellow
    git status --short
    Write-Host ""
    Write-Host "这会执行 git add -A、commit、push，并创建标签 v$Version。" -ForegroundColor Yellow
    $confirmation = Read-Host "确认发布请输入 RELEASE"
    if ($confirmation -cne "RELEASE") {
        Write-Host "已取消 GitHub 推送。版本和更新说明修改保留在本地。" -ForegroundColor Yellow
        exit 0
    }

    git rev-parse -q --verify "refs/tags/v$Version" *> $null
    if ($LASTEXITCODE -eq 0) {
        throw "标签 v$Version 已存在，请换一个版本号"
    }

    Invoke-CheckedCommand "暂存发布内容" { git add -A }
    Invoke-CheckedCommand "创建发布提交" { git commit -m "release: v$Version" }
    Invoke-CheckedCommand "推送当前分支" { git push origin HEAD }
    Invoke-CheckedCommand "创建发布标签" { git tag -a "v$Version" -m "DoNiChannel v$Version" }
    Invoke-CheckedCommand "推送发布标签" { git push origin "v$Version" }

    Write-Host "`n客户端 v$Version 已触发 GitHub Actions 构建。" -ForegroundColor Green
    Write-Host "构建完成后下载 Draft Release 的 latest.json、.nsis.zip、.sig 和 .exe，复制到中心服务器再运行 Publish-LanUpdate.ps1。"
} finally {
    Pop-Location
}

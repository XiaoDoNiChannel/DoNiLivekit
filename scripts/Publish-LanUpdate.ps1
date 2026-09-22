[CmdletBinding()]
param(
    [string]$SourceDirectory = "",

    [string]$DestinationDirectory = "",

    [string]$ServerBaseUrl = "http://10.126.126.67:5000"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
    $SourceDirectory = Read-Host "请输入包含 latest.json 和 .nsis.zip 的发布目录"
}

if ([string]::IsNullOrWhiteSpace($DestinationDirectory)) {
    $portableServerExe = Join-Path $PSScriptRoot "donichannel-backend.exe"
    $DestinationDirectory = if (Test-Path -LiteralPath $portableServerExe -PathType Leaf) {
        Join-Path $PSScriptRoot "downloads"
    } else {
        Join-Path $PSScriptRoot "..\downloads"
    }
}
if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
    throw "发布目录不能为空"
}

function Get-ArtifactFileName {
    param([Parameter(Mandatory = $true)][string]$Url)

    [Uri]$parsed = $null
    if ([Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$parsed)) {
        return [Uri]::UnescapeDataString([IO.Path]::GetFileName($parsed.AbsolutePath))
    }
    return [IO.Path]::GetFileName($Url)
}

$sourceRoot = (Resolve-Path -LiteralPath $SourceDirectory).Path
$manifestSource = Join-Path $sourceRoot "latest.json"
if (-not (Test-Path -LiteralPath $manifestSource -PathType Leaf)) {
    throw "未找到更新清单: $manifestSource"
}

$manifest = Get-Content -LiteralPath $manifestSource -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.version) {
    throw "latest.json 缺少 version"
}

$platformEntry = $manifest.platforms.'windows-x86_64'
if (-not $platformEntry) {
    $platformEntry = $manifest.platforms.PSObject.Properties |
        Where-Object { $_.Name -like 'windows-*' } |
        Select-Object -First 1 -ExpandProperty Value
}
if (-not $platformEntry -or -not $platformEntry.url -or -not $platformEntry.signature) {
    throw "latest.json 缺少 Windows 平台的 url 或 signature"
}

$artifactName = Get-ArtifactFileName -Url ([string]$platformEntry.url)
if ([string]::IsNullOrWhiteSpace($artifactName)) {
    throw "无法从 latest.json 解析更新包文件名"
}

$artifactSource = Join-Path $sourceRoot $artifactName
if (-not (Test-Path -LiteralPath $artifactSource -PathType Leaf)) {
    throw "latest.json 引用的更新包不存在: $artifactSource"
}

$destinationRoot = [IO.Path]::GetFullPath($DestinationDirectory)
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null

# 先发布二进制，最后原子替换 latest.json。这样客户端不会看到尚未上传完整的版本。
$artifactDestination = Join-Path $destinationRoot $artifactName
$artifactTemporary = "$artifactDestination.uploading"
Copy-Item -LiteralPath $artifactSource -Destination $artifactTemporary -Force
Move-Item -LiteralPath $artifactTemporary -Destination $artifactDestination -Force

$signatureSource = "$artifactSource.sig"
if (Test-Path -LiteralPath $signatureSource -PathType Leaf) {
    $signatureDestination = Join-Path $destinationRoot "$artifactName.sig"
    $signatureTemporary = "$signatureDestination.uploading"
    Copy-Item -LiteralPath $signatureSource -Destination $signatureTemporary -Force
    Move-Item -LiteralPath $signatureTemporary -Destination $signatureDestination -Force
}

$manifestDestination = Join-Path $destinationRoot "latest.json"
$manifestTemporary = "$manifestDestination.uploading"
Copy-Item -LiteralPath $manifestSource -Destination $manifestTemporary -Force
Move-Item -LiteralPath $manifestTemporary -Destination $manifestDestination -Force

$baseUrl = $ServerBaseUrl.TrimEnd('/')
$checkUrl = "$baseUrl/api/update/windows/x86_64/0.0.0"
$request = [Net.HttpWebRequest]::Create($checkUrl)
$request.Proxy = $null
$request.Timeout = 10000
$response = $request.GetResponse()
try {
    $statusCode = [int]$response.StatusCode
    if ($statusCode -ne 200) {
        throw "发布后更新接口返回 HTTP $statusCode"
    }
} finally {
    $response.Close()
}

Write-Host "已发布 DoNiChannel $($manifest.version)" -ForegroundColor Green
Write-Host "更新包: $artifactDestination"
Write-Host "清单:   $manifestDestination"
Write-Host "检查:   $checkUrl -> HTTP 200"

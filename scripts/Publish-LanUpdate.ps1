[CmdletBinding()]
param(
    [string]$SourceDirectory = "",

    [string]$DestinationDirectory = "",

    [string]$ServerBaseUrl = "http://10.126.126.67:5000"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($SourceDirectory)) {
    $SourceDirectory = Read-Host "请输入包含 latest.json、更新安装包和对应 .sig 的发布目录"
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

function Test-WindowsUpdaterArtifactName {
    param([Parameter(Mandatory = $true)][string]$Name)

    return $Name -match '(?i)(\.nsis\.zip|\.exe|\.msi)$'
}

function Find-SignedWindowsUpdaterArtifact {
    param([Parameter(Mandatory = $true)][string]$Directory)

    $candidates = @(
        Get-ChildItem -LiteralPath $Directory -File |
            Where-Object {
                $_.Name -ne "latest.json" -and
                $_.Name -notmatch '(?i)\.sig$' -and
                (Test-WindowsUpdaterArtifactName -Name $_.Name) -and
                (Test-Path -LiteralPath "$($_.FullName).sig" -PathType Leaf)
            }
    )

    if ($candidates.Count -eq 1) {
        return $candidates[0]
    }

    # 有多个 Windows 安装器时优先选择 NSIS。tauri-action 的 updaterJsonPreferNsis
    # 会让通用 windows-x86_64 条目指向这一类产物。
    $nsisCandidates = @(
        $candidates | Where-Object { $_.Name -match '(?i)(\.nsis\.zip|-setup\.exe)$' }
    )
    if ($nsisCandidates.Count -eq 1) {
        return $nsisCandidates[0]
    }

    $candidateNames = if ($candidates.Count -gt 0) {
        ($candidates | ForEach-Object { $_.Name }) -join ", "
    } else {
        "无"
    }
    throw "无法唯一确定 Windows 更新包。请确保目录中只有一套带 .sig 的更新安装包。候选文件: $candidateNames"
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Value
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Value, $encoding)
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

$manifestArtifactUrl = [string]$platformEntry.url
$artifactName = Get-ArtifactFileName -Url $manifestArtifactUrl
if ([string]::IsNullOrWhiteSpace($artifactName)) {
    throw "无法从 latest.json 解析更新包文件名"
}

$artifactSource = Join-Path $sourceRoot $artifactName
if (-not (Test-Path -LiteralPath $artifactSource -PathType Leaf)) {
    # tauri-action v1 的 latest.json 可能使用 GitHub API 资源地址，URL 末尾只有
    # 数字 asset id，而不是实际文件名。此时从同目录中带 .sig 的安装包反查。
    $artifactFile = Find-SignedWindowsUpdaterArtifact -Directory $sourceRoot
    $artifactName = $artifactFile.Name
    $artifactSource = $artifactFile.FullName
    Write-Host "latest.json 使用 GitHub 资源地址，已匹配本地更新包: $artifactName" -ForegroundColor Yellow
}

$destinationRoot = [IO.Path]::GetFullPath($DestinationDirectory)
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
$baseUrl = $ServerBaseUrl.TrimEnd('/')

# 服务端通过清单 URL 的最后一段定位本地文件。发布时把 GitHub API asset id
# 规范化为真实安装包文件名；签名值不变，仍然验证同一个安装包。
$escapedArtifactName = [Uri]::EscapeDataString($artifactName)
$platformEntry.url = "$baseUrl/downloads/$escapedArtifactName"

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
$manifestJson = ($manifest | ConvertTo-Json -Depth 100) + [Environment]::NewLine
Write-Utf8NoBom -Path $manifestTemporary -Value $manifestJson
Move-Item -LiteralPath $manifestTemporary -Destination $manifestDestination -Force

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

[CmdletBinding()]
param(
    [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$tauriConfigPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$tauriConfig.version

if ([string]::IsNullOrWhiteSpace($version)) {
    throw "src-tauri/tauri.conf.json 缺少 version"
}

$hasInlineKey = -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)
$hasKeyPath = -not [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)
if (-not $hasInlineKey -and -not $hasKeyPath) {
    throw "未设置 TAURI_SIGNING_PRIVATE_KEY 或 TAURI_SIGNING_PRIVATE_KEY_PATH"
}

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot "release-assets\v$version"
}
$releaseRoot = [IO.Path]::GetFullPath($OutputDirectory)

Push-Location $projectRoot
try {
    & npx tauri build --bundles nsis
    if ($LASTEXITCODE -ne 0) {
        throw "Tauri 构建失败，退出码: $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$bundleRoot = Join-Path $projectRoot "src-tauri\target\release\bundle"
$updaterArtifact = Get-ChildItem -LiteralPath $bundleRoot -Recurse -File |
    Where-Object {
        $_.Name -like "*.nsis.zip" -and
        (Test-Path -LiteralPath "$($_.FullName).sig" -PathType Leaf)
    } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

if (-not $updaterArtifact) {
    throw "没有找到带 .sig 的 .nsis.zip。请确认 createUpdaterArtifacts=true 且签名密钥正确。"
}

$signaturePath = "$($updaterArtifact.FullName).sig"
$signature = (Get-Content -LiteralPath $signaturePath -Raw -Encoding UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($signature)) {
    throw "签名文件为空: $signaturePath"
}

$installer = Get-ChildItem -LiteralPath $bundleRoot -Recurse -File -Filter "*.exe" |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Copy-Item -LiteralPath $updaterArtifact.FullName -Destination $releaseRoot -Force
Copy-Item -LiteralPath $signaturePath -Destination $releaseRoot -Force
if ($installer) {
    Copy-Item -LiteralPath $installer.FullName -Destination $releaseRoot -Force
}

$escapedArtifactName = [Uri]::EscapeDataString($updaterArtifact.Name)
$downloadUrl = "http://10.126.126.67:5000/downloads/$escapedArtifactName"
$releaseNotesPath = Join-Path $projectRoot "RELEASE_NOTES.md"
$releaseNotes = if (Test-Path -LiteralPath $releaseNotesPath -PathType Leaf) {
    (Get-Content -LiteralPath $releaseNotesPath -Raw -Encoding UTF8).Trim()
} else {
    "DoNiChannel $version"
}
$manifest = [ordered]@{
    version = $version
    notes = $releaseNotes
    pub_date = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = $signature
            url = $downloadUrl
        }
    }
}

$manifestPath = Join-Path $releaseRoot "latest.json"
$manifestJson = $manifest | ConvertTo-Json -Depth 6
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($manifestPath, $manifestJson + [Environment]::NewLine, $utf8NoBom)

Write-Host "本地签名发布产物已生成" -ForegroundColor Green
Write-Host "版本:     $version"
Write-Host "发布目录: $releaseRoot"
Write-Host "下一步:   .\scripts\Publish-LanUpdate.ps1 -SourceDirectory `"$releaseRoot`""

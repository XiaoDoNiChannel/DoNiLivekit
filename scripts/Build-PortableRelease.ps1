[CmdletBinding()]
param([string]$OutputDirectory = "")

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content (Join-Path $projectRoot 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$config.version
if ($version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') { throw 'Invalid release version' }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $projectRoot "release-assets\v$version"
}
$releaseRoot = [IO.Path]::GetFullPath($OutputDirectory)

Push-Location $projectRoot
try {
    & (Join-Path $PSScriptRoot 'Test-UpdaterSigningKey.ps1')
    & npx.cmd --no-install tauri build --no-bundle --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw "Portable build failed: $LASTEXITCODE" }
    $binary = Join-Path $projectRoot 'src-tauri\target\x86_64-pc-windows-msvc\release\app.exe'
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Binary not found: $binary" }
    [IO.Directory]::CreateDirectory($releaseRoot) | Out-Null
    $exePath = Join-Path $releaseRoot 'DoNiChannel.exe'
    Copy-Item -LiteralPath $binary -Destination $exePath -Force
    & npx.cmd --no-install tauri signer sign $exePath
    if ($LASTEXITCODE -ne 0) { throw "Portable signing failed: $LASTEXITCODE" }
    $signature = (Get-Content -LiteralPath "$exePath.sig" -Raw -Encoding UTF8).Trim()
    if ([string]::IsNullOrWhiteSpace($signature)) { throw 'Empty EXE signature' }
    $manifest = [ordered]@{
        version = $version
        notes = (Get-Content (Join-Path $projectRoot 'RELEASE_NOTES.md') -Raw -Encoding UTF8).Trim()
        pub_date = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')
        platforms = [ordered]@{
            'windows-x86_64-portable' = [ordered]@{
                signature = $signature
                url = "https://github.com/XiaoDoNiChannel/DoNiLivekit/releases/download/v$version/DoNiChannel.exe"
            }
        }
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 6
    [IO.File]::WriteAllText((Join-Path $releaseRoot 'latest-portable.json'), $manifestJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-Host "Portable release ready: $releaseRoot" -ForegroundColor Green
    Write-Host 'Upload DoNiChannel.exe, DoNiChannel.exe.sig and latest-portable.json to the matching GitHub Release.'
    Write-Host 'Users only need DoNiChannel.exe. Publish the Release to enable automatic updates.'
} finally {
    Pop-Location
}

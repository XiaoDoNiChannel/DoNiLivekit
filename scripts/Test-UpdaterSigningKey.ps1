[CmdletBinding()]
param(
    [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"

function Get-MinisignBlob {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Document,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    $lines = @(
        $Document -split "`r?`n" |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )

    if ($lines.Count -lt 2) {
        throw "$Description 格式无效：未找到 minisign 数据。"
    }

    try {
        return [Convert]::FromBase64String($lines[1].Trim())
    }
    catch {
        throw "$Description 格式无效：minisign 数据不是有效的 Base64。"
    }
}

function Get-MinisignKeyId {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Blob,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    if ($Blob.Length -lt 10) {
        throw "$Description 格式无效：无法读取密钥 ID。"
    }

    return [byte[]]$Blob[2..9]
}

function Format-MinisignKeyId {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$KeyId
    )

    $displayBytes = [byte[]]$KeyId.Clone()
    [Array]::Reverse($displayBytes)
    return (($displayBytes | ForEach-Object { $_.ToString("X2") }) -join "")
}

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
    $ConfigPath = Join-Path $projectRoot "src-tauri\tauri.conf.json"
}
else {
    $ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
}

if (
    [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY) -and
    [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)
) {
    throw "未配置 TAURI_SIGNING_PRIVATE_KEY 或 TAURI_SIGNING_PRIVATE_KEY_PATH。"
}

$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$encodedPublicKey = [string]$config.plugins.updater.pubkey
if ([string]::IsNullOrWhiteSpace($encodedPublicKey)) {
    throw "tauri.conf.json 未配置 plugins.updater.pubkey。"
}

try {
    $publicKeyDocument = [Text.Encoding]::UTF8.GetString(
        [Convert]::FromBase64String($encodedPublicKey.Trim())
    )
}
catch {
    throw "tauri.conf.json 中的更新公钥不是有效的 Base64。"
}

$publicKeyBlob = Get-MinisignBlob -Document $publicKeyDocument -Description "更新公钥"
$expectedKeyId = Get-MinisignKeyId -Blob $publicKeyBlob -Description "更新公钥"
$expectedKeyIdText = Format-MinisignKeyId -KeyId $expectedKeyId

$tempBasePath = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$probeDirectory = Join-Path $tempBasePath ("donichannel-updater-key-check-" + [Guid]::NewGuid().ToString("N"))
$probePath = Join-Path $probeDirectory "probe.txt"
$signaturePath = "$probePath.sig"

[IO.Directory]::CreateDirectory($probeDirectory) | Out-Null
[IO.File]::WriteAllText($probePath, "DoNiChannel updater signing key check", [Text.Encoding]::UTF8)

try {
    Push-Location $projectRoot
    try {
        & npx.cmd --no-install tauri signer sign $probePath 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "Tauri 签名探针失败，请检查 GitHub Actions 中的私钥和密码。"
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf)) {
        throw "Tauri 签名探针未生成签名文件。"
    }

    $encodedSignature = (Get-Content -LiteralPath $signaturePath -Raw -Encoding UTF8).Trim()
    try {
        $signatureDocument = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($encodedSignature)
        )
    }
    catch {
        throw "Tauri 生成的探针签名不是有效的 Base64。"
    }

    $signatureBlob = Get-MinisignBlob -Document $signatureDocument -Description "探针签名"
    $actualKeyId = Get-MinisignKeyId -Blob $signatureBlob -Description "探针签名"
    $actualKeyIdText = Format-MinisignKeyId -KeyId $actualKeyId

    if ([Convert]::ToBase64String($actualKeyId) -ne [Convert]::ToBase64String($expectedKeyId)) {
        throw "更新签名私钥与客户端公钥不匹配：客户端公钥 ID=$expectedKeyIdText，签名私钥 ID=$actualKeyIdText。请修正 GitHub Actions Secrets 后重新发布新版本。"
    }

    Write-Host "Updater signing key matches client public key: $expectedKeyIdText"
}
finally {
    $resolvedProbeDirectory = [IO.Path]::GetFullPath($probeDirectory)
    if (
        $resolvedProbeDirectory.StartsWith($tempBasePath, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedProbeDirectory).StartsWith("donichannel-updater-key-check-", [StringComparison]::Ordinal)
    ) {
        [IO.Directory]::Delete($resolvedProbeDirectory, $true)
    }
}

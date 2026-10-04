$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\Release-Git.ps1')

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

# Exercise actual native Git output under the Chinese Windows console code page.
$originalEncoding = [Console]::OutputEncoding
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$fixturePath = Join-Path $tempRoot ('release-git-encoding-' + [guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $fixturePath | Out-Null
    $init = Invoke-ReleaseGit -Arguments @('-C', $fixturePath, 'init', '--quiet')
    Assert-True ($init.ExitCode -eq 0) 'Fixture initialization failed'
    $productName = -join ([char[]]@(0x5C0F, 0x8C46, 0x6CE5, 0x7535, 0x7ADE))
    $json = '{"productName":"' + $productName + '","version":"0.1.5"}'
    $jsonPath = Join-Path $fixturePath 'config.json'
    [IO.File]::WriteAllText($jsonPath, $json, (New-Object Text.UTF8Encoding($false)))
    $blob = Invoke-ReleaseGit -Arguments @('-C', $fixturePath, 'hash-object', '-w', '--', $jsonPath)
    Assert-True ($blob.ExitCode -eq 0) 'Fixture blob creation failed'

    [Console]::OutputEncoding = [Text.Encoding]::GetEncoding(936)
    $result = Invoke-ReleaseGit -Arguments @('-C', $fixturePath, 'show', $blob.Lines[0])
    Assert-True ($result.ExitCode -eq 0) 'Git show failed'
    Assert-True ([Console]::OutputEncoding.CodePage -eq 936) 'Caller console encoding was not restored'
    $config = ($result.Lines -join "`n") | ConvertFrom-Json
    Assert-True ($config.productName -eq $productName) 'UTF-8 product name was corrupted'
    Assert-True ($config.version -eq '0.1.5') 'Release version could not be read'

    $missing = Invoke-ReleaseGit -Arguments @('-C', $fixturePath, 'show', 'refs/heads/missing-release-fixture')
    Assert-True ($missing.ExitCode -ne 0) 'Git failure exit code was lost'
    Assert-True ($missing.Lines.Count -gt 0) 'Git stderr was lost'
    Assert-True ([Console]::OutputEncoding.CodePage -eq 936) 'Encoding was not restored after Git failure'
} finally {
    [Console]::OutputEncoding = $originalEncoding
    $resolvedFixture = [IO.Path]::GetFullPath($fixturePath)
    $tempPrefix = $tempRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixture.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedFixture) -notlike 'release-git-encoding-*') {
        throw 'Refusing cleanup outside the temporary fixture directory'
    }
    if (Test-Path -LiteralPath $resolvedFixture) {
        Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
    }
}
Write-Host 'PASS: UTF-8 Git JSON survives a CP936 console; exit codes, stderr and caller encoding are preserved'

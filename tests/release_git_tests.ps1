$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\scripts\Release-Git.ps1')

# Simulate transport failures without contacting or modifying the real repository.
function Reset-Fixture {
    $script:commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    $script:otherCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    $script:remoteRefs = @{}
    $script:localTag = $null
    $script:commands = [Collections.Generic.List[string]]::new()
    $script:losePushResponse = $false
    $script:offline = $false
    $script:wrongVersion = $false
    $script:subject = 'release: v0.1.2'
}

function Invoke-ReleaseGit {
    param([string[]]$Arguments)
    $script:commands.Add($Arguments -join ' ')
    $code = 0
    $lines = @()
    switch ($Arguments[0]) {
        'rev-parse' {
            if ($Arguments[1] -eq 'HEAD') { $lines = @($script:commit) }
            elseif ($script:localTag) { $lines = @($script:localTag) }
            else { $code = 1 }
        }
        'symbolic-ref' { $lines = @('main') }
        'log' { $lines = @($script:subject) }
        'show' {
            if ($script:wrongVersion) { $version = '0.1.3' } else { $version = '0.1.2' }
            if ($Arguments[1].EndsWith('.toml')) { $lines = @("version = `"$version`"") }
            else { $lines = @("{`"version`":`"$version`"}") }
        }
        'ls-remote' {
            if ($script:offline) { $code = 1; break }
            foreach ($ref in $Arguments[2..3]) {
                if ($script:remoteRefs.ContainsKey($ref)) { $lines += "$($script:remoteRefs[$ref])`t$ref" }
            }
        }
        'push' {
            if ($script:offline) { $code = 1; break }
            if ($Arguments[2] -match '^(.+):(refs/heads/.+)$') {
                $script:remoteRefs[$Matches[2]] = $Matches[1]
            } else {
                $script:remoteRefs[$Arguments[2]] = 'cccccccccccccccccccccccccccccccccccccccc'
                $script:remoteRefs["$($Arguments[2])^{}"] = $script:localTag
            }
            if ($script:losePushResponse) { $code = 1; $lines = @('RPC failed: response lost') }
        }
        'tag' { $script:localTag = $Arguments[3] }
        default { throw "Unexpected Git call: $Arguments" }
    }
    return @{ ExitCode = $code; Lines = $lines }
}

function Start-Sleep { param($Seconds) }
function Assert-True { param([bool]$Condition, [string]$Message); if (-not $Condition) { throw $Message } }
function Assert-Throws {
    param([scriptblock]$Action)
    $threw = $false
    try { & $Action } catch { $threw = $true }
    Assert-True $threw 'Expected refusal/failure'
}

Reset-Fixture
$script:losePushResponse = $true
Publish-ReleaseCommit -Version '0.1.2'
Assert-True ($script:remoteRefs['refs/heads/main'] -eq $script:commit) 'Branch missing after lost response'
Assert-True ($script:remoteRefs['refs/tags/v0.1.2^{}'] -eq $script:commit) 'Tag missing after lost response'
Assert-True (@($script:commands | Where-Object { $_ -like 'push *' }).Count -eq 2) 'Verified push must not retry a successful mutation'
Write-Host 'PASS: lost push responses are verified for both branch and annotated tag'

$script:commands.Clear()
Publish-ReleaseCommit -Version '0.1.2'
Assert-True (@($script:commands | Where-Object { $_ -like 'push *' -or $_ -like 'tag *' }).Count -eq 0) 'Repeat must not create or push tags'
Write-Host 'PASS: resume is idempotent after completion'

Reset-Fixture
$script:remoteRefs['refs/heads/main'] = $script:commit
Publish-ReleaseCommit -Version '0.1.2'
Assert-True (@($script:commands | Where-Object { $_ -like 'push *' }).Count -eq 1) 'Only the missing tag should be pushed'
Write-Host 'PASS: existing branch with missing tag resumes the interrupted release'

Reset-Fixture
$script:localTag = $script:commit
$script:remoteRefs['refs/heads/main'] = $script:commit
Publish-ReleaseCommit -Version '0.1.2'
Assert-True (@($script:commands | Where-Object { $_ -like 'tag *' }).Count -eq 0) 'Existing local tag should be reused'
Write-Host 'PASS: a previously created local tag is reused'

Reset-Fixture
$script:localTag = $script:otherCommit
Assert-Throws { Publish-ReleaseCommit -Version '0.1.2' }
Assert-True (@($script:commands | Where-Object { $_ -like 'push *' }).Count -eq 0) 'Conflicting local tag must stop before push'
Write-Host 'PASS: conflicting local tag is refused'

Reset-Fixture
$script:remoteRefs['refs/heads/main'] = $script:commit
$script:remoteRefs['refs/tags/v0.1.2'] = $script:otherCommit
Assert-Throws { Publish-ReleaseCommit -Version '0.1.2' }
Assert-True (@($script:commands | Where-Object { $_ -like 'push *' }).Count -eq 0) 'Conflicting remote tag must not be pushed over'
Write-Host 'PASS: conflicting remote tag is refused'

Reset-Fixture
$script:offline = $true
Assert-Throws { Publish-ReleaseCommit -Version '0.1.2' }
Assert-True (@($script:commands | Where-Object { $_ -like 'push *' }).Count -eq 3) 'Network retries must be bounded'
Assert-True ($null -eq $script:localTag) 'Unverified branch must not create a release tag'
Write-Host 'PASS: network failures stop after three attempts'

Reset-Fixture
$script:wrongVersion = $true
Assert-Throws { Publish-ReleaseCommit -Version '0.1.2' }
Assert-True (@($script:commands | Where-Object { $_ -like 'push *' }).Count -eq 0) 'Version mismatch must stop before push'
Write-Host 'PASS: committed versions must match requested release'

Reset-Fixture
$script:subject = 'unrelated commit'
Assert-Throws { Publish-ReleaseCommit -Version '0.1.2' }
Assert-True (@($script:commands | Where-Object { $_ -like 'push *' }).Count -eq 0) 'Unrelated HEAD must not be published'
Write-Host 'PASS: unrelated HEAD is refused'

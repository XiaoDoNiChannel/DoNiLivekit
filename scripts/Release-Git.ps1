# Git 发布恢复：以远端 ref 为准，不能把连接中断等同于推送未生效。
function Invoke-ReleaseGit {
    param([string[]]$Arguments)
    # Windows PowerShell 会把原生命令的 stderr 包装成 ErrorRecord。
    $ErrorActionPreference = 'Continue'
    $output = @(& git @Arguments 2>&1 | ForEach-Object { "$_" })
    $code = $LASTEXITCODE
    return @{ ExitCode = $code; Lines = $output }
}

function Invoke-VerifiedReleasePush {
    param(
        [string]$RefSpec,
        [string]$RemoteRef,
        [string]$ExpectedCommit,
        [switch]$Tag
    )
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        # 推送前后都核对：上一次可能已成功，只是响应在途中丢失。
        foreach ($phase in @('before', 'after')) {
            if ($phase -eq 'after') {
                $push = Invoke-ReleaseGit -Arguments @('push', 'origin', $RefSpec)
                $push.Lines | ForEach-Object { Write-Host $_ }
            }
            $remote = Invoke-ReleaseGit -Arguments @('ls-remote', 'origin', $RemoteRef, "$RemoteRef^{}")
            if ($remote.ExitCode -eq 0) {
                $refs = @{}
                foreach ($line in $remote.Lines) {
                    if ($line -match '^([0-9a-f]+)\s+(refs/\S+)$') { $refs[$Matches[2]] = $Matches[1] }
                }
                $actual = $refs[$RemoteRef]
                if ($Tag -and $refs.ContainsKey("$RemoteRef^{}")) { $actual = $refs["$RemoteRef^{}"] }
                if ($actual -eq $ExpectedCommit) {
                    Write-Host "已核对远端 $RemoteRef -> $ExpectedCommit" -ForegroundColor Green
                    return
                }
                if ($Tag -and $actual) { throw "远端标签 $RemoteRef 已指向其他提交；不会覆盖。" }
            } else {
                $remote.Lines | ForEach-Object { Write-Warning $_ }
            }
        }
        if ($attempt -lt 3) {
            Write-Warning "暂时无法确认 $RemoteRef 推送成功，稍后重试（$attempt/3）。"
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
    throw "无法确认远端 $RemoteRef。提交和标签保留在本地；可联网后继续当前版本，勿重复升版本。"
}

function Publish-ReleaseCommit {
    param([string]$Version)
    $head = Invoke-ReleaseGit -Arguments @('rev-parse', 'HEAD')
    $branch = Invoke-ReleaseGit -Arguments @('symbolic-ref', '--quiet', '--short', 'HEAD')
    $subject = Invoke-ReleaseGit -Arguments @('log', '-1', '--format=%s')
    if ($head.ExitCode -ne 0 -or $branch.ExitCode -ne 0 -or $subject.ExitCode -ne 0) {
        throw '必须在待发布提交所属的本地分支上继续发布。'
    }
    $commit = $head.Lines[0]
    if ($subject.Lines[0] -ne "release: v$Version") { throw "HEAD 不是 release: v$Version，拒绝给其他提交打发布标签。" }
    foreach ($path in @('src-tauri/tauri.conf.json', 'package.json', 'ui/package.json', 'src-tauri/Cargo.toml')) {
        $file = Invoke-ReleaseGit -Arguments @('show', "${commit}:$path")
        if ($file.ExitCode -ne 0) { throw "无法读取发布提交中的 $path" }
        $content = $file.Lines -join "`n"
        if ($path.EndsWith('.json')) { $actualVersion = ($content | ConvertFrom-Json).version }
        else { $actualVersion = [regex]::Match($content, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value }
        if ($actualVersion -ne $Version) { throw "发布提交中的 $path 版本为 $actualVersion，与 $Version 不一致。" }
    }
    $tagRef = "refs/tags/v$Version"
    $localTag = Invoke-ReleaseGit -Arguments @('rev-parse', '--quiet', '--verify', "$tagRef^{commit}")
    if ($localTag.ExitCode -eq 0 -and $localTag.Lines[0] -ne $commit) {
        throw "本地标签 v$Version 已指向其他提交；不会覆盖。"
    }
    Invoke-VerifiedReleasePush -RefSpec "${commit}:refs/heads/$($branch.Lines[0])" -RemoteRef "refs/heads/$($branch.Lines[0])" -ExpectedCommit $commit
    if ($localTag.ExitCode -ne 0) {
        $created = Invoke-ReleaseGit -Arguments @('tag', '-a', "v$Version", $commit, '-m', "DoNiChannel v$Version")
        if ($created.ExitCode -ne 0) { throw "创建标签失败：$($created.Lines -join ' ')" }
    }
    Invoke-VerifiedReleasePush -RefSpec $tagRef -RemoteRef $tagRef -ExpectedCommit $commit -Tag
}

$ErrorActionPreference = "Stop"

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "请以管理员身份运行 OPEN_FIREWALL.cmd"
}

$rules = @(
    @{ Name = "DoNiChannel Center TCP"; Protocol = "TCP"; Ports = "5000,7880,7881" },
    @{ Name = "DoNiChannel Center UDP"; Protocol = "UDP"; Ports = "7882" }
)

foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "防火墙规则已存在：$($rule.Name)" -ForegroundColor Yellow
        continue
    }
    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Direction Inbound `
        -Action Allow `
        -Profile Any `
        -Protocol $rule.Protocol `
        -LocalPort $rule.Ports | Out-Null
    Write-Host "已创建防火墙规则：$($rule.Name)" -ForegroundColor Green
}

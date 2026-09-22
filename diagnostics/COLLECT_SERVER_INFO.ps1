$ErrorActionPreference = 'Continue'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -WorkingDirectory $PSScriptRoot
    exit 0
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outputPath = Join-Path $PSScriptRoot "DoNiChannel-network-diagnostic-$timestamp.txt"

function Add-Section {
    param(
        [string]$Title,
        [scriptblock]$Command
    )

    Add-Content -LiteralPath $outputPath -Value "`r`n===== $Title =====" -Encoding UTF8
    try {
        $result = & $Command 2>&1 | Out-String -Width 240
        if ([string]::IsNullOrWhiteSpace($result)) {
            $result = '(no output)'
        }
        Add-Content -LiteralPath $outputPath -Value $result.TrimEnd() -Encoding UTF8
    }
    catch {
        Add-Content -LiteralPath $outputPath -Value "ERROR: $($_.Exception.Message)" -Encoding UTF8
    }
}

Set-Content -LiteralPath $outputPath -Value @"
DoNiChannel server network diagnostic
Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')
This report does not intentionally collect EasyTier network passwords or API secrets.
"@ -Encoding UTF8

Add-Section 'Windows version' {
    Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
}

Add-Section 'Network adapters' {
    Get-NetAdapter | Sort-Object ifIndex | Select-Object Name, ifIndex, Status, InterfaceDescription, MacAddress, LinkSpeed
}

Add-Section 'IPv4 addresses' {
    Get-NetIPAddress -AddressFamily IPv4 | Sort-Object InterfaceIndex, IPAddress |
        Select-Object InterfaceAlias, InterfaceIndex, IPAddress, PrefixLength, AddressState
}

Add-Section 'Network profiles' {
    Get-NetConnectionProfile | Select-Object InterfaceAlias, InterfaceIndex, NetworkCategory, IPv4Connectivity
}

Add-Section 'EasyTier IPv4 routes' {
    Get-NetRoute -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -like 'et_*' -or $_.DestinationPrefix -eq '10.126.126.0/24' } |
        Sort-Object InterfaceIndex, DestinationPrefix |
        Select-Object InterfaceAlias, InterfaceIndex, DestinationPrefix, NextHop, RouteMetric, State
}

Add-Section 'DoNiChannel TCP listeners' {
    Get-NetTCPConnection -State Listen |
        Where-Object LocalPort -in 5000, 7880, 7881 |
        Sort-Object LocalPort |
        Select-Object LocalAddress, LocalPort, OwningProcess
}

Add-Section 'DoNiChannel UDP endpoint' {
    Get-NetUDPEndpoint |
        Where-Object LocalPort -eq 7882 |
        Select-Object LocalAddress, LocalPort, OwningProcess
}

Add-Section 'Listener processes' {
    $processIds = @(
        Get-NetTCPConnection -State Listen |
            Where-Object LocalPort -in 5000, 7880, 7881 |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    foreach ($processId in $processIds) {
        Get-Process -Id $processId -ErrorAction SilentlyContinue |
            Select-Object ProcessName, Id, Path, StartTime
    }
}

Add-Section 'DoNiChannel active firewall rules' {
    Get-NetFirewallRule -PolicyStore ActiveStore |
        Where-Object DisplayName -like 'DoNiChannel*' |
        Select-Object DisplayName, Enabled, Profile, Direction, Action, EnforcementStatus
}

Add-Section 'DoNiChannel firewall port filters' {
    Get-NetFirewallRule -PolicyStore ActiveStore |
        Where-Object DisplayName -like 'DoNiChannel*' |
        Get-NetFirewallPortFilter |
        Select-Object Protocol, LocalPort, RemotePort
}

Add-Section 'Firewall profiles' {
    Get-NetFirewallProfile -PolicyStore ActiveStore |
        Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction, AllowInboundRules, AllowLocalFirewallRules, LogAllowed, LogBlocked, LogFileName
}

Add-Section 'EasyTier processes' {
    Get-Process |
        Where-Object { $_.ProcessName -match '(?i)easy|tier' } |
        Select-Object ProcessName, Id, Path, Company, ProductVersion
}

Add-Section 'EasyTier services' {
    Get-CimInstance Win32_Service |
        Where-Object { $_.Name -match '(?i)easy|tier' -or $_.DisplayName -match '(?i)easy|tier' } |
        Select-Object Name, DisplayName, State, StartMode, PathName
}

Add-Section 'Local backend test via loopback' {
    $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5000/api/rooms' -TimeoutSec 5
    [PSCustomObject]@{ StatusCode = $response.StatusCode; Content = $response.Content }
}

Add-Section 'Local backend tests via EasyTier addresses' {
    $addresses = Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -like 'et_*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress -Unique

    foreach ($address in $addresses) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://$address`:5000/api/rooms" -TimeoutSec 5
            [PSCustomObject]@{ Address = $address; StatusCode = $response.StatusCode; Content = $response.Content; Error = '' }
        }
        catch {
            [PSCustomObject]@{ Address = $address; StatusCode = ''; Content = ''; Error = $_.Exception.Message }
        }
    }
}

Add-Section 'WinHTTP proxy' {
    & netsh.exe winhttp show proxy
}

Write-Host ''
Write-Host 'Diagnostic collection complete:' -ForegroundColor Green
Write-Host $outputPath -ForegroundColor Cyan
Write-Host ''
Write-Host 'Please send this TXT file together with one screenshot of the EasyTier peer/member list.' -ForegroundColor Yellow
Read-Host 'Press Enter to close'

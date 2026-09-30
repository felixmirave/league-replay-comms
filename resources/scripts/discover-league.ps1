$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$roots = @()
$processes = @()
$warnings = @()

# Fixed local queries only. Do not collect command lines or enumerate remote hosts.
try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'LeagueClient.exe' OR Name = 'League of Legends.exe'" -Property Name,ExecutablePath -OperationTimeoutSec 4 |
        ForEach-Object { @{ name = $_.Name; path = $_.ExecutablePath } })
} catch { $warnings += 'Running League installations could not be inspected. Folder selection remains available.' }

$registries = @(
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($registry in $registries) {
    if (-not (Test-Path -LiteralPath $registry)) { continue }
    try {
        foreach ($entry in (Get-ChildItem -LiteralPath $registry)) {
            $displayName = $entry.GetValue('DisplayName')
            if ($entry.PSChildName -like 'Riot Game league_of_legends*' -or $displayName -eq 'League of Legends') {
                $location = $entry.GetValue('InstallLocation')
                if ($location -is [string] -and $location.Length -gt 0) { $roots += $location }
            }
        }
    } catch { $warnings += 'Some installation records could not be inspected. Folder selection remains available.' }
}
@{ roots = @($roots | Select-Object -Unique); processes = @($processes); warnings = @($warnings | Select-Object -Unique) } | ConvertTo-Json -Depth 4 -Compress

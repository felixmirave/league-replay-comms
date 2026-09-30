param([Parameter(Mandatory = $true)][string]$RequestPath, [Parameter(Mandatory = $true)][string]$RequestSha256)
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'edit-replay-config.ps1'
# Values are file arguments to -File, never PowerShell source. Windows paths cannot
# contain a double quote. The elevated helper independently validates its request.
if ($helper.Contains('"') -or $RequestPath.Contains('"') -or $RequestSha256 -notmatch '^[0-9a-f]{64}$') { throw 'Invalid helper request.' }
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '" -RequestPath "' + $RequestPath + '" -RequestSha256 ' + $RequestSha256
try {
    $executable = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $child = Start-Process -FilePath $executable -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    exit $child.ExitCode
} catch {
    if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { exit 1223 }
    throw
}

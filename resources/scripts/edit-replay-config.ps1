param([Parameter(Mandatory = $true)][string]$RequestPath, [Parameter(Mandatory = $true)][string]$RequestSha256)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Stop-Edit([string]$Code, [string]$Message) {
    $errorObject = New-Object System.InvalidOperationException($Message)
    $errorObject.Data['CommsCode'] = $Code
    throw $errorObject
}
function Get-Digest([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Read-Stream([IO.FileStream]$Stream) {
    if ($Stream.Length -gt 1048576) { Stop-Edit 'invalid' 'Configuration or backup exceeds 1 MiB.' }
    $bytes = New-Object byte[] ([int]$Stream.Length)
    $Stream.Position = 0
    $offset = 0
    while ($offset -lt $bytes.Length) {
        $count = $Stream.Read($bytes, $offset, $bytes.Length - $offset)
        if ($count -eq 0) { Stop-Edit 'changed' 'File changed while being read. Refresh setup and try again.' }
        $offset += $count
    }
    return ,$bytes
}
function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $attributes = [IO.File]::GetAttributes($cursor)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Stop-Edit 'invalid' 'Automatic editing does not follow symbolic links or junctions. Use the manual config instructions.' }
        $parent = [IO.Directory]::GetParent($cursor)
        if ($null -eq $parent) { break }
        $cursor = $parent.FullName
    }
}
function Read-PlainFile([string]$Path) {
    Assert-PlainPath $Path
    $file = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { return ,(Read-Stream $file) } finally { $file.Dispose() }
}
function Write-NewFile([string]$Path, [byte[]]$Bytes) {
    $file = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $file.Write($Bytes, 0, $Bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
function Assert-HandleTarget([IO.FileStream]$Stream, [string]$ExpectedPath) {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return }
    if (-not ('ReplayComms.ConfigHandle' -as [type])) {
        # Only the Windows handle checks require interop. The application remains
        # TypeScript and uses the PowerShell/.NET runtime already supplied by Windows.
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace ReplayComms {
    public static class ConfigHandle {
        [StructLayout(LayoutKind.Sequential)] private struct Info {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info information);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
        public static void Verify(SafeFileHandle handle, string expected) {
            Info info;
            if (!GetFileInformationByHandle(handle, out info)) throw new Win32Exception();
            if (info.Links != 1) throw new IOException("Automatic editing refuses a configuration with multiple hard links.");
            var text = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, text, (uint)text.Capacity, 0);
            if (length == 0 || length >= text.Capacity) throw new Win32Exception();
            string actual = text.ToString();
            if (actual.StartsWith(@"\\?\")) actual = actual.Substring(4);
            if (!String.Equals(actual, Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase)) throw new IOException("The opened configuration path changed. Refresh setup before editing.");
        }
    }
}
'@
    }
    [ReplayComms.ConfigHandle]::Verify($Stream.SafeFileHandle, $ExpectedPath)
}
function Get-EnabledBytes([byte[]]$Bytes) {
    $bomLength = 0
    $encoding = New-Object System.Text.UTF8Encoding($false, $true)
    if ($Bytes.Length -ge 2 -and $Bytes[0] -eq 255 -and $Bytes[1] -eq 254) {
        if (($Bytes.Length % 2) -ne 0) { Stop-Edit 'invalid' 'Incomplete UTF-16 configuration. Use the manual config instructions.' }
        $bomLength = 2
        $encoding = New-Object System.Text.UnicodeEncoding($false, $false, $true)
    } elseif ($Bytes.Length -ge 3 -and $Bytes[0] -eq 239 -and $Bytes[1] -eq 187 -and $Bytes[2] -eq 191) { $bomLength = 3 }
    $text = $encoding.GetString($Bytes, $bomLength, $Bytes.Length - $bomLength)
    if ($text.Contains([string][char]0)) { Stop-Edit 'invalid' 'Unsupported configuration encoding.' }
    $general = $null; $setting = $null; $inside = $false
    foreach ($line in [regex]::Matches($text, '[^\r\n]*(?:\r\n|\n|\r|$)')) {
        if ($line.Length -eq 0) { continue }
        $stripped = [regex]::Replace($line.Value, '[\r\n]+$', '')
        $trimmed = $stripped.Trim()
        if (-not $trimmed -or $trimmed.StartsWith(';') -or $trimmed.StartsWith('#')) { continue }
        $section = [regex]::Match($stripped, '^[\t ]*\[([^\]\r\n]+)\][\t ]*(?:[;#].*)?$')
        if ($section.Success) {
            if ($inside) { $general.end = $line.Index }
            $inside = $section.Groups[1].Value.Trim().ToLowerInvariant() -eq 'general'
            if ($inside) {
                if ($null -ne $general) { Stop-Edit 'invalid' 'Multiple [General] sections require manual review.' }
                $general = @{ end = $text.Length }
            }
            continue
        }
        if ($trimmed.StartsWith('[')) { Stop-Edit 'invalid' 'Malformed configuration section.' }
        if (-not $inside) { continue }
        $key = [regex]::Match($stripped, '^([\t ]*EnableReplayApi[\t ]*=[\t ]*)([^;#]*)(.*)$', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        if (-not $key.Success) {
            if ($trimmed -match '^EnableReplayApi\b') { Stop-Edit 'invalid' 'Malformed EnableReplayApi setting.' }
            continue
        }
        if ($null -ne $setting) { Stop-Edit 'invalid' 'Duplicate EnableReplayApi settings require manual review.' }
        $value = $key.Groups[2].Value.Trim()
        if ($value -ne '0' -and $value -ne '1') { Stop-Edit 'invalid' 'EnableReplayApi must be 0 or 1.' }
        $setting = @{ value = $value; start = $line.Index + $key.Groups[1].Length + $key.Groups[2].Length - $key.Groups[2].Value.TrimStart().Length; length = $value.Length }
    }
    if ($null -ne $setting -and $setting.value -eq '1') { return ,$Bytes }
    $eolMatch = [regex]::Match($text, '\r\n|\n|\r')
    $eol = "`r`n"
    if ($eolMatch.Success) { $eol = $eolMatch.Value }
    if ($null -ne $setting) { $changed = $text.Substring(0, $setting.start) + '1' + $text.Substring($setting.start + $setting.length) }
    elseif ($null -ne $general) {
        $before = $text.Substring(0, $general.end)
        $separator = ''; if ($before -and $before -notmatch '[\r\n]$') { $separator = $eol }
        $changed = $before + $separator + 'EnableReplayApi=1' + $eol + $text.Substring($general.end)
    } else {
        $separator = ''; if ($text -and $text -notmatch '[\r\n]$') { $separator = $eol }
        $changed = $text + $separator + '[General]' + $eol + 'EnableReplayApi=1' + $eol
    }
    $body = $encoding.GetBytes($changed)
    $output = New-Object byte[] ($bomLength + $body.Length)
    [Array]::Copy($Bytes, 0, $output, 0, $bomLength)
    [Array]::Copy($body, 0, $output, $bomLength, $body.Length)
    return ,$output
}

$request = $null; $stream = $null; $backup = $null; $result = $null
try {
    if ((Get-Item -LiteralPath $RequestPath).Length -gt 131072) { Stop-Edit 'invalid' 'Invalid config edit request.' }
    $requestBytes = [IO.File]::ReadAllBytes($RequestPath)
    if ($RequestSha256 -notmatch '^[0-9a-f]{64}$' -or (Get-Digest $requestBytes) -ne $RequestSha256) { Stop-Edit 'changed' 'The prepared operation changed before the helper started. Refresh setup and try again.' }
    $request = [Text.Encoding]::UTF8.GetString($requestBytes) | ConvertFrom-Json
    if ($request.version -ne 1 -or $request.id -notmatch '^[0-9a-f-]{36}$' -or $request.expectedSha256 -notmatch '^[0-9a-f]{64}$' -or $request.action -notin @('enable', 'restore')) { Stop-Edit 'invalid' 'Invalid config edit request.' }
    $null = [Guid]::ParseExact($request.id, 'D')
    if ($request.relative -notin @('Config/game.cfg', 'Game/Config/game.cfg', 'DATA/CFG/game.cfg')) { Stop-Edit 'invalid' 'Unsupported configuration location.' }
    if (-not [IO.Path]::IsPathRooted($request.root) -or $request.root -match '[\x00-\x1f]') { Stop-Edit 'invalid' 'Choose a local League installation folder.' }
    $root = [IO.Path]::GetFullPath($request.root).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT -and $root -notmatch '^[a-zA-Z]:\\') { Stop-Edit 'invalid' 'Automatic editing requires a local drive path.' }
    Assert-PlainPath $root
    $markers = @('LeagueClient.exe', 'Game/League of Legends.exe', 'League of Legends.exe')
    $found = $false
    foreach ($marker in $markers) { if ([IO.File]::Exists([IO.Path]::Combine($root, $marker.Replace('/', [IO.Path]::DirectorySeparatorChar)))) { $found = $true } }
    if (-not $found) { Stop-Edit 'invalid' 'The selected folder is no longer a League installation.' }
    $config = [IO.Path]::Combine($root, $request.relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    Assert-PlainPath $config
    $attributes = [IO.File]::GetAttributes($config)
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { Stop-Edit 'invalid' 'The configuration path is a directory, not a regular file.' }
    if (($attributes -band [IO.FileAttributes]::ReadOnly) -ne 0) { Stop-Edit 'read-only' 'game.cfg is read-only. Remove that attribute deliberately or use the manual instructions; elevation will not change it.' }
    # FileShare.None is the Windows exclusion contract. Keep this handle through
    # backup, edit, verification, and any rollback; never unlock to replace by name.
    $stream = [IO.File]::Open($config, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    Assert-HandleTarget $stream $config
    $original = Read-Stream $stream
    $beforeSha = Get-Digest $original
    if ($beforeSha -ne $request.expectedSha256) { Stop-Edit 'changed' 'Configuration changed since inspection. Refresh setup before applying an edit.' }
    if ($request.action -eq 'enable') { $changed = Get-EnabledBytes $original }
    else {
        $null = [Guid]::ParseExact($request.backupId, 'D')
        $restorePath = $config + '.comms-' + $request.backupId + '.bak'
        $receiptPath = $config + '.comms-' + $request.backupId + '.json'
        $receipt = [Text.Encoding]::UTF8.GetString((Read-PlainFile $receiptPath)) | ConvertFrom-Json
        $changed = Read-PlainFile $restorePath
        if ($receipt.version -ne 1 -or $receipt.action -ne 'enable' -or $receipt.id -ne $request.backupId -or $receipt.root -ne $root -or $receipt.relative -ne $request.relative -or $receipt.beforeSha256 -ne (Get-Digest $changed) -or $receipt.afterSha256 -ne $beforeSha -or (Get-Digest (Get-EnabledBytes $changed)) -ne $beforeSha) { Stop-Edit 'changed' 'This backup no longer matches the current configuration. Later edits will not be overwritten. Use the backup file for manual recovery.' }
    }
    $afterSha = Get-Digest $changed
    if ($beforeSha -eq $afterSha) { $result = @{ version = 1; id = $request.id; ok = $true; changed = $false; beforeSha256 = $beforeSha; afterSha256 = $afterSha } }
    else {
        $backupId = [Guid]::NewGuid().ToString('D')
        $backupPath = $config + '.comms-' + $backupId + '.bak'
        $receiptPath = $config + '.comms-' + $backupId + '.json'
        $backup = @{ version = 1; id = $backupId; action = $request.action; root = $root; relative = $request.relative; path = $backupPath; beforeSha256 = $beforeSha; afterSha256 = $afterSha; createdAt = [DateTime]::UtcNow.ToString('o') }
        Write-NewFile $backupPath $original
        Write-NewFile $receiptPath ([Text.Encoding]::UTF8.GetBytes(($backup | ConvertTo-Json -Compress)))
        Assert-PlainPath $config
        Assert-HandleTarget $stream $config
        try {
            $stream.Position = 0; $stream.Write($changed, 0, $changed.Length); $stream.SetLength($changed.Length); $stream.Flush($true)
            if ((Get-Digest (Read-Stream $stream)) -ne $afterSha) { throw 'Configuration readback did not match the planned change.' }
        } catch {
            try {
                $stream.Position = 0; $stream.Write($original, 0, $original.Length); $stream.SetLength($original.Length); $stream.Flush($true)
                if ((Get-Digest (Read-Stream $stream)) -ne $beforeSha) { throw 'Rollback verification failed.' }
            } catch { Stop-Edit 'recovery-needed' ('The config write and rollback failed. Original bytes are backed up at ' + $backupPath) }
            Stop-Edit 'write-failed' 'The config write failed. Its original bytes were restored; retry after checking the drive.'
        }
        $result = @{ version = 1; id = $request.id; ok = $true; changed = $true; beforeSha256 = $beforeSha; afterSha256 = $afterSha; backup = $backup }
    }
} catch {
    $failure = $_.Exception
    $code = 'invalid'; $message = $failure.Message
    while ($null -ne $failure) {
        if ($failure.Data.Contains('CommsCode')) { $code = $failure.Data['CommsCode']; $message = $failure.Message; break }
        if ($failure -is [UnauthorizedAccessException]) { $code = 'permission'; $message = 'Windows permission is required to update this configuration and create its backup.' }
        elseif ($failure -is [IO.IOException] -and ($failure.HResult -band 65535) -in @(32, 33, 11)) { $code = 'busy'; $message = 'Configuration is in use. Close the replay and League client, then retry.' }
        elseif ($failure -is [IO.FileNotFoundException] -or $failure -is [IO.DirectoryNotFoundException]) { $code = 'missing'; $message = 'The configuration or backup is missing. Refresh setup; no replacement config was created.' }
        $failure = $failure.InnerException
    }
    $result = @{ version = 1; id = $request.id; ok = $false; code = $code; message = $message; backup = $backup }
} finally { if ($null -ne $stream) { $stream.Dispose() } }

# Result names are derived from an existing caller-created request. CreateNew
# refuses overwriting an existing result or following a planted result symlink.
Write-NewFile ($RequestPath + '.result.json') ([Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 5 -Compress)))

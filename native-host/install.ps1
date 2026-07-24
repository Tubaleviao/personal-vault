# Install the Personal Vault native messaging host on Windows.
#
# Usage (PowerShell, run as admin for system-wide install):
#   .\native-host\install.ps1 [-ExtensionId <chrome-extension-id>] [-BinaryPath <path>]
#
# The script:
#   1. Writes the host manifest JSON to %LOCALAPPDATA%\personal-vault\.
#   2. Registers the manifest path in HKCU\Software\Google\Chrome\NativeMessagingHosts.

param(
    [string]$ExtensionId = "EXTENSION_ID_PLACEHOLDER",
    [string]$BinaryPath = ""
)

$ErrorActionPreference = "Stop"

$HostName = "com.personal_vault"
$BinaryName = "personal-vault-native-host.exe"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition

# ── Locate binary ─────────────────────────────────────────────────────────────

if (-not $BinaryPath) {
    $ReleaseBin = Join-Path $ScriptDir "target\release\$BinaryName"
    $DebugBin   = Join-Path $ScriptDir "target\debug\$BinaryName"

    if (Test-Path $ReleaseBin) {
        $BinaryPath = (Resolve-Path $ReleaseBin).Path
    } elseif (Test-Path $DebugBin) {
        $BinaryPath = (Resolve-Path $DebugBin).Path
        Write-Warning "Using debug build. Run 'cargo build --release' in native-host/ for production."
    } else {
        Write-Error "Compiled binary not found. Build first:`n  cd native-host; cargo build --release"
        exit 1
    }
}

Write-Host "Using binary: $BinaryPath"

# ── Write manifest ────────────────────────────────────────────────────────────

$ManifestDir = Join-Path $env:LOCALAPPDATA "personal-vault\native-messaging"
New-Item -ItemType Directory -Force -Path $ManifestDir | Out-Null
$ManifestPath = Join-Path $ManifestDir "$HostName.json"

$manifest = @{
    name           = $HostName
    description    = "Personal Vault native messaging host — vault file I/O bridge"
    path           = $BinaryPath
    type           = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json -Depth 3

Set-Content -Path $ManifestPath -Value $manifest -Encoding UTF8
Write-Host "Manifest written to $ManifestPath"

# ── Register in the registry ──────────────────────────────────────────────────

$RegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name "(Default)" -Value $ManifestPath

# Also register for Chromium
$ChromiumRegPath = "HKCU:\Software\Chromium\NativeMessagingHosts\$HostName"
New-Item -Path $ChromiumRegPath -Force | Out-Null
Set-ItemProperty -Path $ChromiumRegPath -Name "(Default)" -Value $ManifestPath

Write-Host ""
Write-Host "Done. Reload your Chrome extension for the change to take effect."
if ($ExtensionId -eq "EXTENSION_ID_PLACEHOLDER") {
    Write-Host ""
    Write-Warning "Extension ID is a placeholder. Re-run with -ExtensionId <your-id> to enable the connection."
}

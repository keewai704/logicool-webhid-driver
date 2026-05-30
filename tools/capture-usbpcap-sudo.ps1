param(
  [int]$DurationSeconds = 20,
  [string]$OutputDirectory = ".\captures"
)

$ErrorActionPreference = "Stop"
$sudo = Get-Command sudo.exe -ErrorAction SilentlyContinue
if (!$sudo) {
  throw "Windows sudo.exe was not found. Run tools\capture-usbpcap-all.ps1 from an elevated PowerShell instead."
}

$script = Join-Path $PSScriptRoot "capture-usbpcap-all.ps1"
$resolvedOutput = if ([System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory
} else {
  Join-Path (Get-Location) $OutputDirectory
}

New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null

& $sudo.Source --new-window --chdir (Get-Location).Path powershell.exe `
  -NoProfile `
  -ExecutionPolicy Bypass `
  -File $script `
  -DurationSeconds $DurationSeconds `
  -OutputDirectory $resolvedOutput

Get-ChildItem -Path $resolvedOutput -Filter "capture-status-*.txt" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1 |
  ForEach-Object { Get-Content $_.FullName }

Get-ChildItem -Path $resolvedOutput -Filter "*.pcap" |
  Where-Object { $_.Length -gt 0 } |
  Sort-Object Length -Descending |
  Select-Object FullName, Length, LastWriteTime |
  Format-Table -AutoSize

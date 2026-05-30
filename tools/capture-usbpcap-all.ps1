param(
  [int]$DurationSeconds = 12,
  [string]$OutputDirectory = ".\captures"
)

$ErrorActionPreference = "Stop"
$usbpcap = "C:\Program Files\USBPcap\USBPcapCMD.exe"
if (!(Test-Path $usbpcap)) {
  throw "USBPcapCMD.exe was not found at $usbpcap"
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this PowerShell script as Administrator so USBPcap can start its kernel driver."
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$statusFile = Join-Path $OutputDirectory "capture-status-$timestamp.txt"
$interfacesFile = Join-Path $OutputDirectory "usbpcap-interfaces-$timestamp.txt"

"starting $(Get-Date -Format o)" | Set-Content -Encoding UTF8 $statusFile

try {
  sc.exe start USBPcap | Out-Null
} catch {
  # The service may already be running.
}

sc.exe query USBPcap | Add-Content -Encoding UTF8 $statusFile
$interfacesOutput = @(& $usbpcap --extcap-interfaces 2>&1)
Set-Content -Encoding UTF8 -Path $interfacesFile -Value $interfacesOutput
if (!($interfacesOutput -match "interface")) {
  @"
No USBPcap extcap interfaces are visible yet.
USBPcap is installed as a USB class upper filter, so Windows normally needs a reboot
or USB root-hub re-enumeration after installation before \\.\USBPcapN devices exist.
"@ | Add-Content -Encoding UTF8 $statusFile
}

$processes = @()
foreach ($i in 1..16) {
  $filter = "\\.\USBPcap$i"
  $file = Join-Path $OutputDirectory "usbpcap$i-$timestamp.pcap"
  $p = Start-Process -FilePath $usbpcap `
    -ArgumentList @("-d", $filter, "-o", $file, "-A", "--inject-descriptors") `
    -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 250
  if (!$p.HasExited) {
    $processes += [pscustomobject]@{ Process = $p; Filter = $filter; File = $file }
  } elseif (Test-Path $file) {
    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
  }
}

if (!$processes.Count) {
  "No USBPcap control devices stayed open." | Add-Content -Encoding UTF8 $statusFile
  throw "No USBPcap control devices stayed open. Reboot after USBPcap installation, then run this script again."
}

Write-Host "Capturing $($processes.Count) USBPcap filters for $DurationSeconds seconds..."
"capturing count=$($processes.Count) duration=$DurationSeconds" | Add-Content -Encoding UTF8 $statusFile
Start-Sleep -Seconds $DurationSeconds

foreach ($entry in $processes) {
  if (!$entry.Process.HasExited) {
    Stop-Process -Id $entry.Process.Id -Force
  }
}

Start-Sleep -Milliseconds 500
Get-ChildItem -Path $OutputDirectory -Filter "*-$timestamp.pcap" |
  Where-Object { $_.Length -gt 0 } |
  Sort-Object Length -Descending |
  Tee-Object -Variable nonEmpty |
  Select-Object FullName, Length, LastWriteTime |
  Format-Table -AutoSize

$nonEmpty |
  Select-Object FullName, Length, LastWriteTime |
  ConvertTo-Json |
  Set-Content -Encoding UTF8 (Join-Path $OutputDirectory "capture-files-$timestamp.json")
"done $(Get-Date -Format o) nonempty=$($nonEmpty.Count)" | Add-Content -Encoding UTF8 $statusFile

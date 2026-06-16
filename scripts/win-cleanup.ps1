# Tear the dogfood install off the Windows VM for a clean "live install when
# released". Removes the scheduled tasks, stops daemons, and deletes all staged
# binaries + state + transfer/smoke scripts. The dogfood data is ephemeral.
$ErrorActionPreference = "Continue"

Write-Output "=== stop + uninstall services (dev + prod labels) ==="
foreach ($label in @("co.goondocks.myco-dev", "co.goondocks.myco")) {
  schtasks /end /tn $label 2>&1 | Out-Null
  $r = schtasks /delete /tn $label /f 2>&1
  Write-Output ("  " + $label + " -> " + ($r -join " "))
}

Write-Output "=== stop any myco processes ==="
$procs = Get-Process myco -ErrorAction SilentlyContinue
if ($procs) { $procs | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Output ("  stopped " + $procs.Count + " process(es)") } else { Write-Output "  none running" }
Start-Sleep -Milliseconds 800

Write-Output "=== remove staged binaries, state, and scripts ==="
$targets = @(
  (Join-Path $env:USERPROFILE ".myco"),
  (Join-Path $env:USERPROFILE "myco-dev"),
  (Join-Path $env:USERPROFILE "myco.exe"),
  (Join-Path $env:USERPROFILE "ui.tgz"),
  (Join-Path $env:USERPROFILE "win-dev-link.ps1"),
  (Join-Path $env:USERPROFILE "win-smoke.ps1"),
  (Join-Path $env:USERPROFILE "win-catch.ps1"),
  (Join-Path $env:USERPROFILE "win-diag.ps1"),
  (Join-Path $env:USERPROFILE "win-diag2.ps1"),
  (Join-Path $env:USERPROFILE "win-diag3.ps1"),
  (Join-Path $env:USERPROFILE "win-drain-test.ps1"),
  (Join-Path $env:USERPROFILE "win-drain-test2.ps1"),
  (Join-Path $env:USERPROFILE "win-cleanup.ps1")
)
foreach ($t in $targets) {
  if (Test-Path $t) { Remove-Item $t -Recurse -Force -ErrorAction SilentlyContinue; Write-Output ("  removed " + $t) }
}

Write-Output "=== verify clean ==="
Write-Output ("  .myco exists: " + (Test-Path (Join-Path $env:USERPROFILE ".myco")))
Write-Output ("  myco-dev exists: " + (Test-Path (Join-Path $env:USERPROFILE "myco-dev")))
$leftTask = schtasks /query /tn co.goondocks.myco-dev 2>&1
$taskState = "still present"
if ($leftTask -match "ERROR") { $taskState = "gone" }
Write-Output ("  dev task: " + $taskState)
$leftProc = Get-Process myco -ErrorAction SilentlyContinue
$procCount = 0
if ($leftProc) { $procCount = @($leftProc).Count }
Write-Output ("  myco processes: " + $procCount)
Write-Output "=== VM CLEAN ==="

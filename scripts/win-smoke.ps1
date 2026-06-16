# Windows live-smoke for the beta-hardening audit fixes.
# Installs the supervised Task Scheduler service, confirms steady-state health,
# then drives `service restart --dev` and checks daemon.log for the cooperative
# drain (proves #4 drains over /api/shutdown before schtasks /end on Windows).
$ErrorActionPreference = "Continue"
$bin = Join-Path $env:USERPROFILE "myco-dev\packages\myco-windows-x64\bin\myco.exe"
if (-not (Test-Path $bin)) { Write-Output "FAIL no binary at $bin"; exit 1 }
$md = Join-Path $env:USERPROFILE ".myco"

function Get-DaemonPort {
  $dj = Get-ChildItem -Recurse -Path $md -Filter daemon.json -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($dj) { return (Get-Content $dj.FullName -Raw | ConvertFrom-Json).port } else { return $null }
}
function Get-DaemonPid([int]$port) {
  try { return ((Invoke-WebRequest ("http://127.0.0.1:" + $port + "/health") -UseBasicParsing -TimeoutSec 3).Content | ConvertFrom-Json).pid } catch { return $null }
}
function Wait-Healthy([int]$excludePid) {
  for ($i = 1; $i -le 45; $i++) {
    Start-Sleep -Seconds 1
    $p = Get-DaemonPort
    if (-not $p) { continue }
    $dp = Get-DaemonPid $p
    if ($dp -and ($dp -ne $excludePid)) { return @($p, $dp) }
  }
  return $null
}

# Clean slate: stop any bare dogfood daemon from win-dev-link.
Get-Process myco -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

Write-Output "=== service install --dev (Task Scheduler + crash supervisor) ==="
& $bin service install --dev 2>&1 | ForEach-Object { Write-Output ("  " + $_) }

$r = Wait-Healthy 0
if (-not $r) { Write-Output "FAIL: supervised daemon not healthy within 45s"; exit 1 }
$port = $r[0]; $pid0 = $r[1]
Write-Output ("HEALTHY port=" + $port + " pid=" + $pid0)

# Steady-state: 4 consecutive health OK (supervisor should hold it up under emulation).
$ok = 0
for ($j = 1; $j -le 5; $j++) { Start-Sleep -Seconds 2; try { if ((Invoke-WebRequest ("http://127.0.0.1:" + $port + "/health") -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $ok++ } } catch { } }
Write-Output ("STEADY health ok=" + $ok + "/5")

# /api/shutdown route present (GET -> 405 method_not_allowed).
try { Invoke-WebRequest ("http://127.0.0.1:" + $port + "/api/shutdown") -UseBasicParsing -TimeoutSec 4 | Out-Null }
catch { Write-Output ("GET /api/shutdown -> " + $_.Exception.Response.StatusCode.value__ + " (405 = route present, POST-only)") }

# Restart through the service (this is the path that used to hard-kill w/o drain).
$pidBefore = Get-DaemonPid $port
Write-Output ("=== service restart --dev (pid before = " + $pidBefore + ") ===")
& $bin service restart --dev 2>&1 | ForEach-Object { Write-Output ("  " + $_) }

$r2 = Wait-Healthy $pidBefore
if ($r2) { Write-Output ("RECOVERED port=" + $r2[0] + " pid=" + $r2[1]) } else { Write-Output "FAIL: daemon did not recover on a new pid within 45s" }

Start-Sleep -Seconds 2
Write-Output "=== drain evidence in daemon.log (cooperative shutdown drained before kill) ==="
$logf = Get-ChildItem -Recurse -Path $md -Filter daemon.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($logf) {
  Get-Content $logf.FullName | Select-String -Pattern "shutdown-request|drain at shutdown|Lifecycle lock released|Server stopped" | Select-Object -Last 10 | ForEach-Object { Write-Output ("  " + $_.Line) }
} else { Write-Output "  (no daemon.log found)" }

Write-Output "=== doctor ==="
& $bin doctor 2>&1 | Select-String -Pattern "Capture|Daemon|Service|Database|Hooks|Symbionts" | ForEach-Object { Write-Output ("  " + $_.Line) }

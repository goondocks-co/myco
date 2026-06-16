$ErrorActionPreference = "Continue"
$md = Join-Path $env:USERPROFILE ".myco"
$label = "co.goondocks.myco-dev"

function Get-NewestDaemonJson { Get-ChildItem -Recurse -Path $md -Filter daemon.json -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }

# Up to 10 fresh task starts (each resets the supervisor's retry budget); poll
# hard for a healthy window, then immediately POST /api/shutdown to observe the
# cooperative drain directly (bypasses the variant/port-resolver question).
$port = $null
for ($attempt = 1; $attempt -le 10; $attempt++) {
  schtasks /end /tn $label 2>&1 | Out-Null
  Start-Sleep -Milliseconds 500
  schtasks /run /tn $label 2>&1 | Out-Null
  for ($i = 1; $i -le 12; $i++) {
    Start-Sleep -Seconds 1
    $dj = Get-NewestDaemonJson
    if (-not $dj) { continue }
    $st = Get-Content $dj.FullName -Raw | ConvertFrom-Json
    try { $h = Invoke-WebRequest ("http://127.0.0.1:" + $st.port + "/health") -UseBasicParsing -TimeoutSec 2 } catch { continue }
    if ($h.StatusCode -eq 200) { $port = $st.port; $pidNow = ($h.Content | ConvertFrom-Json).pid; break }
  }
  if ($port) { Write-Output ("CAUGHT healthy window on attempt " + $attempt + ": port=" + $port + " pid=" + $pidNow); break }
}
if (-not $port) { Write-Output "could not catch a healthy window in 10 attempts (emulation crash too aggressive)"; exit 1 }

# Confirm the route, then drive the cooperative drain directly.
try { Invoke-WebRequest ("http://127.0.0.1:" + $port + "/api/shutdown") -UseBasicParsing -TimeoutSec 3 | Out-Null }
catch { Write-Output ("GET /api/shutdown -> " + $_.Exception.Response.StatusCode.value__ + " (405 = route present, POST-only)") }

Write-Output "=== POST /api/shutdown (the cooperative drain) ==="
try { $s = Invoke-WebRequest ("http://127.0.0.1:" + $port + "/api/shutdown") -Method POST -UseBasicParsing -TimeoutSec 5; Write-Output ("POST -> " + $s.StatusCode + " " + $s.Content) }
catch { Write-Output ("POST -> " + $_.Exception.Message) }

# Give it time to drain + exit.
Start-Sleep -Seconds 5
$still = $null
try { $still = (Invoke-WebRequest ("http://127.0.0.1:" + $port + "/health") -UseBasicParsing -TimeoutSec 2).StatusCode } catch { $still = "down" }
Write-Output ("daemon after shutdown: " + $still + " (down/connection-error = drained + exited)")

Write-Output "=== drain evidence in daemon.log ==="
$dl = Get-ChildItem -Recurse -Path $md -Filter daemon.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($dl) { Get-Content $dl.FullName | Select-String -Pattern "shutdown-request received|drain at shutdown|Lifecycle lock released|Server stopped" | Select-Object -Last 10 | ForEach-Object { Write-Output ("  LOG> " + $_.Line) } }

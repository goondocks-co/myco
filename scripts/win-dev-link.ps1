# Windows dev-link (host side). Invoked by `make dev-link-windows`.
#
# Mirrors macOS `make dev-link`: stage the dev binary + UI bundle in the
# layout the daemon already resolves (findCorePackageRoot walks from the binary
# to a sibling `packages/myco/` core holding `dist/ui`), pin
# `~/.myco/runtime.command` to the binary, and start the daemon. There is no
# Windows-specific wiring here — the daemon's first start runs the same
# `runGlobalBootstrap` (Grove + launchers + symbionts) as every platform.
$ErrorActionPreference = "Stop"
$userHome = $env:USERPROFILE
$base = Join-Path $userHome "myco-dev"
$platBin = Join-Path $base "packages\myco-windows-x64\bin"
$core = Join-Path $base "packages\myco"
New-Item -ItemType Directory -Force -Path $platBin, (Join-Path $core "dist") | Out-Null

if (-not (Test-Path (Join-Path $userHome "myco.exe"))) { throw "myco.exe not transferred (run via 'make dev-link-windows')" }
Move-Item -Force (Join-Path $userHome "myco.exe") (Join-Path $platBin "myco.exe")
# Minimal package.json markers so findCorePackageRoot resolves the core + dist/ui.
[IO.File]::WriteAllText((Join-Path $base "packages\myco-windows-x64\package.json"), '{"name":"@goondocks/myco-windows-x64"}')
[IO.File]::WriteAllText((Join-Path $core "package.json"), '{"name":"@goondocks/myco"}')
if (Test-Path (Join-Path $userHome "ui.tgz")) { tar -xf (Join-Path $userHome "ui.tgz") -C (Join-Path $core "dist") }

$bin = Join-Path $platBin "myco.exe"
$md = Join-Path $userHome ".myco"
New-Item -ItemType Directory -Force -Path $md | Out-Null
[IO.File]::WriteAllText((Join-Path $md "runtime.command"), $bin)
Write-Host "OK runtime.command -> $bin"
Write-Host ("UI staged: " + (Test-Path (Join-Path $core "dist\ui\index.html")))

# Start the daemon DETACHED so it survives this SSH session. Windows OpenSSH
# kills a session's child process tree on disconnect, so Start-Process won't
# persist. Win32_Process.Create spawns a process not tied to the SSH job. (The
# durable answer is the Windows service manager in a later phase; this is the
# dogfood equivalent of macOS launchd-vs-shell.) First start bootstraps the
# Grove + launchers + symbionts.
Get-Process myco -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$bin`" daemon" } | Out-Null
$port = $null
for ($i = 1; $i -le 30; $i++) {
  Start-Sleep -Seconds 1
  $dj = Get-ChildItem -Recurse -Path $md -Filter daemon.json -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $dj) { continue }
  $port = (Get-Content $dj.FullName -Raw | ConvertFrom-Json).port
  try { if ((Invoke-WebRequest "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { break } } catch { }
}
if ($port) {
  Write-Host "DAEMON RUNNING port=$port  ->  http://127.0.0.1:$port/"
  try { $r = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 6; Write-Host ("UI / : status=" + $r.StatusCode + " bytes=" + $r.Content.Length) }
  catch { Write-Host ("UI / : " + $_.Exception.Message) }
} else {
  Write-Host "daemon did not come up within 30s"
}

# Smoke a Windows ARM64 Myco binary on a Windows ARM64 machine.
#
# The binary is a native ARM64 executable; it reports its version, runs a member verb, and refuses to host a
# Deployment, naming what to do instead, without writing anything. Every command runs against a scratch home that is
# removed afterwards. Runs under Windows PowerShell 5.1 and PowerShell 7.
#
# Usage: ./scripts/windows-arm64-smoke.ps1 -Executable <path to myco-windows-arm64.exe> [-Version <expected version>]

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$Executable = (Resolve-Path -LiteralPath $Executable).Path

$machine = (Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE).PROCESSOR_ARCHITECTURE
if ($machine -ne 'ARM64') { throw "This smoke runs on Windows ARM64; this machine is $machine." }

# The PE header names the machine the executable was built for: 0xAA64 is ARM64, 0x8664 is x64.
$stream = [System.IO.File]::OpenRead($Executable)
try {
    $header = New-Object byte[] 4096
    [void]$stream.Read($header, 0, $header.Length)
} finally { $stream.Dispose() }
$peOffset = [BitConverter]::ToInt32($header, 0x3C)
$peMachine = [BitConverter]::ToUInt16($header, $peOffset + 4)
if ($peMachine -ne 0xAA64) { throw ('{0} is not an ARM64 executable (PE machine 0x{1:X4}).' -f $Executable, $peMachine) }
Write-Host 'ok: native ARM64 executable'

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ('myco-arm64-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$homes = @{
    HOME = $scratch; USERPROFILE = $scratch; MYCO_HOME = (Join-Path $scratch '.myco')
    CODEX_HOME = (Join-Path $scratch '.codex'); CLAUDE_CONFIG_DIR = (Join-Path $scratch '.claude')
    XDG_CONFIG_HOME = (Join-Path $scratch '.config'); LOCALAPPDATA = (Join-Path $scratch 'AppData\Local')
    APPDATA = (Join-Path $scratch 'AppData\Roaming'); MYCO_LAUNCH_AGENTS_DIR = (Join-Path $scratch 'service-units')
    MYCO_TEAM_HOME = (Join-Path $scratch '.myco-team'); NO_COLOR = '1'
}
$saved = @{}
foreach ($name in $homes.Keys) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $homes[$name], 'Process')
}

function Invoke-Myco {
    param([string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = (& $Executable @Arguments 2>&1 | Out-String)
        return [PSCustomObject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    } finally { $ErrorActionPreference = $previous }
}

try {
    $reported = Invoke-Myco @('--version')
    if ($reported.ExitCode -ne 0) { throw "myco --version exited $($reported.ExitCode): $($reported.Output)" }
    if ($Version -and $reported.Output.Trim() -cne $Version) { throw "myco --version reported $($reported.Output.Trim()), expected $Version." }
    Write-Host "ok: myco --version -> $($reported.Output.Trim())"

    $refused = Invoke-Myco @('server', 'create', '--target', 'local')
    if ($refused.ExitCode -eq 0) { throw "myco server create --target local succeeded on Windows ARM64: $($refused.Output)" }
    foreach ($expected in @('Myco for Windows ARM64 does not carry the SQLite libraries', 'Nothing was changed.', 'myco setup --create cloudflare')) {
        if (-not $refused.Output.Contains($expected)) { throw "The refusal does not say '$expected': $($refused.Output)" }
    }
    $written = @(Get-ChildItem -LiteralPath $homes.MYCO_HOME -Recurse -File -ErrorAction SilentlyContinue)
    if ($written.Count -gt 0) { throw "The refused create wrote $($written.Count) file(s) under $($homes.MYCO_HOME)." }
    Write-Host 'ok: myco server create --target local refuses and writes nothing'

    $doctor = Invoke-Myco @('doctor')
    if ($doctor.ExitCode -ne 0 -or $doctor.Output -notmatch 'myco doctor \(member\)') { throw "myco doctor exited $($doctor.ExitCode): $($doctor.Output)" }
    Write-Host 'ok: myco doctor runs'
} finally {
    foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Host 'Windows ARM64 smoke passed.'

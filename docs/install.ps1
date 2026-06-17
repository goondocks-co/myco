# Myco installer for Windows x64 — https://myco.sh
# Usage: irm https://myco.sh/install.ps1 | iex
#
# Env overrides:
#   MYCO_CHANNEL   — "stable" (default) or "beta"
#   GITHUB_TOKEN   — or GH_TOKEN — avoid GitHub API rate limits
#
# Requires Windows PowerShell 5.1+ (ships with Windows 10/11).

[CmdletBinding()]
param(
    [string]$Channel = ""
)

$Repo    = "goondocks-co/myco"
$BinDir  = "$env:LOCALAPPDATA\Myco\bin"
$Exe     = "$BinDir\myco.exe"
$Asset   = "myco-windows-x64.exe"
$Marker  = "$env:USERPROFILE\.myco\install.json"

# ---------------------------------------------------------------------------
# Architecture check — x64 only (AMD64 in Windows terms)
# ---------------------------------------------------------------------------
$arch = $env:PROCESSOR_ARCHITECTURE
# WOW64: 32-bit process on 64-bit OS — check the native arch
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }

if ($arch -eq "ARM64") {
    Write-Host "Myco does not support Windows on ARM (ARM64) at this time." -ForegroundColor Red
    Write-Host "  x64 native Windows is required." -ForegroundColor Red
    exit 1
}

if ($arch -ne "AMD64") {
    Write-Host "Unsupported processor architecture: $arch" -ForegroundColor Red
    Write-Host "  Myco requires a 64-bit (x64) Windows machine." -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------------------
# Channel resolution
# ---------------------------------------------------------------------------
if ($Channel -eq "") {
    $Channel = if ($env:MYCO_CHANNEL) { $env:MYCO_CHANNEL } else { "stable" }
}
if ($Channel -ne "stable" -and $Channel -ne "beta") {
    Write-Host "Unknown channel '$Channel'. Use 'stable' or 'beta'." -ForegroundColor Red
    exit 1
}

# Ensure TLS 1.2 is enabled — PowerShell 5.1 on older Windows (pre-1709 / Server 2016)
# does not include it by default, causing SSL/TLS failures against api.github.com.
# -bor preserves existing protocols; this is a no-op on newer Windows.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

Write-Host "Myco installer — windows-x64 / channel: $Channel" -ForegroundColor Cyan
Write-Host "Windows support is beta. Report issues at https://github.com/$Repo/issues" -ForegroundColor Yellow
Write-Host ""

# ---------------------------------------------------------------------------
# GitHub API helpers — token-aware, token never printed
# ---------------------------------------------------------------------------
function Get-AuthHeaders {
    $tok = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else { "" }
    $h = @{
        'User-Agent' = 'myco-installer/goondocks-co/myco'
        'Accept'     = 'application/vnd.github+json'
    }
    if ($tok -ne "") { $h['Authorization'] = "Bearer $tok" }
    return $h
}

function Invoke-GhApi {
    param([string]$Url)
    $headers = Get-AuthHeaders
    try {
        $resp = Invoke-WebRequest -Uri $Url -Headers $headers -UseBasicParsing -ErrorAction Stop
        return $resp
    } catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 403 -or $status -eq 429) {
            Write-Host "GitHub API rate limit hit (HTTP $status)." -ForegroundColor Red
            Write-Host "  Set GITHUB_TOKEN (or GH_TOKEN) to a personal access token and retry:" -ForegroundColor Red
            Write-Host "    `$env:GITHUB_TOKEN='ghp_...' ; irm https://myco.sh/install.ps1 | iex" -ForegroundColor Red
            exit 1
        }
        Write-Host "GitHub API request failed: $_" -ForegroundColor Red
        exit 1
    }
}

function Invoke-GhDownload {
    param([string]$Url, [string]$OutFile)
    $headers = Get-AuthHeaders
    try {
        Invoke-WebRequest -Uri $Url -Headers $headers -OutFile $OutFile -UseBasicParsing -ErrorAction Stop
    } catch {
        Write-Host "Download failed from $Url : $_" -ForegroundColor Red
        exit 1
    }
}

# ---------------------------------------------------------------------------
# Release selection — Select-MycoRelease
#   Filters releases to the myco/v* namespace (excludes myco-team/*, myco-collective/*)
#   Stable: highest non-prerelease; Beta: max(stable, prerelease) no-downgrade.
#   Parses Major.Minor.Patch as [int] via .Split('.') — no [version] or [semver] needed.
# ---------------------------------------------------------------------------
function Select-MycoRelease {
    param(
        [object[]]$Releases,
        [string]$Channel
    )

    $candidates = @()

    foreach ($r in $Releases) {
        $tag = $r.tag_name
        # Accept only myco/v* (exact prefix — excludes myco-team/v* myco-collective/v*)
        if ($tag -notmatch '^myco/v') { continue }

        $version = $tag -replace '^myco/v', ''

        # Must start with a numeric semver core
        if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+') { continue }

        $isPre = ($r.prerelease -eq $true) -or ($version -match '-')

        # Channel gate
        if ($Channel -eq 'stable' -and $isPre) { continue }

        # Split core from prerelease identifiers, then strip any +build metadata.
        # e.g. "1.2.3+build.1" -> core="1.2.3"; "1.2.3-beta.1+build" -> core="1.2.3", pre="beta.1"
        $dashIdx   = $version.IndexOf('-')
        $core      = if ($dashIdx -ge 0) { $version.Substring(0, $dashIdx) } else { $version }
        $preStr    = if ($dashIdx -ge 0) { $version.Substring($dashIdx + 1) } else { "" }
        # Strip +build metadata from core (e.g. "1.2.3+build" -> "1.2.3")
        $plusIdx = $core.IndexOf('+')
        if ($plusIdx -ge 0) { $core = $core.Substring(0, $plusIdx) }
        # Strip +build metadata from prerelease string (e.g. "beta.1+build" -> "beta.1")
        $plusIdx = $preStr.IndexOf('+')
        if ($plusIdx -ge 0) { $preStr = $preStr.Substring(0, $plusIdx) }

        $parts = $core.Split('.')
        $major = [int]$parts[0]
        $minor = [int]$parts[1]
        $patch = [int]$parts[2]

        # RelRank: 1 for release, 0 for prerelease (so release beats its own prerelease)
        $relRank = if ($isPre) { 0 } else { 1 }

        # PreKey: zero-pad numeric identifiers so lexicographic order == numeric order
        # e.g. "beta.2" -> "beta.0000000002", "beta.10" -> "beta.0000000010"
        $preKey = ""
        if ($preStr -ne "") {
            $preIds = $preStr.Split('.')
            $paddedIds = @()
            foreach ($id in $preIds) {
                if ($id -match '^[0-9]+$') {
                    $paddedIds += $id.PadLeft(10, '0')
                } else {
                    $paddedIds += $id
                }
            }
            $preKey = [string]::Join('.', $paddedIds)
        }

        $candidates += [PSCustomObject]@{
            Tag     = $tag
            Major   = $major
            Minor   = $minor
            Patch   = $patch
            RelRank = $relRank
            PreKey  = $preKey
        }
    }

    if ($candidates.Count -eq 0) { return $null }

    # Sort ascending: stable max is last element
    $sorted = $candidates | Sort-Object Major, Minor, Patch, RelRank, PreKey
    return $sorted[-1].Tag
}

# ---------------------------------------------------------------------------
# Resolve release tag
# ---------------------------------------------------------------------------
Write-Host "Resolving $Channel release..." -ForegroundColor Cyan

$releasesUrl = "https://api.github.com/repos/$Repo/releases?per_page=100"
$resp        = Invoke-GhApi -Url $releasesUrl
$releases    = $resp.Content | ConvertFrom-Json

$tag = Select-MycoRelease -Releases $releases -Channel $Channel

if (-not $tag) {
    Write-Host "No $Channel release found for myco. Check https://github.com/$Repo/releases" -ForegroundColor Red
    exit 1
}

Write-Host "Found: $tag" -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# Download binary + SHA256SUMS to a temp dir under LOCALAPPDATA\Myco\bin
# (same volume as destination — enables Move-Item without cross-device copy)
# ---------------------------------------------------------------------------
$encodedTag = $tag -replace '/', '%2F'
$dlBase     = "https://github.com/$Repo/releases/download/$encodedTag"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$tmpDir = Join-Path $BinDir (".myco-install-" + [System.IO.Path]::GetRandomFileName().Replace('.',''))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

$tmpExe  = Join-Path $tmpDir $Asset
$tmpSums = Join-Path $tmpDir "SHA256SUMS"

try {
    Write-Host "Downloading $Asset..." -ForegroundColor Cyan
    Invoke-GhDownload -Url "$dlBase/$Asset"      -OutFile $tmpExe
    Invoke-GhDownload -Url "$dlBase/SHA256SUMS"  -OutFile $tmpSums

    # -------------------------------------------------------------------------
    # Checksum verification — no bypass
    # -------------------------------------------------------------------------
    Write-Host "Verifying checksum..." -ForegroundColor Cyan

    $sumsContent = Get-Content $tmpSums -Raw
    $expected    = $null

    foreach ($line in ($sumsContent -split "`n")) {
        $line = $line.Trim()
        if ($line -eq "") { continue }
        # Format: "<hash>  <filename>" or "<hash> *<filename>"
        $parts = $line -split '\s+', 2
        if ($parts.Count -lt 2) { continue }
        $hashField = $parts[0].Trim()
        $nameField = $parts[1].Trim() -replace '^\*', ''
        if ($nameField -eq $Asset) {
            $expected = $hashField
            break
        }
    }

    if (-not $expected) {
        Write-Host "Asset '$Asset' not found in SHA256SUMS." -ForegroundColor Red
        exit 1
    }

    $actual = (Get-FileHash -Path $tmpExe -Algorithm SHA256).Hash

    if ($expected.ToUpper() -ne $actual.ToUpper()) {
        Write-Host "Checksum mismatch for $Asset!" -ForegroundColor Red
        Write-Host "  expected: $($expected.ToLower())" -ForegroundColor Red
        Write-Host "  got:      $($actual.ToLower())"  -ForegroundColor Red
        exit 1
    }

    Write-Host "Checksum verified." -ForegroundColor Green

    # -------------------------------------------------------------------------
    # Place the verified binary
    # -------------------------------------------------------------------------
    try {
        Move-Item -Path $tmpExe -Destination $Exe -Force -ErrorAction Stop
    } catch {
        Write-Host "Failed to place $Exe : $_" -ForegroundColor Red
        Write-Host "  If the Myco daemon is running, stop it first and retry." -ForegroundColor Yellow
        exit 1
    }

} finally {
    # Clean up temp dir (best-effort)
    if (Test-Path $tmpDir) { Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# User PATH — idempotent
# ---------------------------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath) { $userPath = "" }

$pathParts = $userPath -split ';' | Where-Object { $_ -ne "" }
$alreadyInPath = $pathParts | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') }

if (-not $alreadyInPath) {
    $newPath = ($pathParts + $BinDir) -join ';'
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Host "Added $BinDir to your User PATH." -ForegroundColor Yellow
    Write-Host "  Restart your shell (or open a new terminal window) to use 'myco' directly." -ForegroundColor Yellow
} else {
    Write-Host "$BinDir is already on your PATH." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Write install marker
# ---------------------------------------------------------------------------
$markerDir = Split-Path $Marker
New-Item -ItemType Directory -Force -Path $markerDir | Out-Null

$markerObj = [PSCustomObject]@{
    channel = $Channel
    source  = 'curl'
    bin     = $Exe
}
$json = $markerObj | ConvertTo-Json
[System.IO.File]::WriteAllText($Marker, $json, (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------------------
# First run — daemon self-installs the service (best-effort)
# ---------------------------------------------------------------------------
try {
    & $Exe doctor | Out-Null
} catch {
    # Non-fatal: installer succeeded even if doctor has transient issues
}

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "Myco installed to $Exe" -ForegroundColor Green
Write-Host ""
Write-Host "  Open the dashboard to confirm setup and configure intelligence providers:"
Write-Host ""
Write-Host "    myco open"
Write-Host "    http://localhost:20915/"
Write-Host ""
Write-Host "  Optional operator CLIs (npm):"
Write-Host "    npm install -g @goondocks/myco-team        # https://github.com/$Repo/blob/main/docs/team-sync.md"
Write-Host "    npm install -g @goondocks/myco-collective  # https://github.com/$Repo/blob/main/docs/collective.md"
Write-Host ""

# Myco installer for Windows — https://myco.sh
# Usage: irm https://myco.sh/install.ps1 | iex

$Package = "@goondocks/myco"
$MinNodeMajor = 22

Write-Host "Myco installer — Windows" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
try {
    $null = Get-Command node -ErrorAction Stop
} catch {
    Write-Host "Node.js is not installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install from: https://nodejs.org/"
    Write-Host "  Or with winget: winget install OpenJS.NodeJS.LTS"
    Write-Host ""
    Write-Host "  Then re-run this installer."
    exit 1
}

# Check version
$NodeVersion = (node -e "console.log(process.versions.node)").Trim()
$NodeMajor = [int]($NodeVersion.Split('.')[0])
if ($NodeMajor -lt $MinNodeMajor) {
    Write-Host "Node.js v$MinNodeMajor+ required (found v$NodeVersion)" -ForegroundColor Red
    Write-Host "  Update from: https://nodejs.org/"
    exit 1
}
Write-Host "Node.js v$NodeVersion ✓" -ForegroundColor Green

# Check npm
try {
    $null = Get-Command npm -ErrorAction Stop
    $NpmVersion = (npm -v).Trim()
    Write-Host "npm v$NpmVersion ✓" -ForegroundColor Green
} catch {
    Write-Host "npm is not installed." -ForegroundColor Red
    exit 1
}

# Install
Write-Host ""
Write-Host "Installing $Package..." -ForegroundColor Cyan
npm install -g $Package

Write-Host ""
Write-Host "Myco installed successfully!" -ForegroundColor Green
Write-Host ""
Write-Host "  The Myco daemon is starting and will detect every coding agent on your machine."
Write-Host "  Open the dashboard to confirm setup and configure intelligence providers:"
Write-Host ""
Write-Host "    myco dashboard"
Write-Host ""
Write-Host "  Optional operator CLIs:"
Write-Host "    npm install -g @goondocks/myco-team        # https://github.com/goondocks-co/myco/blob/main/docs/team-sync.md"
Write-Host "    npm install -g @goondocks/myco-collective  # https://github.com/goondocks-co/myco/blob/main/docs/collective.md"
Write-Host ""

#!/bin/sh
set -e

# Myco installer — https://myco.sh
# Usage: curl -fsSL https://myco.sh/install.sh | sh

PACKAGE="@goondocks/myco"
MIN_NODE_MAJOR=22

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

info() { printf "${CYAN}%s${NC}\n" "$1"; }
success() { printf "${GREEN}%s${NC}\n" "$1"; }
warn() { printf "${YELLOW}%s${NC}\n" "$1"; }
error() { printf "${RED}%s${NC}\n" "$1"; }

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux*)   PLATFORM="linux" ;;
  Darwin*)  PLATFORM="macos" ;;
  MINGW*|MSYS*|CYGWIN*)
    error "Windows detected. Use PowerShell instead:"
    echo "  irm https://myco.sh/install.ps1 | iex"
    exit 1
    ;;
  *)
    error "Unsupported OS: $OS"
    exit 1
    ;;
esac

info "Myco installer — $PLATFORM"
echo ""

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  error "Node.js is not installed."
  echo ""
  case "$PLATFORM" in
    macos)
      echo "  Install with Homebrew:  brew install node"
      echo "  Or with nvm:           curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
      ;;
    linux)
      echo "  Install with nvm:      curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
      echo "  Or your package manager (apt, dnf, pacman, etc.)"
      ;;
  esac
  echo ""
  echo "  Then re-run this installer."
  exit 1
fi

# Check Node version
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  error "Node.js v${MIN_NODE_MAJOR}+ required (found v$(node -v | tr -d 'v'))"
  echo ""
  echo "  Update with nvm:  nvm install ${MIN_NODE_MAJOR}"
  echo "  Or Homebrew:      brew upgrade node"
  exit 1
fi

success "Node.js v$(node -v | tr -d 'v') ✓"

# Check npm
if ! command -v npm >/dev/null 2>&1; then
  error "npm is not installed. It should come with Node.js."
  echo "  Try reinstalling Node.js."
  exit 1
fi

success "npm v$(npm -v) ✓"

# Install
echo ""
info "Installing ${PACKAGE}..."
npm install -g "${PACKAGE}"

echo ""
success "Myco installed successfully!"
echo ""
echo "  Next: cd into your project and run:"
echo ""
echo "    myco init"
echo ""

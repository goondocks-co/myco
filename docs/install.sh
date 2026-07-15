#!/bin/sh
# Myco installer — https://myco.sh
# Usage: curl -fsSL https://myco.sh/install.sh | sh
#        curl -fsSL https://myco.sh/install.sh | sh -s -- --serve --server-url https://host.example:8080
#
# Env overrides:
#   MYCO_CHANNEL       — "stable" (default) or "beta"
#   MYCO_BIN_DIR       — destination directory (default: ~/.myco/bin)
#   GITHUB_TOKEN       — or GH_TOKEN — avoid GitHub API rate limits
#   MYCO_TEAM_AGENT_KEY — optional, only consulted with --serve: the team's LLM
#                         provider API key, stored in the served Grove's
#                         secrets.env (never in YAML, never logged in full)
#
# --serve options (a serving box is a full Myco instance — nothing above is
# skipped; --serve is additive: enable Team Host serving after install):
#   --serve                 Stand up this machine as a Team Host after install
#   --server-url <url>      REQUIRED with --serve — the address members dial
#   --hostname <name>       This host's node name on the tailnet (optional)
set -eu

REPO="goondocks-co/myco"
CHANNEL="${MYCO_CHANNEL:-stable}"
BIN_DIR="${MYCO_BIN_DIR:-$HOME/.myco/bin}"

# ---------------------------------------------------------------------------
# Color helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { printf "${CYAN}%s${NC}\n"   "$1"; }
success() { printf "${GREEN}%s${NC}\n"  "$1"; }
warn()    { printf "${YELLOW}%s${NC}\n" "$1"; }
error()   { printf "${RED}%s${NC}\n"    "$1" >&2; }

# ---------------------------------------------------------------------------
# --serve flag parsing (additive — no effect on the default install path
# below unless --serve is actually passed)
# ---------------------------------------------------------------------------
SERVE=0
SERVE_SERVER_URL=""
SERVE_HOSTNAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --serve)
      SERVE=1
      shift
      ;;
    --server-url)
      SERVE_SERVER_URL="${2:-}"
      shift 2
      ;;
    --server-url=*)
      SERVE_SERVER_URL="${1#--server-url=}"
      shift
      ;;
    --hostname)
      SERVE_HOSTNAME="${2:-}"
      shift 2
      ;;
    --hostname=*)
      SERVE_HOSTNAME="${1#--hostname=}"
      shift
      ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ "$SERVE" = "1" ] && [ -z "$SERVE_SERVER_URL" ]; then
  error "--serve requires --server-url <https://host:8080> — the address members dial to reach the control plane."
  exit 1
fi

# ---------------------------------------------------------------------------
# Token helpers — DRY, no eval, token never echoed/logged
# ---------------------------------------------------------------------------

# Returns the effective GitHub token: GITHUB_TOKEN takes precedence over GH_TOKEN.
auth_token() { printf '%s' "${GITHUB_TOKEN:-${GH_TOKEN:-}}"; }

# Token-aware curl wrapper.
gh_curl() {
  _token="$(auth_token)"
  if [ -n "$_token" ]; then
    curl -fsSL -H "Authorization: Bearer $_token" \
               -H "Accept: application/vnd.github+json" \
               -H "User-Agent: myco-installer/${REPO}" \
               "$@"
  else
    curl -fsSL -H "Accept: application/vnd.github+json" \
               -H "User-Agent: myco-installer/${REPO}" \
               "$@"
  fi
}

# Same wrapper but writes HTTP status to a variable via a temp file.
# Usage: gh_curl_status OUTFILE URL  — exits 0 even on HTTP error; caller checks $HTTP_STATUS
gh_curl_status() {
  _out="$1"; shift
  _token="$(auth_token)"
  if [ -n "$_token" ]; then
    HTTP_STATUS="$(curl -sSL \
      -H "Authorization: Bearer $_token" \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: myco-installer/${REPO}" \
      -w '%{http_code}' \
      -o "$_out" \
      "$@" 2>/dev/null)" || true
  else
    HTTP_STATUS="$(curl -sSL \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: myco-installer/${REPO}" \
      -w '%{http_code}' \
      -o "$_out" \
      "$@" 2>/dev/null)" || true
  fi
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) os=darwin ;;
  Linux)  os=linux  ;;
  MINGW*|MSYS*|CYGWIN*)
    error "Windows detected. Use the PowerShell installer instead:"
    printf "  irm https://myco.sh/install.ps1 | iex\n"
    exit 1
    ;;
  *)
    error "Unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64   ;;
  *)
    error "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

TARGET="${os}-${arch}"
ASSET="myco-${TARGET}"

info "Myco installer — ${TARGET} / channel: ${CHANNEL}"
if [ "$os" = "linux" ]; then
  warn "Linux support is beta. Report issues at https://github.com/${REPO}/issues"
fi
echo ""

# ---------------------------------------------------------------------------
# Checksum tool (Linux: sha256sum; macOS: shasum -a 256)
# ---------------------------------------------------------------------------
if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  error "No SHA-256 tool found (expected sha256sum or shasum)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve release tag for channel via GitHub Releases API
# ---------------------------------------------------------------------------
info "Resolving ${CHANNEL} release..."

RELEASES_URL="https://api.github.com/repos/${REPO}/releases?per_page=100"
RELEASES_FILE="$(mktemp)"
HTTP_STATUS=""
# shellcheck disable=SC2064
trap 'rm -f "$RELEASES_FILE"' EXIT

gh_curl_status "$RELEASES_FILE" "$RELEASES_URL"

case "$HTTP_STATUS" in
  200) ;;  # ok
  403|429)
    error "GitHub API rate limit hit (HTTP ${HTTP_STATUS})."
    printf "  Set GITHUB_TOKEN (or GH_TOKEN) to a personal access token and retry:\n" >&2
    printf "  GITHUB_TOKEN=ghp_... sh install.sh\n" >&2
    exit 1
    ;;
  *)
    error "GitHub Releases API returned HTTP ${HTTP_STATUS}."
    exit 1
    ;;
esac

# jq-based channel selection — mirrors Task 5 pickRelease semver ordering:
#   stable: highest non-prerelease myco/v* tag
#   beta:   max(stable, prerelease) — 1.4.0 beats 1.3.0-beta.1 (no-downgrade)
if command -v jq >/dev/null 2>&1; then
  TAG="$(jq -r --arg ch "$CHANNEL" '
    [ .[]
      | select(.tag_name | test("^myco/v"))
      | (.tag_name | ltrimstr("myco/v")) as $v
      | select($v | test("^[0-9]+\\.[0-9]+\\.[0-9]+"))
      | { tag: .tag_name,
          pre: ((.prerelease == true) or ($v | contains("-"))) }
      | select($ch == "beta" or (.pre | not))
      | ($v | gsub("\\+[^-]*";"")) as $vclean
      | ($vclean | split("-")[0] | split(".") | map(tonumber)) as $core
      | (if .pre then 0 else 1 end) as $rel
      | (($vclean | split("-")[1]) // "" | split(".")
           | map(if test("^[0-9]+$") then tonumber else . end)) as $preids
      | . + { key: ($core + [$rel] + $preids) } ]
    | sort_by(.key) | last | .tag // empty
  ' "$RELEASES_FILE")" || TAG=""
else
  warn "jq not found — using sort -V fallback (prerelease ordering may be imprecise)."
  if [ "$CHANNEL" = "beta" ]; then
    TAG="$(grep -o '"tag_name": *"myco/v[^"]*"' "$RELEASES_FILE" \
           | sed 's/"tag_name": *"//;s/"//' \
           | sort -rV \
           | head -1)" || TAG=""
  else
    TAG="$(grep -o '"tag_name": *"myco/v[^"]*"' "$RELEASES_FILE" \
           | sed 's/"tag_name": *"//;s/"//' \
           | grep -vE 'v[0-9]+\.[0-9]+\.[0-9]+-' \
           | sort -rV \
           | head -1)" || TAG=""
  fi
fi

if [ -z "$TAG" ]; then
  error "No ${CHANNEL} release found for myco. Check https://github.com/${REPO}/releases"
  exit 1
fi

info "Found: ${TAG}"

# ---------------------------------------------------------------------------
# Download binary + checksum, verify, place atomically
# ---------------------------------------------------------------------------
# TAG contains a slash (myco/v1.2.3) — must be URL-encoded for the DL path.
# GitHub's releases download URL encodes the slash as %2F.
ENCODED_TAG="$(printf '%s' "$TAG" | sed 's|/|%2F|g')"
DL="https://github.com/${REPO}/releases/download/${ENCODED_TAG}"

# Extract the bare semver (e.g. "1.2.3") from the tag (e.g. "myco/v1.2.3").
# This is the dir name under versions/ — must match the daemon's versionBinaryPath().
VERSION="$(printf '%s' "$TAG" | sed 's|^myco/v||')"
VERSION_DIR="${BIN_DIR}/versions/${VERSION}"

mkdir -p "$BIN_DIR"
TMP_DIR="$(mktemp -d "${BIN_DIR}/.myco-install-XXXXXX")"
# shellcheck disable=SC2064
trap 'rm -rf "$TMP_DIR"; rm -f "$RELEASES_FILE"' EXIT

info "Downloading ${ASSET}..."
gh_curl "${DL}/${ASSET}"   -o "${TMP_DIR}/myco"
gh_curl "${DL}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS"

info "Verifying checksum..."
# Parse SHA256SUMS: handle both "hash  filename" and "hash *filename" formats
EXPECTED="$(awk -v a="$ASSET" '
  { hash=$1; rest=substr($0, index($0,$2)); gsub(/^\*/, "", rest);
    gsub(/^[[:space:]]+/, "", rest);
    if (rest == a) print hash }
' "${TMP_DIR}/SHA256SUMS")"

if [ -z "$EXPECTED" ]; then
  error "Asset ${ASSET} not found in SHA256SUMS."
  exit 1
fi

ACTUAL="$(${SHA_CMD} "${TMP_DIR}/myco" | awk '{print $1}')"

if [ "$EXPECTED" != "$ACTUAL" ]; then
  error "Checksum mismatch for ${ASSET}!"
  printf "  expected: %s\n" "$EXPECTED" >&2
  printf "  got:      %s\n" "$ACTUAL"   >&2
  exit 1
fi

success "Checksum verified."

# ---------------------------------------------------------------------------
# Versioned placement + atomic stable copy
#
# Layout (mirrors daemon's versionBinaryPath / managedBinaryPath):
#   ~/.myco/bin/versions/<bare-semver>/myco   ← versioned slot
#   ~/.myco/bin/myco                          ← stable (current) slot
#
# Sequence: chmod → place in version dir → temp+rename to stable path.
# The temp file lives under $BIN_DIR (same filesystem) so the final rename
# is atomic — a partial copy can never leave a broken stable binary.
# ---------------------------------------------------------------------------
chmod +x "${TMP_DIR}/myco"

# Place verified binary in its versioned slot (atomic mv — TMP_DIR is under $BIN_DIR,
# same filesystem, so this rename never produces a partial file under $VERSION_DIR).
mkdir -p "${VERSION_DIR}"
mv "${TMP_DIR}/myco" "${VERSION_DIR}/myco"

# Atomic stable copy via temp+rename (cp to a sibling temp, then rename over stable path)
cp "${VERSION_DIR}/myco" "${TMP_DIR}/myco.stable"
mv "${TMP_DIR}/myco.stable" "${BIN_DIR}/myco"

# macOS Gatekeeper: strip quarantine attribute if present (best-effort)
if [ "$os" = "darwin" ]; then
  xattr -d com.apple.quarantine "${VERSION_DIR}/myco" 2>/dev/null || true
  xattr -d com.apple.quarantine "${BIN_DIR}/myco" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Write install marker
# ---------------------------------------------------------------------------
mkdir -p "$HOME/.myco"
printf '{\n  "channel": "%s",\n  "source": "curl",\n  "bin": "%s/myco"\n}\n' \
  "$CHANNEL" "$BIN_DIR" > "$HOME/.myco/install.json"

# ---------------------------------------------------------------------------
# PATH — idempotent rc edits
# ---------------------------------------------------------------------------
case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    :  # already on PATH
    ;;
  *)
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
      if [ -f "$rc" ] && ! grep -qF "$BIN_DIR" "$rc"; then
        # SC2016: $PATH must NOT expand here — it belongs in the rc file verbatim
        # shellcheck disable=SC2016
        printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
      fi
    done
    warn "Added ${BIN_DIR} to PATH in shell rc files."
    warn "Restart your shell or run: export PATH=\"${BIN_DIR}:\$PATH\""
    ;;
esac

# ---------------------------------------------------------------------------
# First run — install the managed service so the dashboard is reachable
# ---------------------------------------------------------------------------
if "${BIN_DIR}/myco" service install >/dev/null 2>&1; then
  SERVICE_OK=1
else
  SERVICE_OK=0
fi

echo ""
success "Myco installed to ${BIN_DIR}/myco"
echo ""
if [ "$SERVICE_OK" = "1" ]; then
  echo "  Open the dashboard to confirm setup and configure intelligence providers:"
  echo ""
  echo "    myco open"
  echo "    http://localhost:20915/"
else
  warn "Could not start the Myco service automatically. Bring it up with:"
  echo ""
  echo "    myco service install"
  echo "    myco open"
fi
echo ""

# ---------------------------------------------------------------------------
# --serve: run the composite enable on the just-installed myco binary
#
# A serving box is a full Myco instance — everything above already ran
# unmodified (including `myco service install`). Host-serve operator ops
# live in the one binary (decision-48174c9f) — no second fetch, no separate
# package. This section is purely additive and only runs with --serve; a
# failure here never fails the base install (myco itself is already usable —
# re-run `myco host enable` manually to retry Team Host setup).
# ---------------------------------------------------------------------------
if [ "$SERVE" = "1" ]; then
  info "Setting up Team Host serving (--serve)..."
  echo ""

  # --designate-default --emit-join: enable, designate this box's default
  # Grove as the served Grove, mint a one-time setup key, and print the
  # complete ready-to-paste `myco join …` command. MYCO_TEAM_AGENT_KEY (if
  # set in the environment) flows through unchanged — the composite
  # orchestrator reads it and stores it in the served Grove's secrets.env.
  info "Running: myco host enable --server-url ${SERVE_SERVER_URL} --designate-default --emit-join"
  if [ -n "$SERVE_HOSTNAME" ]; then
    if ! "${BIN_DIR}/myco" host enable --server-url "$SERVE_SERVER_URL" --hostname "$SERVE_HOSTNAME" --designate-default --emit-join; then
      warn "Team Host enable did not complete. Re-run manually:"
      echo "    ${BIN_DIR}/myco host enable --server-url $SERVE_SERVER_URL --hostname $SERVE_HOSTNAME --designate-default --emit-join"
    fi
  else
    if ! "${BIN_DIR}/myco" host enable --server-url "$SERVE_SERVER_URL" --designate-default --emit-join; then
      warn "Team Host enable did not complete. Re-run manually:"
      echo "    ${BIN_DIR}/myco host enable --server-url $SERVE_SERVER_URL --designate-default --emit-join"
    fi
  fi
  echo ""
fi

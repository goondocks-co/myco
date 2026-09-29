#!/bin/sh
# Myco 2.0 installer — https://myco.sh
# Usage: curl -fsSL https://myco.sh/install.sh | sh
#        curl -fsSL https://myco.sh/install.sh | sh -s -- --dry-run
#
# Installs the Myco binary and nothing else: no service is started and no
# agent is changed. The next step it prints is `myco login <invite link>` to
# join your team's Deployment, or the self-hosting guide to run your own.
# On a machine with Myco 1.4 it says so and points to `myco cutover`; it never
# moves 1.4 over by itself.
#
# Options:
#   --dry-run          Say what it would install and where, and change nothing
#   --help             Show this message
#
# Env overrides:
#   MYCO_CHANNEL       "stable" (default) or "beta". Stable installs the newest
#                      2.x release, or the newest 2.x prerelease while no 2.x
#                      release exists; beta installs the newest 2.x of either.
#   MYCO_HOME          Myco's home (default: ~/.myco)
#   MYCO_BIN_DIR       Where the binary goes (default: $MYCO_HOME/bin)
#   GITHUB_TOKEN       or GH_TOKEN: avoid GitHub API rate limits
#   MYCO_INSTALL_FROM  A directory holding myco-<os>-<arch> and SHA256SUMS to
#                      install from instead of a GitHub release (offline or test
#                      installs); MYCO_INSTALL_VERSION names its version
set -eu

REPO="goondocks-co/myco"
CHANNEL="${MYCO_CHANNEL:-stable}"
MYCO_HOME_DIR="${MYCO_HOME:-$HOME/.myco}"
BIN_DIR="${MYCO_BIN_DIR:-$MYCO_HOME_DIR/bin}"
INSTALL_FROM="${MYCO_INSTALL_FROM:-}"
MIN_MAJOR=2

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

usage() {
  cat <<'USAGE'
Usage: curl -fsSL https://myco.sh/install.sh | sh [-s -- --dry-run]

Installs the Myco 2.0 binary to $MYCO_HOME/bin (default ~/.myco/bin) and
prints the next step. --dry-run says what it would install and changes nothing.
Env: MYCO_CHANNEL=stable|beta, MYCO_HOME, MYCO_BIN_DIR, GITHUB_TOKEN,
MYCO_INSTALL_FROM=<dir with myco-<os>-<arch> and SHA256SUMS>.
USAGE
}

DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --help|-h) usage; exit 0 ;;
    --serve|--hostname|--hostname=*)
      error "$1 was the Myco 1.4 Team Host option. To run your own Myco 2.0 server, install and then follow"
      printf "  https://github.com/%s/blob/main/docs/self-hosting.md\n" "$REPO" >&2
      exit 1
      ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

case "$CHANNEL" in
  stable|beta) ;;
  *) error "MYCO_CHANNEL must be stable or beta, and is ${CHANNEL}."; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# Token helpers — no eval, the token is never echoed or logged
# ---------------------------------------------------------------------------
auth_token() { printf '%s' "${GITHUB_TOKEN:-${GH_TOKEN:-}}"; }

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

# Writes the body to OUTFILE and the HTTP status to $HTTP_STATUS; never exits.
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

# Run "$@" with a 30-second watchdog (macOS has no timeout(1)); its stdout goes to $PROBE_OUT.
PROBE_OUT=""
probe() {
  _probe_file="$(mktemp)"
  "$@" >"$_probe_file" 2>/dev/null &
  _probe=$!
  ( sleep 30; kill -9 "$_probe" 2>/dev/null ) &
  _watchdog=$!
  if wait "$_probe"; then _ok=0; else _ok=1; fi
  kill "$_watchdog" 2>/dev/null || true
  wait "$_watchdog" 2>/dev/null || true
  PROBE_OUT="$(cat "$_probe_file")"
  rm -f "$_probe_file"
  return "$_ok"
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
echo ""

if command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  error "No SHA-256 tool found (expected sha256sum or shasum)."
  exit 1
fi

# ---------------------------------------------------------------------------
# Myco 1.4 on this machine: vaults in its home, or a 1.x binary where 2.0 goes
# ---------------------------------------------------------------------------
LEGACY=""
LEGACY_BINARY=0
for vault in "$MYCO_HOME_DIR"/groves/*/myco.db; do
  if [ -s "$vault" ]; then LEGACY="its vaults in ${MYCO_HOME_DIR}/groves"; break; fi
done
if [ -x "${BIN_DIR}/myco" ] && probe "${BIN_DIR}/myco" --version; then
  case "$PROBE_OUT" in
    1.*|*" 1."*)
      LEGACY_BINARY=1
      if [ -z "$LEGACY" ]; then LEGACY="its binary ${BIN_DIR}/myco, ${PROBE_OUT}"; fi
      ;;
  esac
fi

# ---------------------------------------------------------------------------
# Resolve what to install: a local directory, or a GitHub release of Myco 2.x
# ---------------------------------------------------------------------------
if [ -n "$INSTALL_FROM" ]; then
  VERSION="${MYCO_INSTALL_VERSION:-local}"
  SOURCE="${INSTALL_FROM}"
else
  info "Resolving the ${CHANNEL} release..."
  RELEASES_FILE="$(mktemp)"
  HTTP_STATUS=""
  # shellcheck disable=SC2064
  trap 'rm -f "$RELEASES_FILE"' EXIT
  gh_curl_status "$RELEASES_FILE" "https://api.github.com/repos/${REPO}/releases?per_page=100"
  case "$HTTP_STATUS" in
    200) ;;
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

  # The newest myco/v<MIN_MAJOR+>.x tag: releases only, or releases and prereleases.
  pick() { # $1: "release" or "any"
    if command -v jq >/dev/null 2>&1; then
      jq -r --arg want "$1" --argjson min "$MIN_MAJOR" '
        [ .[]
          | select(.draft != true)
          | select(.tag_name | test("^myco/v[0-9]+\\.[0-9]+\\.[0-9]+"))
          | (.tag_name | ltrimstr("myco/v") | gsub("\\+.*$"; "")) as $v
          | ($v | split("-")[0] | split(".") | map(tonumber)) as $core
          | select($core[0] >= $min)
          | { tag: .tag_name, pre: ((.prerelease == true) or ($v | contains("-"))) }
          | select($want == "any" or (.pre | not))
          | (($v | split("-")[1]) // "" | split(".") | map(if test("^[0-9]+$") then tonumber else . end)) as $preids
          | . + { key: ($core + [(if .pre then 0 else 1 end)] + $preids) } ]
        | sort_by(.key) | last | .tag // empty
      ' "$RELEASES_FILE"
    else
      grep -o '"tag_name": *"myco/v[^"]*"' "$RELEASES_FILE" \
        | sed 's/"tag_name": *"//;s/"//' \
        | awk -F'[v.]' -v min="$MIN_MAJOR" '$2 + 0 >= min' \
        | { if [ "$1" = "release" ]; then grep -vE 'v[0-9]+\.[0-9]+\.[0-9]+-' || true; else cat; fi; } \
        | sort -rV | head -1
    fi
  }
  if [ "$CHANNEL" = "beta" ]; then
    TAG="$(pick any)"
  else
    TAG="$(pick release)"
    if [ -z "$TAG" ]; then
      TAG="$(pick any)"
      if [ -n "$TAG" ]; then warn "No Myco 2 release yet; installing the newest prerelease, ${TAG}."; fi
    fi
  fi
  if [ -z "$TAG" ]; then
    error "No Myco ${MIN_MAJOR}.x release found. Check https://github.com/${REPO}/releases"
    exit 1
  fi
  info "Found: ${TAG}"
  VERSION="$(printf '%s' "$TAG" | sed 's|^myco/v||')"
  SOURCE="https://github.com/${REPO}/releases/download/$(printf '%s' "$TAG" | sed 's|/|%2F|g')"
fi
VERSION_DIR="${BIN_DIR}/versions/${VERSION}"

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  info "Dry run: nothing was downloaded or changed."
  echo "  Would install ${ASSET} (${VERSION}) from ${SOURCE}"
  echo "  to ${BIN_DIR}/myco (and ${VERSION_DIR}/myco), after checking it against SHA256SUMS."
  if [ -n "$LEGACY" ]; then
    echo "  Myco 1.4 is on this machine (${LEGACY}); it would be replaced by 2.0 here, and nothing would be moved over."
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Fetch, verify, place atomically
# ---------------------------------------------------------------------------
mkdir -p "$BIN_DIR"
TMP_DIR="$(mktemp -d "${BIN_DIR}/.myco-install-XXXXXX")"
# shellcheck disable=SC2064
trap "rm -rf \"$TMP_DIR\"; rm -f \"${RELEASES_FILE:-}\"" EXIT

info "Downloading ${ASSET}..."
if [ -n "$INSTALL_FROM" ]; then
  cp "${INSTALL_FROM}/${ASSET}" "${TMP_DIR}/myco"
  cp "${INSTALL_FROM}/SHA256SUMS" "${TMP_DIR}/SHA256SUMS"
else
  gh_curl "${SOURCE}/${ASSET}"   -o "${TMP_DIR}/myco"
  gh_curl "${SOURCE}/SHA256SUMS" -o "${TMP_DIR}/SHA256SUMS"
fi

info "Verifying checksum..."
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

chmod +x "${TMP_DIR}/myco"

# The kernel must run it before anything is replaced: a Darwin build whose ad hoc
# signature does not verify is killed at exec. Only an ad hoc (or absent)
# signature is made again, keeping entitlements and identifier as the build does;
# a certificate's signature is never replaced, and one that verifies is kept.
if [ "$os" = "darwin" ] && ! codesign --verify --strict "${TMP_DIR}/myco" 2>/dev/null; then
  if ! codesign -dv "${TMP_DIR}/myco" 2>&1 | grep -q -E '^Signature=adhoc$|not signed at all'; then
    error "The downloaded binary's signature does not verify, and it is not an ad hoc signature; nothing was installed."
    exit 1
  fi
  warn "The downloaded binary's signature does not verify on this Mac; signing it ad hoc again."
  if ! codesign --force --sign - --preserve-metadata=entitlements,identifier "${TMP_DIR}/myco" 2>/dev/null \
    || ! codesign --verify --strict "${TMP_DIR}/myco" 2>/dev/null; then
    error "The downloaded binary's signature cannot be made valid on this Mac; nothing was installed."
    exit 1
  fi
fi

if ! probe "${TMP_DIR}/myco" --version; then
  error "The downloaded binary does not run on this machine; nothing was installed."
  exit 1
fi

# Versioned slot, then the stable path by temp+rename on the same filesystem:
#   <bin>/versions/<version>/myco   and   <bin>/myco
mkdir -p "${VERSION_DIR}"
mv "${TMP_DIR}/myco" "${VERSION_DIR}/myco"
cp "${VERSION_DIR}/myco" "${TMP_DIR}/myco.stable"
mv "${TMP_DIR}/myco.stable" "${BIN_DIR}/myco"

if [ "$os" = "darwin" ]; then
  xattr -d com.apple.quarantine "${VERSION_DIR}/myco" 2>/dev/null || true
  xattr -d com.apple.quarantine "${BIN_DIR}/myco" 2>/dev/null || true
fi

mkdir -p "$MYCO_HOME_DIR"
printf '{\n  "channel": "%s",\n  "source": "curl",\n  "bin": "%s/myco"\n}\n' \
  "$CHANNEL" "$BIN_DIR" > "$MYCO_HOME_DIR/install.json"

# ---------------------------------------------------------------------------
# PATH — idempotent rc edits. zsh reads .zshenv for every shell, so it is
# created when absent; .zshrc is written too because macOS path_helper demotes
# a .zshenv prepend in login shells. The others are only appended to when they
# exist. The block is guarded, so sourcing it twice adds nothing.
# ---------------------------------------------------------------------------
APPENDED_RC=0
for rc in "$HOME/.zshenv" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"; do
  if [ ! -f "$rc" ] && [ "$rc" != "$HOME/.zshenv" ]; then continue; fi
  if [ -f "$rc" ] && grep -qF "$BIN_DIR" "$rc"; then continue; fi
  # SC2016: $PATH must NOT expand here — it belongs in the rc file verbatim
  # shellcheck disable=SC2016
  {
    printf '\n# Added by the Myco installer.\n'
    printf 'case ":$PATH:" in\n'
    printf '  *":%s:"*) ;;\n' "$BIN_DIR"
    printf '  *) export PATH="%s:$PATH" ;;\n' "$BIN_DIR"
    printf 'esac\n'
  } >> "$rc"
  APPENDED_RC=$((APPENDED_RC + 1))
done

echo ""
success "Myco ${VERSION} installed to ${BIN_DIR}/myco"
if [ "$APPENDED_RC" -gt 0 ]; then
  warn "Added ${BIN_DIR} to PATH in ${APPENDED_RC} shell rc file(s); open a new shell, or run: export PATH=\"${BIN_DIR}:\$PATH\""
fi
echo ""
if [ -n "$LEGACY" ]; then
  warn "Myco 1.4 is on this machine (${LEGACY})."
  if [ "$LEGACY_BINARY" = "1" ]; then
    echo "  2.0 replaced its binary, so its hooks capture nothing until you move over."
  fi
  echo "  Nothing was moved over. To move it to 2.0:"
  echo ""
  echo "    myco login <invite link>     # the link your Deployment's administrator sent you"
  echo "    myco cutover --dry-run       # shows every change it would make; changes nothing"
  echo "    myco cutover"
  echo ""
  echo "  The 1.4 vaults stay where they are; the cutover copies and imports them."
else
  echo "  Next, join your team's Deployment with the invite link its administrator sent you:"
  echo ""
  echo "    myco login <invite link>"
  echo ""
  echo "  Or run your own server: https://github.com/${REPO}/blob/main/docs/self-hosting.md"
fi
echo ""

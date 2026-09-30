#!/bin/sh
# Myco 2.0 installer — https://myco.sh
# Usage: curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh
#        curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh -s -- --dry-run
#
# Installs the Myco binary and nothing else: no service is started. On a
# first-time machine no agent is changed, and the next step it prints is
# `myco login <invite link>` to join your team's Deployment, or the
# self-hosting guide to run your own. On a machine already joined to a
# Deployment it is the upgrade: it then runs `myco member provision --refresh`
# so the agents' hooks and MCP entries run the build it installed.
#
# On a machine with Myco 1.4 it installs nothing unless asked to: 2.0 takes
# 1.4's place, and 1.4 stops capturing until the machine is moved over with
# `myco cutover`. --replace-1.4 (or MYCO_REPLACE_LEGACY=1) installs it anyway;
# nothing of 1.4 is moved or deleted either way.
#
# Options:
#   --dry-run          Say what it would install and where, and change nothing
#   --replace-1.4      Install over Myco 1.4, to move this machine to 2.0 next
#   --help             Show this message
#
# Env overrides:
#   MYCO_CHANNEL        "stable" (default) or "beta". Stable installs the newest
#                       2.x release, or the newest 2.x prerelease while no 2.x
#                       release exists; beta installs the newest 2.x of either.
#   MYCO_HOME           Myco's home (default: ~/.myco)
#   MYCO_BIN_DIR        Where the binary goes (default: $MYCO_HOME/bin)
#   MYCO_REPLACE_LEGACY 1 is the same as --replace-1.4
#   GITHUB_TOKEN        or GH_TOKEN: avoid GitHub API rate limits
#   MYCO_INSTALL_FROM   A directory holding myco-<os>-<arch> and SHA256SUMS to
#                       install from instead of a GitHub release (offline or
#                       test installs); MYCO_INSTALL_VERSION names its version
#
# Everything runs from main() on the last line, so a download cut short runs
# nothing.
set -eu

REPO="goondocks-co/myco"
MIN_MAJOR=2
UPGRADE_GUIDE="https://github.com/${REPO}/blob/main/docs/upgrade-from-v1.md"
SELF_HOSTING_GUIDE="https://github.com/${REPO}/blob/main/docs/self-hosting.md"
ONE_LINER="curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh"

# ---------------------------------------------------------------------------
# Output
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
Usage: curl --proto '=https' --tlsv1.2 -fsSL https://myco.sh/install.sh | sh [-s -- <options>]

Installs the Myco 2.0 binary to $MYCO_HOME/bin (default ~/.myco/bin) and
prints the next step.
  --dry-run       say what it would install and change nothing
  --replace-1.4   install over Myco 1.4 (then run `myco cutover`)
Env: MYCO_CHANNEL=stable|beta, MYCO_HOME, MYCO_BIN_DIR, MYCO_REPLACE_LEGACY=1,
GITHUB_TOKEN, MYCO_INSTALL_FROM=<dir with myco-<os>-<arch> and SHA256SUMS>.
USAGE
}

# ---------------------------------------------------------------------------
# HTTPS only, TLS 1.2 or newer. The token is never echoed or logged.
# ---------------------------------------------------------------------------
auth_token() { printf '%s' "${GITHUB_TOKEN:-${GH_TOKEN:-}}"; }

# Authorization travels through stdin; curl's arguments contain no credentials.
gh_request() (
  # The caller retains its tracing state outside this credential-handling subshell.
  set +x
  _token="$(auth_token)"
  # Curl config values must be single-line to prevent extra config directives.
  case "$_token" in
    *'
'*|*"$(printf '\r')"*)
      error "GitHub token must not contain line breaks."
      return 1
      ;;
  esac
  {
    if [ -n "$_token" ]; then
      _escaped_token="$(printf '%s' "$_token" | sed 's/\\/\\\\/g; s/"/\\"/g')"
      printf 'header = "Authorization: Bearer %s"\n' "$_escaped_token"
    fi
  } | curl -q --config - --proto '=https' --tlsv1.2 \
      -H "Accept: application/vnd.github+json" \
      -H "User-Agent: myco-installer/${REPO}" \
      "$@"
)

# Token-aware curl wrapper.
gh_curl() { gh_request -fsSL "$@"; }

# Usage: gh_curl_status OUTFILE URL — caller checks $HTTP_STATUS, including HTTP errors.
gh_curl_status() {
  _out="$1"; shift
  HTTP_STATUS="$(gh_request -sSL -w '%{http_code}' -o "$_out" "$@" 2>/dev/null)" || true
}

# Run "$@" with a 30-second watchdog (macOS has no timeout(1)); its stdout goes to $PROBE_OUT.
PROBE_OUT=""
probe() {
  _probe_file="$(mktemp)"
  "$@" >"$_probe_file" 2>/dev/null &
  _probe=$!
  ( sleep 30; kill -9 "$_probe" 2>/dev/null ) </dev/null >/dev/null 2>&1 &

  _watchdog=$!
  if wait "$_probe"; then _ok=0; else _ok=1; fi
  kill "$_watchdog" 2>/dev/null || true
  wait "$_watchdog" 2>/dev/null || true
  PROBE_OUT="$(cat "$_probe_file")"
  rm -f "$_probe_file"
  return "$_ok"
}

# Run "$@" with a watchdog of $1 seconds; its stdout and stderr go to $RUN_OUT.
RUN_OUT=""
run_bounded() {
  _limit="$1"; shift
  _run_file="$(mktemp)"
  "$@" >"$_run_file" 2>&1 &
  _run=$!
  ( sleep "$_limit"; kill -9 "$_run" 2>/dev/null ) >/dev/null 2>&1 &
  _run_watchdog=$!
  if wait "$_run"; then _run_ok=0; else _run_ok=1; fi
  kill "$_run_watchdog" 2>/dev/null || true
  wait "$_run_watchdog" 2>/dev/null || true
  RUN_OUT="$(cat "$_run_file")"
  rm -f "$_run_file"
  return "$_run_ok"
}

# ---------------------------------------------------------------------------
# After install
# ---------------------------------------------------------------------------

# A home that already belongs to a Deployment: the agents' hooks, MCP entries
# and skill links were written by the build that ran before, so the build just
# installed writes them again, as `myco upgrade` does (#1499).
refresh_member_setup() {
  info "This machine is a member of a Deployment. Refreshing your agents' Myco setup..."
  if run_bounded 120 env MYCO_HOME="$MYCO_HOME_DIR" "${BIN_DIR}/myco" member provision --refresh; then
    printf '%s\n' "$RUN_OUT" | sed '/^[[:space:]]*$/d; s/^/  /'
    success "Your agents now use Myco ${VERSION}."
  else
    printf '%s\n' "$RUN_OUT" | sed '/^[[:space:]]*$/d; s/^/  /' >&2
    warn "Your agents' Myco setup was not refreshed. Run: myco member provision --refresh"
  fi
}

# A first-time machine: what comes next is joining a Deployment. This is the
# one place the installer hands over to `myco login`; once login records the
# machine's default Deployment (#1547), the step stays the same.
login_hand_off() {
  echo "  Next, join your team's Deployment with the invite link its administrator sent you:"
  echo ""
  echo "    myco login <invite link>"
  echo ""
  echo "  Or run your own server: ${SELF_HOSTING_GUIDE}"
}

RELEASES_FILE=""
TMP_DIR=""
cleanup() {
  if [ -n "$RELEASES_FILE" ]; then rm -f "$RELEASES_FILE"; fi
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
}

# ---------------------------------------------------------------------------
# Release selection. A usable tag is exactly myco/v<major>.<minor>.<patch>
# with an optional -<prerelease>, major MIN_MAJOR or newer, and not a draft.
# Ordering is semver's: a release ranks above its own prereleases, numeric
# prerelease parts compare as numbers and rank below named ones.
# ---------------------------------------------------------------------------
TAG_PATTERN='^myco/v[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z.]+)?$'

# The newest usable tag: releases only ("release"), or releases and prereleases ("any").
pick_tag() {
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg want "$1" --argjson min "$MIN_MAJOR" --arg pattern "$TAG_PATTERN" '
      [ .[]
        | select(.draft != true)
        | select(.tag_name | test($pattern))
        | (.tag_name | ltrimstr("myco/v")) as $v
        | ($v | split("-")[0] | split(".") | map(tonumber)) as $core
        | select($core[0] >= $min)
        | { tag: .tag_name, pre: ((.prerelease == true) or ($v | contains("-"))) }
        | select($want == "any" or (.pre | not))
        | (($v | split("-")[1]) // "" | split(".") | map(select(. != "") | if test("^[0-9]+$") then tonumber else . end)) as $preids
        | . + { key: ($core + [(if .pre then 0 else 1 end)] + $preids) } ]
      | sort_by(.key) | last | .tag // empty
    ' "$RELEASES_FILE"
  else
    # Without jq: each release's fields from its tag_name up to the next
    # release's, flattened to one line, ranked by a key that sorts as text.
    tr '\r\n' '  ' < "$RELEASES_FILE" | awk -v want="$1" -v min="$MIN_MAJOR" -v pattern="$TAG_PATTERN" '
      { n = split($0, parts, /"tag_name"[ \t]*:[ \t]*"/)
        for (i = 2; i <= n; i++) {
          chunk = parts[i]
          tag = substr(chunk, 1, index(chunk, "\"") - 1)
          if (tag !~ pattern) continue
          if (chunk ~ /"draft"[ \t]*:[ \t]*true/) continue
          v = substr(tag, 7)
          dash = index(v, "-")
          core = dash ? substr(v, 1, dash - 1) : v
          ids = dash ? substr(v, dash + 1) : ""
          pre = (dash > 0) || (chunk ~ /"prerelease"[ \t]*:[ \t]*true/)
          if (want == "release" && pre) continue
          split(core, c, ".")
          if (c[1] + 0 < min + 0) continue
          key = sprintf("%010d.%010d.%010d.%d", c[1], c[2], c[3], pre ? 0 : 1)
          m = split(ids, p, ".")
          for (j = 1; j <= m; j++) key = key "." (p[j] ~ /^[0-9]+$/ ? sprintf("0%010d", p[j]) : "1" p[j])
          printf "%s\t%s\n", key, tag
        }
      }' | LC_ALL=C sort | tail -n 1 | cut -f 2
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  CHANNEL="${MYCO_CHANNEL:-stable}"
  MYCO_HOME_DIR="${MYCO_HOME:-$HOME/.myco}"
  BIN_DIR="${MYCO_BIN_DIR:-$MYCO_HOME_DIR/bin}"
  INSTALL_FROM="${MYCO_INSTALL_FROM:-}"
  REPLACE_LEGACY=0
  if [ "${MYCO_REPLACE_LEGACY:-}" = "1" ]; then REPLACE_LEGACY=1; fi

  DRY_RUN=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY_RUN=1; shift ;;
      --replace-1.4) REPLACE_LEGACY=1; shift ;;
      --help|-h) usage; exit 0 ;;
      --serve|--hostname|--hostname=*)
        error "$1 was the Myco 1.4 Team Host option. To run your own Myco 2.0 server, install and then follow"
        printf "  %s\n" "$SELF_HOSTING_GUIDE" >&2
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

  trap cleanup EXIT

  # -------------------------------------------------------------------------
  # Platform
  # -------------------------------------------------------------------------
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  case "$OS" in
    Darwin) os=darwin ;;
    Linux)  os=linux  ;;
    MINGW*|MSYS*|CYGWIN*)
      error "Windows is not supported by this installer yet."
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

  # -------------------------------------------------------------------------
  # Myco 1.4 on this machine: a 1.x binary where 2.0 goes, or 1.4 vaults in a
  # home no cutover or membership has moved to 2.0 and no 2.x binary serves.
  # -------------------------------------------------------------------------
  LEGACY=""
  BLOCKS_INSTALL=0
  CURRENT_MAJOR=""
  if [ -x "${BIN_DIR}/myco" ] && probe "${BIN_DIR}/myco" --version; then
    CURRENT_VERSION="$(printf '%s\n' "$PROBE_OUT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^ ]*' | head -n 1 || true)"
    CURRENT_MAJOR="${CURRENT_VERSION%%.*}"
    if [ "$CURRENT_MAJOR" = "1" ]; then
      LEGACY="its binary ${BIN_DIR}/myco, ${CURRENT_VERSION}"
      BLOCKS_INSTALL=1
    fi
  fi
  MEMBER_HOME=0
  if [ -f "${MYCO_HOME_DIR}/member/cutover.json" ]; then MEMBER_HOME=1; fi
  for membership in "${MYCO_HOME_DIR}"/member/deployments/*.json; do
    if [ -f "$membership" ]; then MEMBER_HOME=1; break; fi
  done
  for vault in "${MYCO_HOME_DIR}"/groves/*/myco.db; do
    if [ -s "$vault" ] && [ "$MEMBER_HOME" = "0" ]; then
      if [ -z "$LEGACY" ]; then LEGACY="its vaults in ${MYCO_HOME_DIR}/groves"; fi
      case "$CURRENT_MAJOR" in
        ''|0|1) BLOCKS_INSTALL=1 ;;
      esac
      break
    fi
  done

  # -------------------------------------------------------------------------
  # What to install: a local directory, or a GitHub release of Myco 2.x
  # -------------------------------------------------------------------------
  if [ -n "$INSTALL_FROM" ]; then
    VERSION="${MYCO_INSTALL_VERSION:-local}"
    SOURCE="${INSTALL_FROM}"
  else
    info "Resolving the ${CHANNEL} release..."
    RELEASES_FILE="$(mktemp)"
    HTTP_STATUS=""
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

    if [ "$CHANNEL" = "beta" ]; then
      TAG="$(pick_tag any)"
    else
      TAG="$(pick_tag release)"
      if [ -z "$TAG" ]; then
        TAG="$(pick_tag any)"
        if [ -n "$TAG" ]; then warn "No Myco 2 release yet; installing the newest prerelease, ${TAG}."; fi
      fi
    fi
    if [ -z "$TAG" ]; then
      error "No Myco ${MIN_MAJOR}.x release found: Myco 2.0 has not been released yet, so there is nothing to install."
      if [ -n "$LEGACY" ]; then
        printf "  Myco 1.4 on this machine (%s) keeps working as it is.\n" "$LEGACY" >&2
      fi
      printf "  Releases: https://github.com/%s/releases\n" "$REPO" >&2
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
    if [ "$BLOCKS_INSTALL" = "1" ] && [ "$REPLACE_LEGACY" = "0" ]; then
      echo "  Myco 1.4 is on this machine (${LEGACY}), so it would install nothing."
      echo "  With --replace-1.4 it would install ${ASSET} (${VERSION}) in 1.4's place, and 1.4 would stop capturing until you run myco cutover."
      exit 0
    fi
    echo "  Would install ${ASSET} (${VERSION}) from ${SOURCE}"
    echo "  to ${BIN_DIR}/myco (and ${VERSION_DIR}/myco), after checking it against SHA256SUMS."
    if [ "$BLOCKS_INSTALL" = "1" ]; then
      echo "  Myco 1.4 is on this machine (${LEGACY}); --replace-1.4 was given, so 2.0 would take its place and 1.4 would stop capturing until you run myco cutover. Nothing of 1.4 would be moved or deleted."
    elif [ -n "$LEGACY" ]; then
      echo "  Myco 1.4's vaults are on this machine (${LEGACY}); nothing of 1.4 would be moved or deleted."
    fi
    exit 0
  fi

  if [ "$BLOCKS_INSTALL" = "1" ] && [ "$REPLACE_LEGACY" = "0" ]; then
    error "Myco 1.4 is on this machine (${LEGACY}). Nothing was installed."
    {
      echo "  Installing Myco 2.0 here takes 1.4's place, and 1.4 stops capturing from that"
      echo "  moment until the machine is moved to 2.0. To move it, get an invite link from"
      echo "  your Deployment's administrator, then run these one after another:"
      echo ""
      echo "    ${ONE_LINER} -s -- --replace-1.4"
      echo "    myco login <invite link>"
      echo "    myco cutover --dry-run"
      echo "    myco cutover"
      echo ""
      echo "  Guide: ${UPGRADE_GUIDE}"
    } >&2
    exit 1
  fi

  # -------------------------------------------------------------------------
  # Fetch, verify, place atomically
  # -------------------------------------------------------------------------
  mkdir -p "$BIN_DIR"
  TMP_DIR="$(mktemp -d "${BIN_DIR}/.myco-install-XXXXXX")"

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
    error "Asset ${ASSET} not found in SHA256SUMS; nothing was installed."
    exit 1
  fi
  ACTUAL="$(${SHA_CMD} "${TMP_DIR}/myco" | awk '{print $1}')"
  if [ "$EXPECTED" != "$ACTUAL" ]; then
    error "Checksum mismatch for ${ASSET}; nothing was installed."
    printf "  expected: %s\n" "$EXPECTED" >&2
    printf "  got:      %s\n" "$ACTUAL"   >&2
    exit 1
  fi
  success "Checksum verified."

  chmod +x "${TMP_DIR}/myco"

  # The kernel must run it before anything is replaced: a Darwin build whose ad
  # hoc signature does not verify is killed at exec. Only an ad hoc (or absent)
  # signature is made again, keeping entitlements and identifier as the build
  # does; a certificate's signature is never replaced, and one that verifies is
  # kept.
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

  # A 1.4 daemon still running here adopts any newer versions/<v> slot that
  # carries no adopt-failed marker, and would put 1.4 back at bin/myco before
  # the cutover runs. The marker keeps it from adopting this one.
  if [ "$BLOCKS_INSTALL" = "1" ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "${VERSION_DIR}/.adopt-failed"
  fi

  if [ "$os" = "darwin" ]; then
    xattr -d com.apple.quarantine "${VERSION_DIR}/myco" 2>/dev/null || true
    xattr -d com.apple.quarantine "${BIN_DIR}/myco" 2>/dev/null || true
  fi

  mkdir -p "$MYCO_HOME_DIR"
  printf '{\n  "channel": "%s",\n  "source": "curl",\n  "bin": "%s/myco"\n}\n' \
    "$CHANNEL" "$BIN_DIR" > "$MYCO_HOME_DIR/install.json"

  # -------------------------------------------------------------------------
  # PATH — idempotent rc edits. zsh reads .zshenv for every shell, so it is
  # created when absent; .zshrc is written too because macOS path_helper
  # demotes a .zshenv prepend in login shells. The others are only appended
  # to when they exist. The block is guarded, so sourcing it twice adds
  # nothing.
  # -------------------------------------------------------------------------
  APPENDED_RC=0
  for rc in "$HOME/.zshenv" "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
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
    if [ "$BLOCKS_INSTALL" = "1" ]; then
      echo "  2.0 took its place, so 1.4 captures nothing until you move over."
    fi
    echo "  Nothing was moved over. To move it to 2.0:"
    echo ""
    echo "    myco login <invite link>     # the link your Deployment's administrator sent you"
    echo "    myco cutover --dry-run       # shows every change it would make; changes nothing"
    echo "    myco cutover"
    echo ""
    echo "  The 1.4 vaults stay where they are; the cutover copies and imports them."
  elif [ "$MEMBER_HOME" = "1" ]; then
    refresh_member_setup
  else
    login_hand_off
  fi
  echo ""
}

main "$@"

#!/usr/bin/env bash
set -euo pipefail

version="${1:?expected version}"
asset="${2:?staged release asset}"
manifest="${3:?checksum manifest}"
mode="${4:?native or signature-only}"
case "$mode" in
  native|signature-only) ;;
  *) echo "Unknown verification mode: $mode" >&2; exit 1 ;;
esac
asset="$(cd "$(dirname "$asset")" && pwd)/$(basename "$asset")"

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/myco-darwin-gate.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
export HOME="$scratch/home" CODEX_HOME="$scratch/codex" CLAUDE_CONFIG_DIR="$scratch/claude"
export XDG_CONFIG_HOME="$scratch/xdg" MYCO_HOME="$scratch/myco"
export USERPROFILE="$HOME" LOCALAPPDATA="$scratch/localappdata" TMPDIR="$scratch/tmp"
mkdir -p "$HOME" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$XDG_CONFIG_HOME" "$MYCO_HOME" "$LOCALAPPDATA" "$TMPDIR"

if ! codesign --verify --strict "$asset"; then
  echo "$asset: invalid code signature; refusing distribution verification" >&2
  exit 1
fi
expected="$(awk -v name="$(basename "$asset")" '$2 == name { print $1; count++ } END { if (count != 1) exit 1 }' "$manifest")"
case "$expected" in
  *[!0-9a-f]*|'') echo "Invalid asset checksum" >&2; exit 1 ;;
esac
[ "${#expected}" -eq 64 ] || { echo "Invalid asset checksum length" >&2; exit 1; }
asset_sha="$(shasum -a 256 "$asset")"
if [ "${asset_sha%% *}" != "$expected" ]; then
  echo "$asset: SHA256 differs from the release manifest" >&2
  exit 1
fi
chmod +x "$asset"
if [ "$mode" = native ]; then
  actual="$(cd "$scratch" && "$asset" --version)"
  if [ "$actual" != "$version" ]; then
    echo "$asset: expected version $version, got $actual" >&2
    exit 1
  fi
fi

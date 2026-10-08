#!/usr/bin/env bash
set -euo pipefail

version="${1:?expected version}"
asset="${2:?staged release asset}"
tarball="${3:?packed platform package}"
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
mkdir -p "$HOME" "$CODEX_HOME" "$CLAUDE_CONFIG_DIR" "$XDG_CONFIG_HOME" "$MYCO_HOME"

tar -xzf "$tarball" -C "$scratch" package/bin/myco
packed="$scratch/package/bin/myco"
for binary in "$asset" "$packed"; do
  if ! codesign --verify --strict "$binary"; then
    echo "$binary: invalid code signature; refusing distribution verification" >&2
    exit 1
  fi
done
asset_sha="$(shasum -a 256 "$asset")"
packed_sha="$(shasum -a 256 "$packed")"
if [ "${asset_sha%% *}" != "${packed_sha%% *}" ]; then
  echo "$tarball: packed binary SHA256 differs from the staged asset" >&2
  exit 1
fi
if [ ! -x "$packed" ]; then
  echo "$tarball: package/bin/myco must be executable in the packed tarball" >&2
  exit 1
fi
chmod +x "$asset"
for binary in "$asset" "$packed"; do
  if [ "$mode" = native ]; then
    actual="$(cd "$scratch" && "$binary" --version)"
    if [ "$actual" != "$version" ]; then
      echo "$binary: expected version $version, got $actual" >&2
      exit 1
    fi
  fi
done

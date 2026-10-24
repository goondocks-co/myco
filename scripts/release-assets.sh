#!/usr/bin/env bash

readonly -a MYCO_RELEASE_BINARIES=(
  myco-darwin-arm64
  myco-darwin-x64
  myco-linux-x64
  myco-linux-arm64
  myco-windows-x64.exe
)

verify_release_assets() {
  local directory="${1:?release directory}"
  local manifest="$directory/SHA256SUMS"
  local name
  test -s "$manifest" || { echo "Missing release asset: SHA256SUMS" >&2; return 1; }
  for name in "${MYCO_RELEASE_BINARIES[@]}"; do
    test -s "$directory/$name" || { echo "Missing release asset: $name" >&2; return 1; }
    awk -v name="$name" '
      $2 == name {
        count++
        if (NF != 2 || length($1) != 64 || $1 ~ /[^0-9a-f]/ || $0 != ($1 "  " name)) invalid = 1
      }
      END { if (count != 1 || invalid) exit 1 }
    ' "$manifest" || return 1
  done
  [ "$(awk 'END { print NR }' "$manifest")" -eq "${#MYCO_RELEASE_BINARIES[@]}" ] || {
    echo "Release manifest must contain exactly the canonical binary names" >&2
    return 1
  }
  (cd "$directory" && sha256sum -c SHA256SUMS)
}

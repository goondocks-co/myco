#!/usr/bin/env bash
# Build libsqlite3 for a single target with extension-loading + FTS5 enabled.
#
# Usage: build-libsqlite3-target.sh <target>
#   target: darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64 | windows-x64
#
# Fetches the sqlite amalgamation (pinned version) on first use, then compiles
# into vendor-src/libsqlite3/<target>/libsqlite3.<ext>. Subsequent runs reuse
# the amalgamation tarball.
#
# The Bun-compiled binary embeds this artifact via `import ... with { type:
# "file" }` and calls Database.setCustomSQLite() at startup so sqlite-vec can
# load as an extension.

set -euo pipefail

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  echo "usage: $0 <darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64>" >&2
  exit 2
fi

# Pinned to match sqlite3 release at time of migration. Bump deliberately.
SQLITE_YEAR=2026
SQLITE_VERSION=3530000
AMALGAMATION="sqlite-amalgamation-${SQLITE_VERSION}"
AMALGAMATION_URL="https://sqlite.org/${SQLITE_YEAR}/${AMALGAMATION}.zip"

PACKAGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_SRC="${PACKAGE_DIR}/vendor-src/libsqlite3"
TARGET_DIR="${VENDOR_SRC}/${TARGET}"
AMALGAMATION_DIR="${VENDOR_SRC}/${AMALGAMATION}"

mkdir -p "${TARGET_DIR}"

# Fetch the sqlite amalgamation once and cache it under vendor-src.
if [[ ! -d "${AMALGAMATION_DIR}" ]]; then
  echo "Fetching ${AMALGAMATION_URL}..."
  TMP_ZIP="$(mktemp -t sqlite-amalgamation-XXXXXX.zip)"
  curl --fail --silent --show-error --location --output "${TMP_ZIP}" "${AMALGAMATION_URL}"
  unzip -q "${TMP_ZIP}" -d "${VENDOR_SRC}"
  rm -f "${TMP_ZIP}"
fi

COMMON_FLAGS=(
  -O2
  -DSQLITE_ENABLE_LOAD_EXTENSION=1
  -DSQLITE_ENABLE_FTS5=1
  -DSQLITE_ENABLE_COLUMN_METADATA=1
  -DSQLITE_ENABLE_JSON1=1
  -DSQLITE_ENABLE_RTREE=1
  -DSQLITE_THREADSAFE=1
  -DHAVE_USLEEP=1
  -DSQLITE_USE_URI=1
)

SRC="${AMALGAMATION_DIR}/sqlite3.c"

case "${TARGET}" in
  darwin-arm64)
    OUT="${TARGET_DIR}/libsqlite3.dylib"
    clang -shared -dynamiclib -arch arm64 -install_name @rpath/libsqlite3.dylib \
      "${COMMON_FLAGS[@]}" "${SRC}" -o "${OUT}"
    ;;
  darwin-x64)
    OUT="${TARGET_DIR}/libsqlite3.dylib"
    clang -shared -dynamiclib -arch x86_64 -install_name @rpath/libsqlite3.dylib \
      "${COMMON_FLAGS[@]}" "${SRC}" -o "${OUT}"
    ;;
  linux-x64)
    OUT="${TARGET_DIR}/libsqlite3.so"
    gcc -shared -fPIC "${COMMON_FLAGS[@]}" "${SRC}" -ldl -lpthread -lm -o "${OUT}"
    ;;
  linux-arm64)
    OUT="${TARGET_DIR}/libsqlite3.so"
    : "${CC:=aarch64-linux-gnu-gcc}"
    "${CC}" -shared -fPIC "${COMMON_FLAGS[@]}" "${SRC}" -ldl -lpthread -lm -o "${OUT}"
    ;;
  windows-x64)
    OUT="${TARGET_DIR}/libsqlite3.dll"
    : "${CC:=x86_64-w64-mingw32-gcc}"
    "${CC}" -shared "${COMMON_FLAGS[@]}" "${SRC}" -o "${OUT}"
    ;;
  *)
    echo "Unknown target: ${TARGET}" >&2
    exit 2
    ;;
esac

echo "Built: ${OUT}"
ls -lh "${OUT}"

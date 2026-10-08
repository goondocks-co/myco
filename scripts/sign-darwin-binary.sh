#!/usr/bin/env bash
set -euo pipefail

binary="${1:?Darwin executable}"
codesign --force --sign - --preserve-metadata=entitlements,identifier "$binary"
if ! codesign --verify --strict "$binary"; then
  echo "$binary: invalid code signature after ad hoc signing" >&2
  exit 1
fi

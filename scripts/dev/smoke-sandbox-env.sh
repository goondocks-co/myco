#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# Emit a shell snippet that safely sandboxes Myco smoke runs.
#
# Usage:
#   eval "$(scripts/dev/smoke-sandbox-env.sh subagent-smoke)"
#   echo "$MYCO_SANDBOX_ROOT"
#
# This helper prevents the historical bug where smoke tests sandboxed only
# MYCO_HOME, leaving HOME pointed at the real user home. That allowed manifest
# globalHooksTarget writes (e.g. ~/.claude/settings.json) to escape the sandbox
# and accumulate stale /tmp/myco-*-smoke launcher entries in real agent config.
#
# The emitted snippet creates a temp root and exports the three isolation vars
# that must move together:
#   - MYCO_SANDBOX_ROOT
#   - HOME
#   - MYCO_HOME
# plus MYCO_LAUNCH_AGENTS_DIR for launchd-safe daemon smoke runs.

set -euo pipefail

label="${1:-smoke}"
# Replace anything odd with a stable shell-safe slug for mktemp's prefix.
slug="$(printf '%s' "$label" | tr -cs '[:alnum:]._-' '-')"
temp_root="${TMPDIR:-/tmp}"
temp_root="${temp_root%/}"
root="$(mktemp -d "$temp_root/myco-${slug}-XXXXXX")"
home_dir="$root/home"
myco_home="$home_dir/.myco"
launch_agents_dir="$root/launchagents"

mkdir -p "$myco_home" "$launch_agents_dir"

quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\''/g")"
}

cat <<EOF
# Myco smoke sandbox: $label
export MYCO_SANDBOX_ROOT=$(quote "$root")
export HOME=$(quote "$home_dir")
export MYCO_HOME=$(quote "$myco_home")
export MYCO_LAUNCH_AGENTS_DIR=$(quote "$launch_agents_dir")
mkdir -p "\$MYCO_HOME" "\$MYCO_LAUNCH_AGENTS_DIR"
echo "[myco-smoke] sandbox root: \$MYCO_SANDBOX_ROOT" >&2
EOF

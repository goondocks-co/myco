#!/usr/bin/env bash
# First-time member onboarding, end to end, in a sandboxed HOME (#1499).
#
# Drives only the documented user commands against a Deployment that is already serving:
#   install.sh from a local release, `myco login <invite link>`, `myco member join --new` in two repositories,
#   then one Claude Code session in each through the hooks provisioning wrote (a real agent cannot sign in under a
#   sandboxed HOME, so its hooks are run with the payloads it sends). It checks each session landed in its own
#   repository's project, and that the skills are linked.
#
# Usage: scripts/smoke-member-onboarding.sh <release-dir> <invite-link> <deployment-sqlite>
#   <release-dir>        holds myco-<os>-<arch>, SHA256SUMS and install.sh (MYCO_INSTALL_FROM)
#   <invite-link>        a member invite that names no project
#   <deployment-sqlite>  the serving Deployment's store, read to check where each session landed
# Env: MYCO_SMOKE_SANDBOX (default /private/tmp/myco-onboarding-smoke) — removed and recreated.
set -euo pipefail

REL=${1:?release dir}; INVITE=${2:?invite link}; DB=${3:?deployment sqlite}
T=${MYCO_SMOKE_SANDBOX:-/private/tmp/myco-onboarding-smoke}
U=$T/user

# A `.myco/runtime.home` pin above the sandbox would send its folders to another home (every member verb resolves
# the home from the folder), and that home's credential would answer for the sandbox. Refuse such a sandbox.
dir=$(dirname "$T")
while :; do
  if [ -e "$dir/.myco/runtime.home" ] || [ -e "$dir/.myco/member" ]; then
    echo "refusing: $dir/.myco sits above the sandbox $T; pick a sandbox outside any tree holding a Myco home" >&2
    exit 2
  fi
  [ "$dir" = / ] && break
  dir=$(dirname "$dir")
done
case "$T" in "$HOME"/*|"$HOME") echo "refusing: the sandbox $T is inside the real home $HOME" >&2; exit 2;; esac

rm -rf "$T"; mkdir -p "$U/.claude" "$U/.codex" "$U/code/alpha" "$U/code/beta"
for r in alpha beta; do (cd "$U/code/$r" && git init -q && echo "# $r" > README.md); done
run() { env -i HOME="$U" PATH="$U/.myco/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" MYCO_LAUNCH_AGENTS_DIR="$T/blocked-launch" "$@"; }

echo "== install"; run MYCO_INSTALL_FROM="$REL" MYCO_INSTALL_VERSION=2.0.0-smoke sh "$REL/install.sh" | tail -3
echo "== login"; (cd "$U/code/alpha" && run myco login "$INVITE")
for r in alpha beta; do echo "== join --new ($r)"; (cd "$U/code/$r" && run myco member join --new); done

session() {
  local repo=$1 sid=$2 text=$3 dir tx base
  dir=$U/.claude/projects/$(echo "$U/code/$repo" | tr / -); mkdir -p "$dir"; tx=$dir/$sid.jsonl
  python3 - "$tx" "$sid" "$U/code/$repo" "$text" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" <<'PY'
import json, sys, uuid
tx, sid, cwd, text, now = sys.argv[1:]
u = str(uuid.uuid4())
lines = [{"type": "user", "uuid": u, "promptId": str(uuid.uuid4()), "parentUuid": None, "sessionId": sid, "cwd": cwd, "timestamp": now, "message": {"role": "user", "content": text}},
         {"type": "assistant", "uuid": str(uuid.uuid4()), "parentUuid": u, "sessionId": sid, "cwd": cwd, "timestamp": now, "message": {"role": "assistant", "content": [{"type": "text", "text": "Done: " + text}]}}]
open(tx, "w").write("".join(json.dumps(l) + "\n" for l in lines))
PY
  base="\"session_id\":\"$sid\",\"transcript_path\":\"$tx\",\"cwd\":\"$U/code/$repo\""
  for pair in "session-start|{$base,\"hook_event_name\":\"SessionStart\",\"source\":\"startup\"}" \
              "user-prompt-submit|{$base,\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"$text\"}" \
              "stop|{$base,\"hook_event_name\":\"Stop\",\"stop_hook_active\":false}" \
              "session-end|{$base,\"hook_event_name\":\"SessionEnd\",\"reason\":\"exit\"}"; do
    printf '%s' "${pair#*|}" | (cd "$U/code/$repo" && run "$U/.myco/bin/myco" hook "${pair%%|*}" --symbiont claude-code --credential registry --myco-managed >/dev/null)
  done
}
session alpha "$(uuidgen | tr 'A-Z' 'a-z')" "List the files in alpha"
session beta "$(uuidgen | tr 'A-Z' 'a-z')" "Summarize the beta readme"
sleep 25

echo "== prompts by project"
sqlite3 "$DB" "SELECT p.name, substr(b.text, 1, 40) FROM prompt_batches b JOIN projects p ON p.project_id = b.project_id WHERE p.name IN ('alpha','beta') ORDER BY p.name"
landed=$(sqlite3 "$DB" "SELECT COUNT(*) FROM prompt_batches b JOIN projects p ON p.project_id = b.project_id WHERE (p.name = 'alpha' AND b.text LIKE '%alpha%') OR (p.name = 'beta' AND b.text LIKE '%beta%')")
[ "$landed" = 2 ] || { echo "FAIL: expected each session in its own repository's project, found $landed" >&2; exit 1; }
echo "== skills"
for folder in "$U/.claude/skills" "$U/.agents/skills"; do
  for link in "$folder"/*; do [ -f "$link/SKILL.md" ] || { echo "FAIL: $link has no SKILL.md" >&2; exit 1; }; done
  echo "  $(ls "$folder" | wc -l | tr -d ' ') skills in $folder"
done
echo "== doctor"; (cd "$U/code/alpha" && run myco doctor | grep -E "Membership|Capture|Setup")
echo "PASS"

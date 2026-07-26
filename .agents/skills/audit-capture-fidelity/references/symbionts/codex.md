# codex — audit notes

> **The manifest is the source of truth** for locations, hook fields and capture rules — see `packages/myco/src/symbionts/manifests/codex.yaml`. Nothing declared there is repeated here.

**Capture model:** hook + transcript mining. **Sweep-closing** — no SessionEnd hook, so open sessions are normal until the stale threshold and are never a finding on their own.

## Format notes

- The first line is a `session_meta` entry; `readTranscriptMeta` unwraps it and returns `payload`, so manifest dot-paths are relative to `payload`, not the root. Getting this wrong makes every drop rule silently match nothing.
- `payload.cwd` gives project attribution.
- The rollout filename embeds both an ISO timestamp and the session id, both dash-delimited: `rollout-2026-04-12T17-30-04-<uuid>.jsonl`. No greediness rule can split it — the manifest declares `sessionIdPattern` so the boundary is recoverable. A gate fails if a future pattern reintroduces the ambiguity.
- `payload.source` is a **string** (`"cli"`, `"vscode"`, `"exec"`) for ordinary sessions and an **object** for sub-agent threads. That type change is the structural signal the drop rules key on.

## Three classes with no session row — all correct

The majority of codex transcripts on a dev machine fall in these buckets. The audit excludes them; do not report them as loss.

1. **Sub-agent threads** — `payload.source.subagent.thread_spawn`. Mined and **reattributed to the parent session**, so the content is captured.
2. **`codex exec`** — `payload.source == "exec"`. Non-interactive automation, dropped on purpose.
3. **Ephemeral sub-invocations** — no transcript at all, so `transcript_path` is missing.

## Hand-verification

```bash
# is this transcript a sub-agent thread?
head -1 <rollout.jsonl> | jq '.payload.source'
```

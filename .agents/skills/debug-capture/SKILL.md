---
name: myco:debug-capture
description: >
  Use this skill when a Myco session, prompt, tool use, or attachment appears to have gone missing — the agent says "I sent that" but it isn't in the dashboard, a session shows zero batches, MCP tool calls hang or silently no-op, hooks aren't firing in a worktree, the buffer file isn't growing, FK constraint errors appear in the daemon log, or the symptom is "capture went silent." Also use when investigating any reported capture regression in the Myco repo. Walks the capture lifecycle top-down — agent → hook → daemon HTTP → buffer → registry → SQLite → transcript miner — and tells you which layer to look at, in what order, with the exact command to run. Replaces the "investigate capture loss from scratch" antipattern that produced repeated one-off patches.
managed_by: myco
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
---

# Debug Capture

Top-down procedure for "why didn't this land in Myco?" Walks the capture lifecycle in order. The first layer whose check fails is the layer the bug lives in. Stop investigating once that layer is identified; do not assume two layers are simultaneously broken.

## Why this exists

Several independent capture regressions all presented identically — "session went silent" — and each was investigated from scratch via process trees, buffer mtimes, and intuition. The pattern wasted hours. This skill replaces intuition with a procedure that starts at the same step every time.

## Background reading

Skim once before first use; refer back as needed:

- **`references/capture-lifecycle.md`** — the layered tenet: what each layer is, what's authoritative at it, what its failure looks like from above.
- **`references/symbiont-capture-contract.md`** — per-agent matrix: hook events, session ID hook field, transcript path convention, project root resolution.

## Inputs

You need:

- A **session_id** that's suspected to be under-captured.
- The **vault dir** the agent is using. Typically `<repo-root>/.myco`. In a worktree it walks up to the main repo's `.myco`.
- The **Grove database path**. Typically `~/.myco/groves/<grove-id>/myco.db`. Find it with `myco grove list` if unsure.
- The **agent's transcript path**, if available. The hook payload at Stop carries this; otherwise infer per `references/symbiont-capture-contract.md`.

## Procedure

### Step 1 — Did the hook fire?

```bash
# Process tree: confirm the agent is actually running.
pgrep -f '<agent-binary>'  # e.g. claude, codex, cursor

# Hook settings file exists at the project root the agent sees.
# For Claude Code:
ls -la "${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/settings.json"
ls -la "${CLAUDE_PROJECT_DIR:-$(pwd)}/.agents/myco-run.cjs"

# Hook stderr: per-agent location. For Claude Code:
tail -200 ~/Library/Logs/Claude/hooks.log 2>/dev/null
# Or look for stderr emitted from the hook script — it writes a trace
# line to stderr on every fallback path.
```

**Common failures here:**
- New git worktree without a runtime pin → run `make dev-link-worktree` from the worktree, then verify routing with the `dogfood-worktree` skill.
- `.claude/settings.json` exists but Claude doesn't read it → wrong `CLAUDE_PROJECT_DIR`.
- Hook fires but fails to exec `myco` → `runtime.command` pin missing or pointing at a nonexistent binary. Walk up from cwd looking for `<dir>/.myco/runtime.command`, then check `~/.myco/runtime.command`.

If hooks didn't fire, **stop here** — there's nothing for the daemon to lose.

### Step 2 — Did the hook reach the daemon?

```bash
# Buffer file should exist and grow during active capture.
VAULT="$(pwd)/.myco"   # or main-repo .myco if in a worktree
ls -la "$VAULT/buffer/<session_id>.jsonl"
tail -20 "$VAULT/buffer/<session_id>.jsonl" | jq .
```

If the buffer file doesn't exist or isn't growing:

```bash
# Was the daemon up at the moment the hook fired? Check the right log.
tail -200 ~/.myco/service/logs/daemon.log     # prod
tail -200 ~/.myco/service-dev/logs/daemon.log # dev
grep "hooks\." ~/.myco/service/logs/daemon.log | tail -20
```

**Common failures:**
- Daemon was down — buffer should still be written by the hook (its job is to be the durability layer). If neither the buffer nor a daemon log entry exists, the hook itself crashed.
- Wrong port — the hook tried to POST to a port the daemon doesn't own. The daemon's port lives in `~/.myco/service*/daemon.json`.
- Auth gate denied — daemon log shows a 401 / 403 for the call. The hook's auth token must match `daemon.json:auth_token`.

If the daemon log shows the hook hit but no buffer file appeared, see Step 3.

### Step 3 — Was the event dispatched?

```bash
# Every hook event should leave at least one hooks.* log entry.
grep '"session_id":"<sid>"' ~/.myco/service*/logs/daemon.log | grep -E 'hooks\.|capture\.' | tail -20

# If you see "Event suppressed as duplicate within dedup window" — that's
# the dedup guard. Two identical events arrived within the dedup window
# (10s). Real bug, or a legitimate retry? Check the buffer file.

# If you see "Failed to open batch" with an FK error — the session row
# wasn't created before the batch insert tried to FK to it. This is the
# #284 shape. The fix landed but if you see it again, the regression is
# in event-dispatch.ts or session-lifecycle.ts.
```

**Common failures:**
- Dedup window swallowed a legitimate retry.
- FK constraint violation (`FOREIGN KEY constraint failed`) — `ensureSessionRowExists()` either wasn't called or short-circuited.
- Request context (`groveId` / `projectId`) couldn't be resolved → the event lands but project-scoped queries can't see it.

### Step 4 — Did the row land in the DB?

```bash
# Find the Grove DB
GROVE_DB=~/.myco/groves/<grove-id>/myco.db

# Session row exists?
sqlite3 "$GROVE_DB" "SELECT id, project_id, agent, status, started_at, ended_at FROM sessions WHERE id = '<sid>'"

# Row missing AND you expected an "empty" session? Check for a phantom-reap
# tombstone first — injection-only phantom sessions (SessionStart fired, agent
# exited before any prompt, no transcript on disk; the only activity is
# myco:inject_*) are DELETED BY DESIGN at unregister and by the maintenance
# sweep (daemon/phantom-reaper.ts). Not capture loss.
sqlite3 "$GROVE_DB" "SELECT session_id, source, datetime(deleted_at,'unixepoch') FROM session_tombstones WHERE session_id = '<sid>'"
# source = 'phantom_reap' → working as intended.

# Batches for the session?
sqlite3 "$GROVE_DB" "SELECT id, prompt_number, status, substr(user_prompt, 1, 60) FROM prompt_batches WHERE session_id = '<sid>' ORDER BY id"

# Activities for the session?
sqlite3 "$GROVE_DB" "SELECT id, prompt_batch_id, tool_name, file_path FROM activities WHERE session_id = '<sid>' ORDER BY id LIMIT 50"
```

If the session row exists but batches don't (or vice versa) — that's a FK or transaction-boundary bug. Cross-reference with the daemon log for the event window.

If the rows exist but you can't see them via a scoped query (e.g., from the UI for project A) — that's the multi-tenancy shape. The row's `project_id` must match the request context's project scope.

### Step 4b — Is the prompt captured but hidden? (classification)

A prompt the agent "sent" can be in the DB yet absent from the default UI because it was *classified* rather than dropped. Check the origin before concluding anything was lost:

```bash
sqlite3 "$GROVE_DB" "SELECT id, origin, thread_id, substr(user_prompt,1,60) FROM prompt_batches WHERE session_id = '<sid>' ORDER BY id"
```

`origin` records WHO issued the prompt. A non-`human` origin (`system`, `agent_dispatch`) is captured but hidden behind the dashboard's "Show system & sub-agent prompts" filter — the data is present, just filtered out of the default view.

The capture rules act in three lanes; know which one handled the prompt:

- **`drop`** — the event is removed entirely. Reserved for *proven-valueless* content only: duplicate slash-command dispatch envelopes (`<command-message>` / `<command-name>` / `<local-command-stdout>`), ephemeral phantoms with no transcript, non-interactive `exec` transcripts. If a real prompt was dropped, a `drop` rule matched too broadly.
- **`classify` + `set_origin`** — preserve-and-hide: the prompt is stored but tagged `system` or `agent_dispatch`. This is the origin you see in Step 4b.
- **`rewrite_prompt`** (`strip_envelope` / `extract_after`) — unwrap a human wrapper so the stored prompt holds only the user's text (e.g. Codex's `## My request for Codex:` preamble).

To find which rule fired, grep the daemon log for the rule's `reason` audit string:

```bash
grep '"session_id":"<sid>"' ~/.myco/service*/logs/daemon.log | grep -E 'reason|envelope|dispatch' | tail
```

Two structural predicates drive classification (both prefer message *shape* over brittle text):

- **`prompt_envelope_tag_in: [tags]`** — matches when the prompt begins with `<tag` for any listed tag name, ignoring attributes, so `<agent-message from="…">` still matches `agent-message`. Maps known runtime/agent envelopes to an origin.
- **`prompt_is_enclosing_envelope: true`** — the whole-message fail-safe: fires when the ENTIRE trimmed prompt is one balanced (or self-closing) XML envelope, and classifies it `system` (preserved, hidden). It MUST be the last `user_prompt` rule (first-match-wins) and belongs only on agents whose human input does NOT arrive wrapped.

**Common misclassifications:**
- A real human prompt tagged `system` with `reason` ending `-unknown-envelope` — the fail-safe caught it. Either the agent's `prompt_envelope_tag_in` map is missing that tag (add it with the right origin), or the agent wraps its human input in an envelope and should NOT carry the fail-safe at all (strip the wrapper first instead — see `add-symbiont`).
- A prompt hidden as `agent_dispatch` that was genuinely user-typed — an envelope-tag rule listed a tag that also appears in human prompts.

### Step 5 — Did transcript-mining add the post-stop turns?

```bash
# Did /events/stop arrive?
grep '"session_id":"<sid>"' ~/.myco/service*/logs/daemon.log | grep 'hooks.stop' | tail

# Transcript path was carried on the stop event?
grep '"session_id":"<sid>"' ~/.myco/service*/logs/daemon.log | grep -E 'processor\.transcript|transcript_path'

# The transcript file the daemon was told about — does it exist on disk,
# and does it have content past the live capture's last batch?
ls -la <transcript_path>
wc -l <transcript_path>
```

If `/events/stop` arrived but the post-stop turns aren't in the DB, the transcript miner either didn't recognize the file format, or it deduped against an in-flight live capture (correctly or incorrectly). Compare batch counts before and after the stop window.

If `/events/stop` never arrived — the agent crashed or was killed without firing it. The reconciler at next daemon startup should pick this up via the buffer replay; check `lifecycle.reconcile` entries in the log.

### Step 5b — Is a sub-agent's transcript "missing"?

An agent that isolates sub-agent work into separate transcripts (Codex `thread_spawn`) does not get its own session row. Its turns are mined into the PARENT session as batches carrying `origin='agent_dispatch'` and a non-null `thread_id` (+ `thread_label`) — one session, many threads. So a sub-agent whose work appears "missing" is usually on the parent under a thread id, not lost.

Query thread rows explicitly — they are scoped away from the main thread:

```bash
# Sub-agent thread batches live on the PARENT session id under a thread_id.
sqlite3 "$GROVE_DB" "SELECT id, origin, thread_id, thread_label, substr(user_prompt,1,50) FROM prompt_batches WHERE session_id = '<parent_sid>' AND thread_id IS NOT NULL ORDER BY thread_id, id"
```

Attribution runs through `resolveSubagentThread`, which reads three manifest-declared dot-paths from the transcript's `session_meta`:

- **`subagentParentPath`** → the parent session/thread id the batches attach to.
- **`subagentThreadIdPath`** → the thread's OWN stable id (folded into `content_hash` so sibling threads with identical text don't dedupe into each other).
- **`subagentLabelPath`** → the object carrying the friendly label (`thread_label`, derived as `agent_nickname` else the last segment of `agent_path`).

If a manifest omits `subagentParentPath`, the agent has no sub-agent thread concept and its transcripts are top-level sessions — this step doesn't apply.

**Two distinct WARN logs pinpoint the break** (grep `processor.transcript`):

- *"Sub-agent transcript has a resolvable parent but no thread id — dropping instead of reattributing (check `subagentThreadIdPath`)"* — the parent resolved but the thread id didn't, so the miner drops rather than mine an un-thread-scoped row. Fix the agent's `subagentThreadIdPath`.
- *"Sub-agent reattribution active but no maskable drop rule found"* — reattribution fired but the agent's capture rules lack the `source.subagent` drop the reattributing mine masks, so records may all drop. Add the structural sub-agent drop rule to the manifest.

If neither parent nor thread id resolves, the transcript follows the ordinary drop path (unresolvable-parent sub-agent stops are dropped by design), and any leaked child session row is cleaned up.

### Step 6 — Did MCP tool calls log?

Use this check when investigating missing MCP tool-call capture.

```bash
# Every MCP tool dispatch leaves info-level entries.
grep 'mcp.call' ~/.myco/service*/logs/daemon.log | tail -10
```

If the agent says a Myco tool "didn't respond" and `grep mcp.call` returns nothing in the relevant window, the call never reached the daemon's `/mcp` route. Suspect the stdio bridge: check whether the bridge process is still alive and connected to the current daemon.

## Anti-patterns

- **Don't restart the daemon as a diagnostic step.** Restarting masks the symptom and destroys the evidence that would point at the root cause. If you must restart, capture `daemon.log` and the buffer file first.
- **Don't assume the registry is the source of truth.** It's a cache. If the daemon log shows a session is "registered" but the DB says nothing, the DB wins.
- **Don't jump to step 4 without doing steps 1–3.** Most capture-loss reports turn out to be step 1 (hook misconfigured) or step 2 (daemon-side routing). The DB queries in step 4 are useless if the data never made it that far.

## When you're done

If you fixed a regression while debugging, the right follow-up is:

1. Add the test that would have caught it (probably in `tests/integration/`). Reuse the existing audit templates where possible.
2. If the failure was at a layer this skill didn't cover well, update the skill — it's meant to evolve.

## Related

- `references/capture-lifecycle.md` — the layered tenet
- `references/symbiont-capture-contract.md` — per-agent capture differences
- `packages/myco/src/hooks/capture-rules.ts` — the rule evaluator, structural predicates, and `resolveSubagentThread`
- `packages/myco/src/daemon/session-lifecycle.ts` — the `ensureSession*` contract (in code)
- `.agents/skills/debug-daemon-errors/SKILL.md` — broader daemon debugging

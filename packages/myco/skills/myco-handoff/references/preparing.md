# Preparing a Handoff

Goal: compress this session's intention into a ≤1500-token digest and persist it
on a Myco plan, with the source session ID, referenced plan IDs, and suggested
skills, then hand the user the exact line to resume in their next session.

## 1. Resolve the target plan

In priority order:

1. **Explicit `[plan-id]` argument** — use it as the target.
2. **An existing plan tied to this session** — `myco_plans({"op":"list","session":"<session-id>"})`.
   If exactly one relevant plan comes back, target it. If several, ask the user
   which (or whether to create a new one).
3. **Otherwise** — create a new dedicated handoff plan (Step 5b).

Before writing the handoff, read every referenced plan with
`myco_plans({"op":"get","id":"<plan-id>"})`. Record each as:
`<id> (<title>; role: work/spec/context; status: <status>)`.

Put the active work plan first. Include design/spec/context plans only when they
materially change how the receiver should continue.

## 2. Capture compact provenance

Capture enough checkout context for RECEIVE to detect a stale or wrong-worktree
resume:

- `pwd`
- `git rev-parse --abbrev-ref HEAD`
- `git rev-parse --short HEAD`
- `git status --short`

Summarize dirty state briefly; do not inline unrelated diffs.

## 3. Author the ≤1500-token digest

Self-compress your **live working context** — this is a manual compaction. Focus
on **intention**, the part Myco doesn't already store:

- **Why/context** — the goal, the path here, and why the work matters.
- **Decisions** — choices made and the rationale.
- **Gotchas/dead ends** — surprises hit, approaches ruled out, and why.
- **Current resume point** — the first concrete move the receiver should make.
- **Evidence anchors** — files, commands/tests, spores, sessions, search result
  ids, retrieve hints, or runtime proof that would be expensive to rediscover.

**Defer to the plan.** State, next-steps, and open-questions usually already live
in the plan — do not duplicate them in the digest. Carry them in the digest
**only** when you are creating a *new dedicated handoff plan* (there is no work
plan to hold them).

**Stay within ≤1500 tokens** (~1100 words). Prefer dense prose over exhaustive
detail; the receiver can pull more via `myco_search` / `myco_cortex`.

**Secret nudge:** don't inline secrets, keys, or PII — reference them by location
(e.g. "API key in `.myco/secrets.env`").

## 4. Choose suggested skills

Decide which skills the receiver will need to resume well. Always include `myco`.
Add only skills that change the receiver's procedure (e.g. a debugging or
subsystem skill). Prefer 3-5 total.

Record each skill as:

`<skill> (<required|optional>; why: <reason>; fallback: <path/tool if missing>)`

`myco` is required. Domain skills are usually optional; if one is required,
explain why the receiver should stop rather than proceed without it.

## 5. Persist the handoff block

Assemble the block:

```markdown
<!-- myco-handoff:start -->
## Handoff — <today's date YYYY-MM-DD>
- **Generated:** <ISO-8601 timestamp>
- **Source session:** <this session id>
- **Source checkout:** <cwd>; branch <branch>; HEAD <short-sha>; dirty <yes/no + summary>
- **Referenced plans:** <plan-id> (<title>; role: work/spec/context; status: <status>)
- **Suggested skills:** myco (required; why: <reason>; fallback: <path/tool>), <skill> (optional; why: <reason>; fallback: <path/tool>)
- **Evidence anchors:** <files, commands/tests, spores, sessions, search result ids, retrieve hints>
- **Resume queries:** <targeted myco_search queries, or "none">
- **Cortex:** use injected guidance if present; otherwise run `myco_cortex({"op":"instructions"})`

### Digest
<the digest from step 3>
<!-- myco-handoff:end -->
```

Before saving, run this freshness check:

- Replace any existing handoff block; never append a second one.
- Remove obsolete next steps and stale evidence.
- Verify referenced plans are not `completed` or `abandoned` unless included as
  historical context.
- Strip secrets, keys, and PII.
- Reject generic progress-summary prose that lacks decisions, gotchas, or
  evidence anchors.

### 5a. Append/replace onto an existing plan (idempotent)

1. Read current content: `myco_plans({"op":"get","id":"<plan-id>"})`.
2. If a `<!-- myco-handoff:start -->…<!-- myco-handoff:end -->` block already
   exists, **replace** it with the new block. Otherwise append the new block to
   the end. Leave all other plan content untouched.
3. Save: `myco_plans({"op":"save","id":"<plan-id>","content":"<full updated content>"})`.
   (Updating by `id` preserves the plan's existing status.)

### 5b. Create a new dedicated handoff plan

A new, non-file-backed plan **requires `plan_key`** (its stable identity; pass
`plan_key` OR `source_path`, never both). Use a `plan_key` like
`handoff-<short-slug>` — re-running `prepare` with the same `session_id` +
`plan_key` then updates the same plan (idempotent) instead of creating a second.

```json
myco_plans({
  "op":"save",
  "session_id":"<this session id>",
  "plan_key":"handoff-<short-slug>",
  "title":"Handoff: <short topic>",
  "status":"active",
  "tags":["handoff"],
  "content":"<the handoff block>"
})
```

The `save` response returns the new plan `id` — capture it for Step 6.

## 6. Return the resume instruction to the user

Tell the user the plan ID and the **exact line** to run next session, plus a
one-line summary of what was captured. For example:

> Handoff saved to plan `<plan-id>`. In your next session, run:
> `/myco-handoff receive <plan-id>`
> It carries: <one-line summary of the digest + referenced plans + suggested skills>.

## CLI fallback (no MCP)

Inline JSON is fine for short reads:

```bash
myco tool call myco_plans --json --input '{"op":"list","session":"<session-id>"}'
```

For handoff saves, use `--input @file.json` because the content is multiline
markdown and may contain backticks:

```bash
cat > /tmp/myco-handoff-save.json <<'EOF'
{
  "op": "save",
  "id": "<plan-id>",
  "content": "<full updated plan markdown>"
}
EOF
myco tool call myco_plans --json --input @/tmp/myco-handoff-save.json
```

If `myco` is not on PATH, invoke the installed self-contained binary directly
(POSIX: `~/.myco/bin/myco`; Windows: `%LOCALAPPDATA%\Myco\bin\myco.exe`) or the
binary named by a trusted `runtime.command` pin. Do not invoke a Node launcher.

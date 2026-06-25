# Receiving a Handoff

Goal: given a plan ID, rehydrate a fresh session from a prepared handoff and
resume the work.

## 1. Read and parse the handoff

`myco_plans({"op":"get","id":"<plan-id>"})` → in the returned `content`, find the
block between `<!-- myco-handoff:start -->` and `<!-- myco-handoff:end -->`.
Parse out:

- **Generated** (timestamp)
- **Source session** (id)
- **Source checkout** (cwd, branch, HEAD, dirty summary)
- **Referenced plans** (ids, titles, roles, statuses)
- **Suggested skills** (names, required/optional, reasons, fallbacks)
- **Evidence anchors** (files, commands/tests, spores, sessions, retrieve hints)
- **Resume queries** (targeted `myco_search` queries)
- **Cortex** (whether to use injected guidance or refresh it)
- **Digest** (the narrative)

If no handoff block is present, tell the user the plan has no handoff and stop.

## 2. Verify the landing context

Before mutating any plan status:

1. Compare the handoff's source checkout with the current `pwd`, branch, short
   HEAD, and `git status --short`. Warn the user if the branch/HEAD clearly
   differs or if the handoff is stale for the work at hand.
2. Fetch source-session metadata when available:
   `myco_sessions({"op":"get","id":"<source-session-id>"})`. Use only metadata
   such as title, branch, agent, timestamps, and transcript path; do not imply
   this reconstructs the conversation.
3. Read every referenced plan with
   `myco_plans({"op":"get","id":"<plan-id>"})`. Skim title, status, tags, and
   current next steps. The digest carries intention; the plans carry state.

## 3. Load skills and Cortex guidance

Load `myco` first.

Use already-injected Cortex guidance if the session has it. If not, run
`myco_cortex({"op":"instructions"})` and follow the returned project guidance.
Do not paste Cortex content into the handoff or assume a fixed heading.

For each suggested skill, invoke it with the host's skill mechanism. If that is
unavailable, read bundled skill files from
`packages/myco/skills/<name>/SKILL.md` or `.agents/skills/<name>/SKILL.md`.

If a required skill is missing and no fallback exists, stop and tell the user the
exact missing skill. If an optional skill is missing, note it and compensate by
reading the referenced plans, evidence anchors, or targeted search results
before coding.

## 4. Mark referenced plans in progress

For each referenced work plan:

- If status is `active`, save `status:"in_progress"`.
- If status is already `in_progress`, leave it alone.
- If status is `completed`, `abandoned`, missing, or otherwise surprising, ask
  before reviving or mutating it.

If this *is* a dedicated handoff plan (the plan you received is itself the work
plan, tagged `handoff`), apply the same status rules to **it**.

## 5. Pull targeted context

Use the handoff's `Resume queries` and `Evidence anchors` first:

- `myco_search({"query":"<resume query>"})` — follow only clearly relevant
  retrieve hints.
- `myco_search({"query":"<topic from the digest>"})` — related spores/plans;
  use this when no resume query was supplied but the digest names a concrete
  subsystem, issue, PR, or gotcha.
- `myco_cortex({"op":"digest","tier":5000})` — only when the work is broad,
  unfamiliar, or the digest/plans leave material context gaps.

Skip this for a narrow, well-scoped resume.

## 6. Summarize the landing and resume

Tell the user, in a few lines: where the prior session left off (from the
digest), source checkout/freshness result, which referenced plans you read,
which plan(s) you marked `in_progress`, which skills/Cortex guidance you loaded
or skipped, any targeted context pulled, and the concrete next step you're about
to take. Then continue the work.

## CLI fallback (no MCP)

```bash
myco tool call myco_plans --json --input '{"op":"get","id":"<plan-id>"}'
myco tool call myco_plans --json --input '{"op":"save","id":"<plan-id>","status":"in_progress"}'
```

Use `--input @file.json` for any payload containing multiline markdown or
backticks. If `myco` is not on PATH, invoke the installed self-contained binary
directly (POSIX: `~/.myco/bin/myco`; Windows:
`%LOCALAPPDATA%\Myco\bin\myco.exe`) or the binary named by a trusted
`runtime.command` pin. Do not invoke a Node launcher.

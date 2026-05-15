---
name: myco:debug-capture
description: >
  Use this skill when a Myco session, prompt, tool use, or attachment appears to have gone missing — the agent says "I sent that" but it isn't in the dashboard, a session shows zero batches, MCP tool calls hang or silently no-op, hooks aren't firing in a worktree, the buffer file isn't growing, FK constraint errors appear in the daemon log, or the symptom is "capture went silent." Also use when investigating any reported capture regression in the Myco repo. Walks the capture lifecycle top-down — agent → hook → daemon HTTP → buffer → registry → SQLite → transcript miner — and tells you which layer to look at, in what order, with the exact command to run. Replaces the "investigate capture loss from scratch" antipattern that produced PRs #278, #284, #285, #286 each as one-offs.
managed_by: myco
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob
---

# Debug Capture

Top-down procedure for "why didn't this land in Myco?" The first layer whose check fails is the layer the bug lives in. Stop investigating once that layer is identified; do not assume two layers are simultaneously broken.

## Why this exists

Three independent capture regressions in one cycle (PRs #278, #284, #285, #286) all presented identically — "session went silent" — and each was investigated from scratch via process trees, buffer mtimes, and intuition. The pattern wasted hours. This skill replaces intuition with a procedure that starts at the same step every time.

## Reference

The full procedure lives in **[`docs/skills/debug-capture.md`](../../../docs/skills/debug-capture.md)** — read that first. It includes copy-paste commands for each layer.

Companion architecture docs:

- **[`docs/architecture/capture-lifecycle.md`](../../../docs/architecture/capture-lifecycle.md)** — the layered tenet, what's authoritative at each layer, what its failure looks like from above.
- **[`docs/architecture/symbiont-capture-contract.md`](../../../docs/architecture/symbiont-capture-contract.md)** — per-agent matrix: hook fields, transcript path conventions, session ID source.

## When to invoke

You're investigating any of:

- "My session shows zero captured prompts."
- "I called `<myco-tool>` and nothing happened" — including MCP tool hangs.
- "Hooks aren't firing in this worktree."
- A new symbiont version isn't capturing correctly.
- `FOREIGN KEY constraint failed` appears in `daemon.log` with a Myco table.
- The buffer file for an active session isn't growing.

## How to use

1. Read `docs/skills/debug-capture.md` for the layered procedure.
2. Walk **top-down**, layer by layer. Do not skip ahead.
3. Stop at the first failing check. That layer is the bug location.
4. If you fix a regression, add the test that would have caught it before merging (Phase 3 audit templates: `tests/integration/capture-pipeline-e2e.test.ts`, `tests/integration/multi-tenancy-invariant-e2e.test.ts`, `tests/mcp/observability.test.ts`).

## Anti-patterns

- **Don't restart the daemon as a diagnostic step.** Restarts destroy the evidence. Capture logs and buffer files first.
- **Don't trust the in-memory registry.** It's a cache. The DB wins.
- **Don't jump to SQL queries** without checking hooks and buffer first. Most reports turn out to be in layers 1 or 2.

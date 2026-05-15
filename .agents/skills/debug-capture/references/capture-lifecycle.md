# Capture Lifecycle

Reference material for the `myco:debug-capture` skill. The canonical layered view: every byte of session data passes through these layers in order, and every capture regression we've shipped has been a confused boundary between two of them. When you're looking at "why didn't this prompt land in the DB," the answer is in one of these layers, and the symptom-from-above is the diagnostic.

For the end-user view of capture, see `docs/lifecycle.md`. This document is for the people on the other side of the contract.

## The layers, top to bottom

```
  Agent process (claude, codex, cursor, opencode, gemini, windsurf, …)
        │
        │  fires hook commands at lifecycle events
        ▼
  Hook script  (.agents/myco-run.cjs → ${MYCO_BIN} hook <name> --symbiont <agent>)
        │
        │  POST <event-payload>
        ▼
  Daemon HTTP routes  (/events, /events/stop, /sessions/register, /mcp)
        │
        │  for /events: write-ahead append + dispatch
        ▼
  On-disk buffer  (<vault>/.myco/buffer/<session_id>.jsonl)
        │
        │  events are durable from this point — daemon crashes can replay
        ▼
  In-memory SessionRegistry  (daemon process cache)
        │
        │  this is a cache, not a source of truth
        ▼
  SQLite (Grove DB at ~/.myco/groves/<id>/myco.db)
        │
        │  sessions / prompt_batches / activities / etc.
        ▼
  Transcript miner  (retroactive — runs at /events/stop)
        │
        │  recovers prompt-text + assistant turns from on-disk transcripts
        ▼
  DB (reconciled)
```

## Per-layer contract

| Layer | What's authoritative at it | What its failure looks like from above |
|---|---|---|
| **Agent process** | The agent's native transcript file (e.g. `~/.claude/projects/<encoded>/<sid>.jsonl`) is authoritative for "what the user actually said and what tools fired." | Hooks never fire — capture silently goes dark. Buffer file at `<vault>/.myco/buffer/<sid>.jsonl` doesn't exist or stops growing. |
| **Hook script** | Nothing — it's a thin shell that POSTs the event payload and exits. | Hook fires but the daemon never sees it. Hook stderr (Claude Code: `~/Library/Logs/Claude/hooks.log`) shows ENOENT or 5xx. Buffer file doesn't appear; nothing in `daemon.log`. |
| **Daemon HTTP** | The request-line itself, until it dispatches. | Daemon log has no `hooks.*` entry for the call. Possible causes: wrong port, auth gate denies, request body fails Zod parse. |
| **Buffer (.jsonl)** | Durability across daemon restarts. Append-only. | Buffer line written but no DB row appears. The reconciler at startup is what should replay these — if it doesn't, that's the gap. |
| **SessionRegistry (in-memory)** | Nothing. It is a cache. | The registry can lie. A cache hit must NEVER be the reason a persist step is skipped. See `packages/myco/src/daemon/session-lifecycle.ts` header. |
| **SQLite (Grove DB)** | Source of truth for sessions, batches, activities, attachments. | `SELECT` against the Grove DB returns nothing for the session id even though the buffer has it. Usually: FK violation on `prompt_batches.session_id` because `sessions.id` was never persisted (the 2026-05-15 regression class). |
| **Transcript miner** | Retroactive recovery of prompts + assistant turns from the agent's transcript file. | `/events/stop` arrives, transcript path is set, but no new batches/activities appear post-stop. Either the transcript path doesn't exist, the adapter doesn't recognize the format, or reconcile already deduped against an in-flight live capture. |

## Source-of-truth ordering

The rule is: **inbound events + the SQLite DB are the only sources of truth for capture data**. Everything else is a cache or a durability layer over them.

Three concrete invariants:

1. **DB is the source of truth.** Every FK-dependent write (`prompt_batches`, `activities`, etc.) requires its `sessions.id` parent to exist. That row must be persisted **before** the write attempts the FK. This is why `ensureSessionRowExists()` runs at the top of every event handler that opens a batch.

2. **Registry is an optimization.** It can be wrong (stale entries, missing entries after restart, missing entries after a failed upsert). A cache miss should never cause data loss; a cache hit should never be the reason a persist step is skipped. The original 2026-05-15 FK-cascade bug was exactly the violation of this invariant: code path A registered in memory without upserting the DB row; path B saw the registry hit, skipped its own upsert, and the next FK insert exploded.

3. **Buffer is the durability fallback.** Events persist to disk before any in-memory state changes, so a daemon crash mid-event doesn't drop the inbound payload. Reconcile-on-startup walks the buffer and re-applies anything missing.

## Layer responsibilities — write side

| Layer | Writes to | Triggers |
|---|---|---|
| Hook script | `<vault>/.myco/buffer/<sid>.jsonl` (only when daemon offline — usually nothing) | Agent lifecycle event |
| Daemon `/events` | Buffer + DB (via dispatcher → `ensureSession*` → `upsertSession` → `insert*`) | Hook script POSTs |
| Daemon `/events/stop` | DB (close open batches) + triggers transcript miner | Hook script POSTs on Stop |
| Transcript miner | DB (`prompt_batches`, `activities`, attachment rows for images) | Post-stop and reconcile-on-startup |
| Session reconciler | DB | Daemon startup; replays buffer for sessions whose status row says they should still be open |

## Layer responsibilities — read side

| Reader | Reads from | For what |
|---|---|---|
| Cortex digest | DB | Project digest tiers, served via `myco_cortex op:digest` |
| Context injector | DB + embeddings | UserPromptSubmit injection: digest + relevant spores |
| MCP tools | DB | All `myco_*` tool calls |
| Dashboard UI | Daemon HTTP routes → DB | Sessions list, batch detail, activity timeline |

## Boundaries that historically broke

- **Hook ↔ daemon** — port misconfiguration, auth token mismatch, daemon restart racing the bridge (PR #286).
- **Daemon HTTP ↔ buffer/registry** — buffer writes silently failing on permission errors before the dispatcher; registry entries created without DB upsert (PR #284).
- **Buffer ↔ DB** — reconcile-on-startup not running, or running and finding no work because the buffer was never written (PR #278).
- **Daemon ↔ transcript miner** — stop replays double-firing and creating duplicates, or under-firing and leaving turns un-captured (PR #285).
- **MCP ↔ daemon log** — daemon serves the call but writes no log entry, so silent hangs look identical to "tool call vanished" (issue #288, closed by PR #301).

Every one of those was a confused boundary. The lesson the audit codified: when you investigate, walk this stack top-down with the procedure in this skill's `SKILL.md`. The first layer where the diagnostic check fails is the layer the bug lives in.

## Related code

- `packages/myco/src/daemon/event-dispatch.ts` — the `/events` dispatcher
- `packages/myco/src/daemon/session-lifecycle.ts` — the `ensureSession*` contract (origin of much of this doc's prose)
- `packages/myco/src/daemon/stop-processing.ts` — the `/events/stop` handler + transcript miner trigger
- `packages/myco/src/daemon/reconciliation.ts` — startup buffer replay
- `packages/myco/src/capture/buffer.ts` — buffer write semantics
- `packages/myco/src/mcp/server.ts` — MCP tool dispatch (#288 logging lives here)

---
type: Architecture
title: Session Capture Flow
description: "How a symbiont's hook events become durable prompt_batches and activities rows: hooks/client.ts's buffered-fallback contract, the Stop pipeline in daemon/stop-processing.ts, transcript mining in capture/transcript-miner.ts, and placeholder-title backfill in daemon/session-reenrich.ts."
timestamp: '2026-07-08T16:20:12.000Z'
---

Every spore, wisdom note, and digest tier described on [Vault Intelligence](/subsystems/vault-intelligence.md) starts life as raw activity inside a coding session. This page is the pipeline in between: how a symbiont's hook fires turn into durable `prompt_batches` and `activities` rows in a project's Grove SQLite database, before Myco's Own Agent Harness ever reads them.

The flow has four stages, each owned by a different module:

1. **`packages/myco/src/hooks/client.ts`** — the hook process talks to the daemon over HTTP, with a resilience layer for when the daemon isn't reachable.
2. **`packages/myco/src/daemon/stop-processing.ts`** — the daemon-side pipeline that runs when a symbiont turn ends (`POST /events/stop`): transcript mining, batch reconciliation, attachment capture, and triggering the title/summary task.
3. **`packages/myco/src/capture/transcript-miner.ts`** — the module that actually turns a raw transcript into ordered `prompt_batches` (and, via correlated tool events, `activities`).
4. **`packages/myco/src/daemon/session-reenrich.ts`** — a best-effort backfill pass that replaces placeholder session titles and prompts once a transcript is available.

# 1. Hooks: thin forwarders with a buffered fallback

`hooks/client.ts` exports `createHookDaemonClient()`, which builds a `DaemonClient` carrying request context (session id, caller cwd) resolved by `requestContextForHook()`. Individual hook entry points — `post-tool-use.ts`, `notification.ts`, `pre-compact.ts`/`post-compact.ts`, `session-end.ts`, and the Stop hook itself — are deliberately thin: they read stdin, build an event payload, and POST it to the daemon. `AGENTS.md`'s actor model (described on [Myco: Overview](/overview.md)) is why: hooks stay thin and delegate, because the daemon — not agent hooks — holds authority for intelligence work.

The daemon is not always reachable (not yet started, mid-restart, or crashed), so `hooks/send-event.ts` wraps every POST in an explicit buffer-or-not decision, `shouldBufferFallback()`. It is a response-shape state machine, not a simple try/catch:

- Any transport failure, timeout, or non-2xx → buffer. The daemon may have completed the work before failing; replay is content-keyed, so a duplicate buffered copy converges to a no-op.
- `ok: true` with an ignored-response shape → never buffer. An ignore is deliberate (capture rule, dedup, tombstone) and re-buffering it would recreate the noise the ignore exists to suppress.
- `ok: true, persisted: false, buffered: true` → nothing. The daemon already appended the durable copy; a second hook-side buffer write would be a double-buffer.
- `ok: true, persisted: false` with no `buffered: true` → buffer. This is the one honest fallback case: the daemon could not persist and holds no buffered copy of its own (e.g. unresolvable grove/project context).
- Stop events with no `persisted` field at all → always buffer, because `/events/stop` is queued by design (`{ ok, queued: true }`) and never reports a synchronous persist outcome.

`DaemonClient` itself (in `hooks/client.ts`) layers daemon discovery and recovery on top of the raw POST: `daemonConfirmedAlive()` probes a direct `daemon.json` read, a lock-file fallback, and a health-discovery pass across several attempts before giving up, and `resolveDaemonAuthHeader()` recovers the bearer token from environment, `daemon.json`, or the lock file in that order — closing a gap where a spawned child's `defaultHeaders` were captured before `daemon.json` existed. `EventBuffer` (`capture/buffer.ts`) is the on-disk fallback queue these paths write into; buffered events are replayed and reconciled once the daemon is reachable again, which is what makes the buffer-fallback contract above safe to reason about as "eventually converges" rather than "must not fail."

# 2. `daemon/stop-processing.ts`: the Stop pipeline

`createStopProcessor()` builds the handler for `POST /events/stop`, the daemon route that runs at the end of a symbiont turn. Its request body carries `phases: ('response' | 'transcript')[]` — most symbionts (Claude Code, Codex, Copilot) fire once per turn with both phases; a multi-phase symbiont like Windsurf sends one event per phase, so the handler treats phases as independently gated rather than assuming both always run together.

`processStopEvent()` is the core of the pipeline:

- **Transcript phase**: it asks `TranscriptMiner.getAllTurnsWithSource()` for all turns from the session's transcript file. If the transcript yields nothing (not yet flushed, or a symbiont without a file-based transcript), it falls back to `extractTurnsFromBuffer()` over the session's in-memory `EventBuffer` events. If both a transcript and newer buffer events exist, the newer buffer turns are appended — a live turn can outrun the transcript file on disk.
- Buffer `tool_use` events are correlated back onto mined turns by timestamp (`enrichTurnsWithToolMetadata()`), populating each turn's tool-usage breakdown and touched-files list — this is where turn-level activity metadata comes from, not from the transcript text alone.
- If a `transcript_path` is present, `reconcileBatchKinds()` is called to repair hook-race misclassifications — for example two consecutive batches both landing as `initial` when the second should have been classified `steering`.
- Beyond mining, the same handler drives attachment capture (`capture-images.ts`), plan-tag extraction (`plan-capture.ts`), skill-usage detection, and — via `triggerTitleSummary()` — fires the `title-summary` agent task so a session gets a real title instead of a raw prompt prefix.

A body-schema comment worth preserving: `transcript_path` is nullish because some symbionts (notably Codex) fire Stop hooks for internal sub-invocations — like an ephemeral title-generation session — that never write a transcript at all. The handler treats a null path on an uncaptured session as a silent no-op rather than an error.

# 3. `capture/transcript-miner.ts`: turning a transcript into rows

`TranscriptMiner` is the module that actually produces `prompt_batches`. Given a session id and (optionally) a transcript path, it uses the registered `SymbiontRegistry` adapters to parse the transcript into `TranscriptTurn`s, then reconciles those turns against already-inserted batches using `buildPrefixBuckets()` — a prompt-prefix-keyed bucket matcher that lets the miner match transcript order to existing DB rows regardless of DB insertion (id) order, since a live-reconcile pass and a Stop-time pass can observe turns in different orders. New turns are persisted via `insertBatchStateless()` (`db/queries/batches.ts`), which also classifies batch origin (`prompt-kind.ts`'s initial/steering/interrupt taxonomy) and records `HAS_BATCH`/`EXTRACTED_FROM` lineage edges consumed later by [Vault Intelligence](/subsystems/vault-intelligence.md)'s provenance graph.

One gotcha the vault has on record is directly relevant here: the `prompt_batches(project_id, content_hash)` unique index existed in the schema from the start but was **inert** — `insertBatchStateless` hardcoded `content_hash` to `NULL`, so the DB-level dedup guard never fired. The only real protection was the miner's single-pass `buildPrefixBuckets`/`consume()` matching, which has no backstop across *overlapping* passes — live-reconcile re-mining every ~3s during a turn, Stop-time mining, and (in a multi-daemon window) more than one daemon mining the same grove could each read a stale batch snapshot and insert the same prompt again. On dogfood data this produced real duplication: 39% of ~12,000 batches were byte-identical, one prompt duplicated 212 times in 127 minutes.

The fix (tracked as decision `decision-97bf74b3`) activated the index for real: `content_hash = sha256(session_id, origin, ordinal, trimmed prompt)`, where the ordinal is **transcript-positional**, supplied by the caller, and deliberately *not* a live `COUNT(*)` over already-committed rows — a DB-count ordinal would drift upward on every re-mine pass (each pass sees one more committed copy, computes a different hash, and the unique index never fires). `insertBatchStateless` now returns `{ row, created }` instead of a bare `BatchRow`, which structurally forces every call site to handle the dedup signal rather than silently double-counting. This is a useful pattern to recognize elsewhere in the capture path: identity in a system with overlapping/concurrent passes needs a stable positional key, not a recomputed aggregate.

# 4. `daemon/session-reenrich.ts`: backfilling placeholder titles

`reEnrichSessionFromTranscript()` is a separate, idempotent pass — not part of the Stop pipeline's synchronous path — that repairs sessions whose `title`, `user_prompt`, or `response_summary` still carry fallback/sentinel values (`RECOVERED_BATCH_SENTINEL`, or an empty string) because the live capture path could not reach a transcript at the time. It re-mines the transcript via the same `TranscriptMiner.getAllTurnsWithSource()` used by the Stop pipeline, then:

- Sets `sessions.title` from the first mined turn's prompt, but **only** if the current title is still the sentinel or empty — a session the live path already titled cleanly is left untouched.
- Walks batches in transcript order and replaces any batch whose `user_prompt` is still the recovered-sentinel value with the mined prompt text, re-classifying its origin via `classifyNextPromptOrigin()` so a sentinel that was actually a synthesized envelope (e.g. a `<task-notification>`) doesn't regress into a human-origin classification.
- Sets the last batch's `response_summary` from the transcript's final assistant reply if one isn't already recorded, stripping plan-tag envelopes first (the same contract the miner and Stop pipeline apply, so plan payloads never leak into a user-facing summary).

Every write in this module is gated on the row still carrying its fallback value — this is what makes the pass safe to run repeatedly and safe to run late. It explicitly does **not** touch `activities`, and a comment in the module notes that `sessions.prompt_count` is deliberately *not* recomputed here, because `insertBatchStateless` already maintains that cache atomically on every insert; re-deriving it from `turns.length` here would risk diverging the cache from the real row count instead of fixing it.

# Where this hands off

Once `prompt_batches` and `activities` rows exist in the Grove database, they are inert until an agent run picks them up: `vault_unprocessed` (used by the `vault-evolve` task's extraction phase, described on Myco's Own Agent Harness) reads unprocessed batches, extracts spores, and everything downstream — supersession, consolidation into wisdom, digest tiers — is [Vault Intelligence](/subsystems/vault-intelligence.md)'s concern, not this pipeline's. The session-start counterpart of this flow — pushing knowledge back *into* a new symbiont session rather than capturing it out of one — is covered on [Cortex — Session-Start Guidance](/subsystems/cortex.md).

Two things this page does not pin down precisely, because the source modules don't expose them as an explicit contract: the exact ordering/timing guarantee between a Stop-processing mining pass and a concurrent reenrichment pass on the same session, and the trigger condition that decides *when* `session-reenrich.ts` runs for a given session versus relying on the Stop pipeline to have already produced clean values.

# Citations

[1] `packages/myco/src/hooks/client.ts` — `createHookDaemonClient`, `requestContextForHook`, `daemonConfirmedAlive`, `resolveDaemonAuthHeader`
[2] `packages/myco/src/hooks/send-event.ts` — `shouldBufferFallback` response-shape contract
[3] `packages/myco/src/daemon/stop-processing.ts` — `createStopProcessor`, `processStopEvent`, `enrichTurnsWithToolMetadata`, phased (`response`/`transcript`) Stop body schema
[4] `packages/myco/src/capture/transcript-miner.ts` — `TranscriptMiner`, `buildPrefixBuckets`, batch insertion via `insertBatchStateless`
[5] `packages/myco/src/daemon/session-reenrich.ts` — `reEnrichSessionFromTranscript`
[6] Canopy summaries: `packages/myco/src/hooks/post-tool-use.ts`, `post-compact.ts`, `pre-compact.ts`, `notification.ts`, `session-end.ts`, `tests/hooks/stop-buffer.test.ts`, `tests/daemon/stop-processing.test.ts`, `tests/daemon/session-reenrich.test.ts`
[7] spore `gotcha-a5ac08a8` — "prompt_batches unique index inert since creation" root cause and dogfood duplication measurement
[8] spore `decision-97bf74b3` — positional-ordinal `content_hash` dedup fix and `insertBatchStateless` `{row, created}` contract change
[9] `overview.md`, `subsystems/vault-intelligence.md` — published pages this page was already cross-linked from

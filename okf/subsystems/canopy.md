---
type: Subsystem
title: "Canopy: Code-Intelligence Pipeline"
description: How Canopy turns raw files into a searchable, per-file knowledge index (scan → describe → embed → map), and the three-root-cause pending-count bug family every maintainer of its count logic should know.
timestamp: '2026-07-08T15:52:42.325Z'
---

Canopy is Myco's code-intelligence pipeline: it keeps a per-file index of "what's in this project" so agents (and now this OKF wiki) can be grounded in the real codebase instead of guessing. The pipeline runs in three stages — mechanical scan, optional LLM describe, optional embedding — plus a synthesis stage that rolls the per-file entries into a project [Canopy map](/overview.md). This page traces that pipeline through its actual modules and then works through a recurring bug family in its pending-count logic, because that family is the sharpest lesson in the codebase on how *not* to compute an aggregate health count.

# The three-stage pipeline

## Stage 1 — Mechanical scan (no LLM)

The scanner lives under `packages/myco/src/canopy/scanner/`:

- `scan-file.ts` reads a single file, checks size limits and binary content, and produces a `CanopyEntry` record — size, line count, language, exports, imports, and the leading docstring/top comment. No model call is involved; a full-project scan finishes in under a second.
- `delta-scan.ts` does incremental scanning: it only re-parses a file when its size differs from the stored entry, so routine rescans run in milliseconds.
- `rescan-single.ts` handles the targeted case — one file, upsert-or-delete — used when the agent edits a file or a session starts.
- `upsert.ts` is the mechanical write path into `canopy_entries`: it refreshes file metadata on every scan while deliberately preserving the LLM-generated `llm_description` field across rescans, so a re-scan never blows away Tier-2 work.

The index updates on three triggers: an agent edit (immediate rescan of that file), session start (a background delta scan for changes made outside the agent — an editor, `git pull`, a teammate's branch), and an hourly scheduled rescan for quiet projects. This scan is what backs the injection Canopy performs on agent `Read` calls — it hands over anatomy before a full read, and the agent decides whether the read is still worth it.

## Stage 2 — Describe (opt-in LLM pass)

Describe is Tier 2: a one-sentence, LLM-generated summary stored in `canopy_entries.llm_description`, layered on top of the mechanical anatomy. It is off by default and turned on per project.

The task definition is `packages/myco/src/agent/definitions/tasks/canopy-describe.yaml`, a **map-mode** task (the same phase-loop machinery documented on Myco's Own Agent Harness):

- `source`: `canopy_describe_next` fetches a batch of pending rows (`batch_size: 10` by default — local 26B-class models degrade past ~10 tool-emitting follow-ups per turn; frontier models could go higher, but the config stays conservative for the local case).
- `item`: renders one prompt per file (path, language, exports, imports, top comment, first lines) and requires the model to call `canopy_describe_write` — a text-only response is discarded.
- `sink`: `canopy_describe_write` persists the description (≤180 chars by default).
- `accounting`: `canopy_describe_charge` charges one describe attempt per content-failed/skip item at the end of the phase — but connectivity-unavailable items are excluded by the map-phase hook, so a provider outage never burns the row's retry budget. That accounting design is a direct structural response to a real incident (below).

Scheduling is driven by an accelerator: `canopy-pending-describe` with `steady: 50` / `accelerated: 500` thresholds, gated by the `has-pending-canopy-rows` precondition, and deliberately allowed to run during `active` sessions (not just idle/sleep) because a describe batch is lightweight (~3–23s) and often routed to a different, cheaper model than the foreground agent.

**Circuit breaker at the harness layer.** An earlier incident (session `d31ae29b`, wisdom `id-hash-8bc0e99b9c3fa74e`) found that `canopy_describe_next` incremented `describe_attempts` at *fetch* time, before any LLM call — so an ~11-hour LM Studio outage burned through the full 2-attempt budget on 26 rows with zero actual LLM attempts, permanently exhausting them while the dashboard, which gated on the same `describe_attempts < max_attempts` predicate, showed a clean "0 pending / fresh" status. The fix was a provider-health circuit breaker built into the harness itself (not canopy-specific task code), keyed per `(provider_type + base_url)` so one dead local endpoint doesn't trip other providers, marking items `skipped` rather than `failed` when the circuit is open so the retry budget survives a known-down provider. The `accounting` block above and the "connectivity-unavailable items are excluded" comment in the YAML are the surviving evidence of that fix.

## Stage 3 — Embedding (opt-in, downstream of describe)

Once a file has a description, it becomes eligible for embedding into the `canopy_entries` vector namespace (`CANOPY_ENTRIES_NAMESPACE`, in `db/queries/embeddings.js`) via `packages/myco/src/daemon/embedding/index.ts`. `packages/myco/src/canopy/search.ts` is the shared search helper both the harness's `vault_search_canopy` tool (used throughout this synthesis run) and the daemon's `/api/search` canopy route call through: it embeds the query, calls `embeddingManager.searchVectors()` against the `canopy_entries` namespace, and hydrates results with `llm_description` via one batched SQL lookup rather than N per-row queries. This is "search by behavior, not keyword" — a query like "where does session capture happen" can match a file even if those words never appear in it, which is what makes Canopy-grounded synthesis (like this page) possible in the first place.

## Synthesis — the Canopy map

Above the per-file entries sits a single synthesized project map: a directory skeleton plus 4–8 annotated domain clusters, generated by the `canopy-map` task (`packages/myco/src/agent/definitions/tasks/canopy-map.yaml`) and persisted through `canopy/map/store.ts`. `canopy/map/inputs-hash.ts` hashes the underlying describe data so the map only regenerates when the file descriptions it's built from actually drift, and short-circuits silently otherwise. Agents pull it on demand via `myco_cortex` op `canopy_map` — this is the "orientation" mechanism `okf_read_sources` uses to bootstrap this very wiki bundle, per the reframe described on OKF Publishing.

# The pending-count bug family: three root causes, one shape

Canopy's "pending" / backlog counts feed the Grove Operations dashboard, the describe scheduler's precondition, and the accelerator that speeds up scheduling under load. Getting that count wrong is silent and self-concealing, and it has happened three separate times for three independent reasons (wisdom `id-hash-2ee15c400a2d5427`, consolidating the incident history). The family's shared lesson: **any aggregate health/pending count over a multi-stage, multi-project pipeline must account for pipeline stage, project lifecycle state, and capability gating — or it silently misreports.**

**1. Stage blindness.** `getEmbeddingQueueDepth()` and the `canopy_entries` namespace `pending` count both queried `embedded = 0 AND llm_description IS NOT NULL`. A row with a fresh mechanical scan but a *stale* LLM description is invisible to that predicate: description non-null but stale, `embedded` possibly still `1`. Result: the embedding-queue count showed 0 (green) while 231 rows had a stale/missing describe-stage backlog upstream. Fix: added scribe (describe) backlog counts as a separate projection alongside vector counts, so health is visible at every pipeline stage, not just the terminal one.

**2. Counter scope wider than worker scope.** `getCanopyDescribeBacklog` counted every `canopy_entries` row in the Grove DB, but the scribe worker and its wake probe only service `listRegisteredProjects()` — active, non-archived projects (`daemon/task-scheduling.ts`). This produced 7,619 phantom pending rows: 6,616 from a deleted project (a whole home directory accidentally scanned, then deregistered *before* the `GROVE_PROJECT_SCOPED_TABLES` delete cascade existed) plus 818 from an archived project. Fix (2026-06-09): `createCanopyDescribeBacklogReader` (`canopy/describe-backlog.ts`) restricts grove-wide reads to active registered project IDs via a `projectIds` option, falling back to unrestricted when the grove record can't be loaded — "unrestricted truth beats a false zero."

**3. Capability gate bypassed entirely.** The same family, a different axis: #2 closed out deleted/archived projects; this one left *Canopy-disabled* projects open. Operations showed a fixed 435 pending that never drained. The rows weren't orphans — they belonged to two active, registered projects with `cortex.canopy.enabled: false`. Root cause: `serviceableProjectIds` in `canopy/describe-backlog.ts` returned every registered project with **no capability check**, while the actual describe worker only ever ran on capability-enabled projects. The fix (verified above by reading the current source) filters `serviceableProjectIds` through `projectCanopyEnabled()` = `capabilityEnabled(loadMergedConfig(...), 'canopy')`, mirroring the same gate the daemon's `resolveCapabilities` and injection path already used. The predicate is deliberately capability-ONLY, not capability+schedule combined — a project with Canopy on but its describe schedule paused still has a legitimately pending backlog and must still show. A secondary gotcha surfaced during this fix: `loadMergedConfig` *throws* when `myco.yaml` is absent, so it must be caught and treated as `capabilityEnabled(null) = false` to stay fail-closed.

None of the three fixes subsumes another — they're additive, each closing a different axis of "what should count as pending." A future maintainer touching Canopy's count logic should check all three before shipping: stage coverage, project lifecycle scope, and capability-gate parity with the real service loop.

# Where this fits

Canopy is one of Myco's opt-in capabilities, alongside Cortex, skills, and vault evolution — see [Vault Intelligence](/subsystems/vault-intelligence.md) for how the spores and wisdom notes cited on this page (including the pending-count wisdom itself) are produced and consolidated. Canopy's own background tasks run through the same [Runtime & Daemon Authority](/architecture/runtime-and-daemon.md) that schedules every other Myco background job, and its describe task is a concrete instance of the map-mode phase machinery described on Myco's Own Agent Harness.

# Citations

[1] `packages/myco/src/canopy/scanner/scan-file.ts`
[2] `packages/myco/src/canopy/scanner/delta-scan.ts`
[3] `packages/myco/src/canopy/scanner/rescan-single.ts`
[4] `packages/myco/src/canopy/scanner/upsert.ts`
[5] `packages/myco/src/agent/definitions/tasks/canopy-describe.yaml`
[6] `packages/myco/src/canopy/search.ts`
[7] `packages/myco/src/canopy/describe-backlog.ts`
[8] `packages/myco/src/daemon/embedding/index.ts`
[9] `docs/canopy.md`
[10] Wisdom spore `id-hash-2ee15c400a2d5427` — Canopy Operations Pending-Count Misrepresentation: Three Independent Root Causes
[11] Wisdom spore `id-hash-8bc0e99b9c3fa74e` — Canopy Describe: Failure Arc, Invisible-Row Bug, Circuit Breaker Design, and Provider Confusion (session `id-hash-160f834bab5ef300`)

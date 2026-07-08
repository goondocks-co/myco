---
type: Subsystem
title: "Team Sync: Outbox to Cloudflare Worker to D1"
description: How local outbox rows travel through the Cloudflare Worker into D1, and the team_id immutability fix that closed a tenancy-leak class of bugs.
timestamp: '2026-07-08T15:52:42.326Z'
---

## What team sync moves, and where it goes

Team Sync replicates a subset of the local Grove SQLite database to a shared Cloudflare-hosted backend so teammates on different machines can search each other's spores, sessions, plans, artifacts, and skill records. The pipeline has three concrete stages, each a real module:

1. **Local outbox** — `packages/myco/src/db/queries/team-outbox.ts`. A thin buffer table (`team_outbox`) that the daemon writes to whenever a syncable row changes. It is explicitly *not* the sync transport itself — the module's own header comment describes it as "a thin local buffer for the daemon → team Worker hop. Cloudflare Queues handle retries, exponential backoff, and dead-lettering once a record reaches the worker; the outbox just remembers what we still need to hand off."
2. **`TeamSyncClient`** — `packages/myco/src/daemon/team-sync.ts`. The HTTP client the daemon uses to push outbox records to the worker, run team knowledge searches, and poll connection health. It also negotiates protocol compatibility (`computeVersionCompat`) against the worker's advertised `SYNC_PROTOCOL_VERSION`/`MIN_COMPAT_CLIENT_VERSION` window before pushing, so an old daemon or an old worker fails closed with a clear `client_too_old`/`worker_too_old` reason rather than shipping malformed rows.
3. **Cloudflare Worker + D1** — `packages/myco-team/worker/src/index.ts` and `packages/myco-team/worker/src/schema.ts`. The worker accepts sync records, deduplicates by `content_hash`, writes them into D1, and for embeddable tables (`spores`, `sessions`, `plans`, `artifacts`, `skill_records`) also indexes them into Vectorize for shared semantic search.

D1's tables (`sessions`, `prompt_batches`, `spores`, `entities`, `graph_edges`, `plans`, `artifacts`, `resolution_events`, `digest_extracts`, …) intentionally mirror the local SQLite schema, but every one of them keys on the **composite primary key `(id, machine_id)`** — not `id` alone — because the same logical table is populated by every teammate's machine independently, and IDs are only unique per-machine. This is the multi-writer answer to the same kind of tenancy problem this page's central bug is about: identity has to be scoped correctly at the storage layer, or rows from different origins collide or shadow each other.

Not everything in the local database syncs. `team-outbox.ts` maintains an explicit `LOCAL_ONLY_OUTBOX_TABLES` set (e.g. `cortex_instructions`, `knowledge_git_provenance`, `session_myco_tool_calls`) and a `LOCAL_ONLY_SYNC_COLUMNS` map (e.g. Canopy injection telemetry on `sessions`) with a human-readable rationale for each, surfaced in the Team page UI so operators can see *why* some local data never leaves the machine — mostly per-machine behavioral telemetry or local provenance (branch names, commit SHAs) that isn't team-safe. This module lives in the daemon described on [Runtime & Daemon Authority](/architecture/runtime-and-daemon.md); the same daemon that owns the outbox is the one that owns Grove's per-home SQLite databases.

## The root bug: tenancy as a derived value, not a carried one

Before the fix described below, `team_outbox` rows carried `machine_id` and `project_id` but **no `team_id`**. Which team a row belonged to was not a property of the row — it was re-derived at drain time from `membershipByProject().get(projectId)` in `team-sync-init.ts`. Team isolation was expressed only as *which worker/D1 the daemon happened to talk to at drain time* — a routing key recomputed from live, mutable membership state, never a value stamped onto the record when it was created.

That is dangerous in two concrete ways:

- If a project's team membership changes (moved teams, or removed from a team) **before** its queued outbox rows drain, the rows get routed to the wrong team's worker, or silently dropped — the drain code drops a row outright when the current membership map has no entry for its `project_id`.
- `purgeNonMemberOutbox` (`team-outbox.ts`) independently purges outbox rows for any project that is no longer a member of a team — a second code path with the same "membership must still be true right now" assumption.

Both of these treat team tenancy as something to look up fresh at the moment of use, rather than as an immutable fact fixed at the moment the row was created.

## The fix: stamp team_id at enqueue, route by the carried value

The fix adds a `team_id` column to both `team_outbox` and `team_sync_membership`, stamped by the TypeScript layer **at enqueue time** — never re-derived from live membership at drain time. Drain routing then reads the carried column first, falling back to the old live-membership lookup only for legacy rows written before the column existed:

```ts
// team-sync-init.ts — drain routing
const teamId = row.team_id ?? map.get(row.project_id) ?? null;
```

This one line is the whole shape of the fix: prefer the value stamped on the row; only fall back to derivation for rows that predate the column. `OutboxInsert` and `OutboxRow` in `team-outbox.ts` both carry `team_id: string | null` accordingly, and the worker's D1 `synced_tables` model treats `team_id` the same way — a value written once and carried, not recomputed.

The `team_sync_membership.team_id` column exists for a second, less obvious reason: **SQL delete triggers cannot read the file-based team registry.** Cascading deletes on `team_sync_membership` fire synchronously inside SQLite and have no way to call out to the `~/.myco-team/` registry to look up which team a project belonged to. Insert/update paths are fine because the TypeScript layer already has the `team_id` in hand and passes it explicitly — but a delete trigger can only read `OLD.team_id` from the row it's cascading from. Without the column on the table itself, a trigger-driven tombstone would have no `team_id` to stamp, leaving the tombstone un-routable at drain time. This is a specific, generalizable lesson: **if a DB-level trigger needs to act on a value, that value must live in a DB column — a value only available from an external registry file is invisible inside the transaction.**

A related ordering rule follows from the same routing logic: when a project is removed from a team, **tombstone rows must be enqueued into `team_outbox` before the project is removed from the membership registry**, not after. Reversing the order means drain's membership-map lookup (and `purgeNonMemberOutbox`) no longer see the project as a member and silently drop or purge the tombstones — orphaning the cloud copy instead of deleting it.

## The phantom-badge bug this fix's investigation surfaced

The team_id work traces back to a concrete production symptom: the Teams panel's Sync badge showed a phantom "1 project" count for a team whose only project actually lived in the *dev*-home grove (`~/.myco-dev`), not the production home. Root cause: the daemon's list-projects handler calls `listGroves()` — which is correctly **home-scoped** (it resolves against the current `MYCO_HOME`, matching the per-home Grove model described on [Runtime & Daemon Authority](/architecture/runtime-and-daemon.md)) — but then joins that against the team config lookup, which reads the **machine-scoped** registry at `~/.myco-team/`. Because team membership is scoped to the whole machine while grove registries are scoped per-home, the join succeeds across a home boundary it shouldn't cross, inflating the badge count with a project that isn't actually visible from that daemon's home.

The fix scopes the Sync/Teams badge query with a projects-by-home predicate so it only counts projects belonging to the current daemon's home — the same "home-scoped" boundary the rest of Grove already respects, just missing from this one query path. A related but separate finding from the same investigation: `machine_id` (`${githubUser}_${machineHash}`) is cached **per home**, not shared machine-wide — the production and dev daemons each have their own cached `machine_id` under their own `MYCO_HOME`. That means the phantom count was never caused by both daemons pushing to the same D1 namespace; it was purely the home-scoping gap in the badge query.

Across both bugs the pattern is the same: **a value that is supposed to identify a tenant (team, home, machine) was being derived from a broader or more mutable scope than the one that actually determines correctness**, and the fix was always to either carry the correct value explicitly (team_id on the outbox row) or scope the query to the correct boundary (home-scoped project lookup instead of machine-scoped team config).

## Reconciliation backstop and sync UX principle

Even with correct enqueue-time stamping, drift can still happen — local deletes while sync was disabled, orphans from membership transitions before the ordering fix existed, etc. `reconcilePartition` (`team-reconcile.ts`) is a fully automatic backstop: it diffs the local partition (scoped to `(machine_id, project_id)`) against the D1 manifest and deletes any cloud-extra rows it finds, with a guard that ensures it only ever touches rows belonging to its own machine and project. It is not a substitute for correct enqueue ordering — it only fires on the next reconcile cycle, not immediately — but it means transient drift self-heals instead of accumulating.

This backstop reflects a broader UX principle behind Team Sync: **the local DB is the source of truth, and sync is designed to just work without surfacing errors to regular users.** When a user unsyncs a project, the local DB update is the success signal — it happens immediately and is guaranteed. Cloud convergence (via the outbox → worker → D1 path described above) happens asynchronously with retry, and sync failures are never exposed as user-facing errors. Only team operators — the people who install and administer the worker — are expected to deal with infrastructure-level problems (worker health, D1, KV).

## Why this matters beyond team sync

The team_id fix is a specific instance of a general rule worth carrying to any subsystem that partitions data by tenant, owner, or scope (see how [Vault Intelligence](/subsystems/vault-intelligence.md) scopes spores and digests per project, or how the [Skill Lifecycle](/subsystems/skill-lifecycle.md) pipeline's `skill_records` table is one of the tables this worker embeds into Vectorize): once a row is created under a given tenant, that tenant identity should be stamped on the row and treated as immutable, not re-derived from live state that can change out from under a queued or in-flight record. Deriving tenancy at read/drain time is a bug waiting for the membership window between "row created" and "row processed" to be crossed by a real-world change.

# Citations

- `packages/myco/src/db/queries/team-outbox.ts` — outbox schema, `LOCAL_ONLY_OUTBOX_TABLES`/`LOCAL_ONLY_SYNC_COLUMNS`, `OutboxInsert`/`OutboxRow` with `team_id`
- `packages/myco/src/daemon/team-sync.ts` — `TeamSyncClient`, `computeVersionCompat` protocol gating
- `packages/myco-team/worker/src/index.ts` — Cloudflare Worker sync endpoint, `EMBEDDABLE_TABLES`, `SYNCED_TABLES_SET`
- `packages/myco-team/worker/src/schema.ts` — D1 schema, composite `(id, machine_id)` primary keys
- `packages/myco/src/daemon/team-sync-init.ts` (line ~612: `row.team_id ?? map.get(row.project_id) ?? null`) — drain routing carried-value-first fallback
- Session `id-hash-9cfa6608d99f9abb` — "Cross-home team visibility leak: phantom badge and tenancy foundation" (released, high confidence)
- Spore `id-hash-c2199f8a65fbabc7` (wisdom, importance 9) — "Team Sync Tenancy and Scoping Architecture," synthesized from 9 source spores in the Teams feature plan v10 arc

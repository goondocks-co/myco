---
name: myco:team-sync-data-layer
description: |
  Use this skill when working on Myco's team sync data pipeline: the outbox →
  D1/Vectorize → Worker federation layer. Covers the full protocol domain —
  outbox/tombstone design, machine_id keying, drain mechanics, D1 schema
  management, backfill idempotency, the three silent failure modes, Worker
  federation topology, cross-machine verification, and composite index
  optimization. Activate this even if the user doesn't explicitly ask for
  "team sync" — trigger whenever adding a new sync-able entity type, debugging
  why data isn't appearing on a remote machine, investigating D1 schema drift,
  fixing stale outbox rows, or verifying a new team member's vault is
  bootstrapped correctly. Complements cloudflare-worker-infrastructure-lifecycle
  (deploy mechanics) and vault-schema-extension (local migration authoring) but
  covers the data protocol layer that neither addresses.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Myco Team Sync Data Layer

The team sync pipeline moves local SQLite vault data to Cloudflare D1 (structured) and Vectorize (embeddings) via an outbox pattern, then federates that data to other machines through a Worker. Every sync-able entity type (spores, sessions, plans, artifacts, skills) must participate in the full protocol — write-through outbox insert, tombstone on delete, machine_id keying — or remote machines will silently diverge with no error.

This skill covers the **data protocol layer**. For Worker deployment mechanics, see `cloudflare-worker-infrastructure-lifecycle`. For local migration authoring, see `vault-schema-extension`.

## Prerequisites

- Daemon is running and connected to a D1 database binding
- `machine_id` is set in daemon identity (not `null`); `local` is the v7 backfill fallback for pre-identity rows
- `wrangler.toml` has the correct D1 binding name matching the Worker's expected binding
- Local SQLite schema and D1 schema are in sync before adding new entity types

---

## Procedure A: Adding a New Sync-able Entity Type

When adding a new table or entity type to the sync pipeline (e.g., skills, plans, artifacts), every step below is required. Skipping any one causes silent data loss on remote machines.

### 1. Add machine_id column to the local table

Every sync-able table must have a `machine_id` column. Without it, D1 rows cannot be attributed to the correct machine and federation filtering breaks.

```sql
-- In the versioned migration file (src/db/migrations/vXX_add_<entity>.sql)
ALTER TABLE <entity> ADD COLUMN machine_id TEXT NOT NULL DEFAULT 'local';
```

### 2. Define the outbox row schema

The `outbox` table holds pending sync operations. Each row must contain:

```sql
entity_type TEXT NOT NULL,       -- e.g. 'spore', 'skill', 'plan'
entity_id   TEXT NOT NULL,       -- entity primary key
machine_id  TEXT NOT NULL,       -- from daemon identity
operation   TEXT NOT NULL,       -- 'upsert' | 'tombstone'
payload     TEXT,                -- JSON-serialized entity (NULL for tombstone)
created_at  INTEGER NOT NULL,
synced_at   INTEGER,             -- NULL until D1 confirms receipt
status      TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'sent' | 'dead'
```

### 3. Write-through on every INSERT/UPDATE

Every write to a sync-able table must also insert an outbox row **in the same SQLite transaction**. If the outbox insert fails, the entity write rolls back.

```typescript
db.transaction(() => {
  db.prepare(`INSERT INTO <entity> (...) VALUES (...)`).run(...);
  db.prepare(`
    INSERT INTO outbox (entity_type, entity_id, machine_id, operation, payload, created_at, status)
    VALUES (?, ?, ?, 'upsert', ?, unixepoch(), 'pending')
  `).run(entityType, entityId, machineId, JSON.stringify(entity));
})();
```

### 4. Tombstone on delete — never hard DELETE

Hard deletes silently orphan remote replicas because no outbox row is written. On delete, write a tombstone outbox row first, then soft-delete the local row.

```typescript
db.transaction(() => {
  // Soft-delete the entity
  db.prepare(`UPDATE <entity> SET deleted_at = unixepoch() WHERE id = ?`).run(entityId);
  // Write tombstone — this is what propagates the deletion remotely
  db.prepare(`
    INSERT INTO outbox (entity_type, entity_id, machine_id, operation, payload, created_at, status)
    VALUES (?, ?, ?, 'tombstone', NULL, unixepoch(), 'pending')
  `).run(entityType, entityId, machineId);
})();
```

> **Gotcha:** A hard `DELETE` removes the local row but no tombstone outbox row is written. The remote machine retains a stale copy indefinitely. This is **silent failure mode #2**.

### 5. Mirror the schema change in D1

Add the same column (and tombstone column if new) to the D1 migration file under `workers/migrations/`. D1 migrations apply lazily — see Procedure D for the drift window.

### 6. Add the composite drain index

For each new entity type participating in drain queries, ensure the outbox has a composite index (see Procedure G).

---

## Procedure B: Outbox Drain Mechanics

The drain loop runs on a configurable interval (`drainIntervalMs`) and flushes `pending` outbox rows to D1 via the Worker.

### Drain rate

Rows are batched — typically 50–100 per cycle. Tune `drainBatchSize` in daemon config if the outbox grows faster than the drain rate.

### sleep/deep_sleep drain gap (known issue)

When the daemon enters `sleep` or `deep_sleep` states, the drain loop does **not** run. Outbox rows accumulate and are flushed only after the daemon wakes. This is a known team sync gap. Design downstream consumers to tolerate the latency, and do not rely on real-time sync during low-activity periods.

### Drain confirmation

A D1 write is confirmed only when the Worker returns HTTP 200 with a success response body. On confirmation, mark the row sent:

```sql
UPDATE outbox SET status = 'sent', synced_at = unixepoch() WHERE id = ?;
```

> **Gotcha (silent failure mode #1):** The drain can complete locally (no exception thrown) but the D1 write fails silently if the Worker swallows errors and returns 200 anyway. Detect by watching for outbox rows that stay `pending` across multiple drain cycles, then check Worker logs.

### Pruning

Prune sent rows after confirmed D1 ack to keep the outbox table bounded:

```sql
DELETE FROM outbox WHERE status = 'sent' AND synced_at < unixepoch() - 86400;
```

Dead-lettered rows (`status = 'dead'`, stuck > N drain cycles) indicate a persistent Worker or D1 error — log them and investigate before re-queueing.

### Startup backfill

On daemon start, backfill unsynced rows from settled sessions into the outbox. This covers crashes mid-drain and offline periods. The backfill query must be idempotent — see Procedure C.

### settledSessionIdleMinutes interaction

The drain only processes rows from sessions that have reached `settled` state. If `settledSessionIdleMinutes` is high, recently-written rows wait longer before becoming eligible. Tune this value to balance drain latency against premature settlement of active sessions.

---

## Procedure C: Backfill Idempotency

Startup backfill runs every time the daemon starts and must be safe to run multiple times (crash recovery, rapid restarts).

### INSERT OR IGNORE with a dedup index

Use a unique partial index and `INSERT OR IGNORE` to prevent duplicate outbox rows:

```sql
-- Dedup index (create once in migration)
CREATE UNIQUE INDEX IF NOT EXISTS outbox_dedup
  ON outbox (entity_type, entity_id, operation)
  WHERE status = 'pending';

-- Idempotent backfill query
INSERT OR IGNORE INTO outbox
  (entity_type, entity_id, machine_id, operation, payload, created_at, status)
SELECT
  'spore', id, machine_id, 'upsert', json_object(...), unixepoch(), 'pending'
FROM spores
WHERE synced_at IS NULL
  AND session_id IN (SELECT id FROM sessions WHERE status = 'settled');
```

### Idempotency key design

The key is `(entity_type, entity_id, operation)`. Do **not** include timestamps in the key — the same entity may be re-inserted at different times during retries, and timestamps would allow duplicates.

### Dead-letter recovery

Rows stuck in `pending` for more than N cycles (configurable, e.g., 10 attempts) should be transitioned to `dead` and logged. To re-queue after diagnosing the Worker/D1 issue:

```sql
UPDATE outbox SET status = 'pending', synced_at = NULL WHERE status = 'dead' AND entity_type = ?;
```

---

## Procedure D: D1 Schema Management

D1 uses **lazy migration** — `ALTER TABLE` applies on the first Worker request after deploy, not at deploy time. This creates a schema drift window between `wrangler deploy` completing and the first request arriving.

### The drift window

During the drift window, queries against new columns fail. This window is typically seconds to minutes depending on traffic, but in low-traffic environments it can persist indefinitely.

**Mitigation:** Trigger a warm-up request immediately after every deploy:

```bash
# In CI/CD, after wrangler deploy
curl -X POST https://<worker>.workers.dev/health \
  -H "Authorization: Bearer $MYCO_TEAM_TOKEN"
```

This forces the lazy migration to run before any real traffic hits the new schema.

### Sync checklist for schema changes

Include in the PR description for any schema change:

- [ ] Local migration file added (`src/db/migrations/vXX_*.sql`)
- [ ] D1 migration file added (`workers/migrations/`)
- [ ] Column names and types match exactly between local and D1
- [ ] `myco team upgrade` tested locally with `wrangler dev`
- [ ] Warm-up step added to deploy pipeline

### Testing D1 migrations without a live account

Use `wrangler dev --local` with `--persist-to` to run D1 migrations locally:

```bash
wrangler dev --local --persist-to .wrangler/state
# Migrations apply on first request
curl http://localhost:8787/health
```

The local state persists across dev restarts, so subsequent starts reflect the migrated schema.

---

## Procedure E: Machine ID Keying and Verification

The `machine_id` column flows from daemon identity through the outbox into D1. Correct keying is required for Worker federation to route data to the right machine.

### machine_id source

The daemon reads `machine_id` from its identity config at startup. The v7 migration backfilled `machine_id = 'local'` for pre-identity-system rows — `local` is a valid sentinel but indicates a row that cannot be federated to a specific machine.

### Verifying correct keying in D1

```sql
-- Which machines have written to D1?
SELECT machine_id, count(*) as row_count
FROM spores
GROUP BY machine_id;

-- Detect null or empty machine_id — these rows cannot be federated (failure mode #3)
SELECT count(*) FROM spores WHERE machine_id IS NULL OR machine_id = '';
```

### Cross-machine contamination prevention

The Worker federation query must scope to **both** `project_id` and `machine_id`. A missing `project_id` filter allows data from other projects to leak across project boundaries.

```typescript
// Correct — scoped to project + machine
const rows = await db.prepare(`
  SELECT * FROM spores
  WHERE project_id = ? AND machine_id = ?
`).bind(projectId, machineId).all();
```

> **Gotcha (silent failure mode #3):** If `machine_id` is NULL or `'local'`, rows are written to D1 but the Worker cannot federate them to the correct remote machine. Remote machines will not see the data, with no error on either side. Detect with the D1 verification query above.

---

## Procedure F: Cross-Machine Verification

Use this procedure to confirm team sync is working end-to-end between two machines, or as an integration gate before merging team sync changes.

### Integration gate checklist

**On Machine A (writer):**

1. Write a test entity via the daemon (e.g., create a spore)
2. Verify the outbox row was created:
   ```sql
   SELECT * FROM outbox
   WHERE entity_type = 'spore' AND status = 'pending'
   ORDER BY created_at DESC LIMIT 5;
   ```
3. Wait for the drain cycle (or trigger drain manually if a dev endpoint exists)
4. Verify the outbox row is marked `sent`:
   ```sql
   SELECT status, synced_at FROM outbox
   ORDER BY synced_at DESC LIMIT 5;
   ```
5. Verify D1 contains the row with the correct `machine_id`:
   ```bash
   wrangler d1 execute <DB_NAME> --remote \
     --command "SELECT id, machine_id FROM spores ORDER BY created_at DESC LIMIT 5;"
   ```

**On Machine B (reader):**

6. Query via vault API or MCP — `vault_spores` or `vault_search_semantic` should return the entity written on Machine A
7. Confirm the `machine_id` on the retrieved row matches Machine A's identity

If step 6 fails: check Machine A's drain status, Machine B's sync backfill, and the Worker's federation scope query.

### New team member bootstrap

Two onboarding paths — choose based on vault size:

**Backup/restore** (faster for large vaults):
```bash
# On existing machine
myco backup --output team-vault-snapshot.zip

# On new machine
myco restore --input team-vault-snapshot.zip
```

**Fresh sync** (always pulls latest state, slower):
- Start daemon on new machine with empty vault
- Daemon's startup backfill re-queues all settled sessions from D1
- Drain loop populates the local vault

Fresh sync requires the D1 schema to be fully migrated (warm-up after deploy) before the new machine's first request.

---

## Procedure G: Composite Index Optimization

The drain query scans the outbox table at every drain cycle. Without a composite index, this is O(n) on total outbox size regardless of how many rows are `pending`.

### Required drain index

```sql
CREATE INDEX IF NOT EXISTS outbox_drain_idx
  ON outbox (machine_id, status, synced_at);
```

This index directly supports the drain query shape:

```sql
SELECT * FROM outbox
WHERE machine_id = ? AND status = 'pending'
ORDER BY created_at ASC
LIMIT ?;
```

### Partial index for large outbox tables

If the outbox grows large (millions of rows), a partial index on only `pending` rows reduces the index size significantly:

```sql
CREATE INDEX IF NOT EXISTS outbox_drain_pending_idx
  ON outbox (machine_id, created_at)
  WHERE status = 'pending';
```

This is more efficient than the full composite index when most rows are `sent`.

### Index vs. trigger trade-offs

- **Composite index on outbox**: 5–10% write overhead, O(log n) drain queries. Always prefer this.
- **Triggers for FTS sync**: Use triggers only for FTS table maintenance (e.g., `spores_fts`), not for outbox status updates. Triggers on outbox status changes risk recursion and complicate transaction semantics.

---

## Cross-Cutting Gotchas

### The three silent failure modes

These produce no logged errors — data is simply missing or stale on remote machines:

| Mode | Symptom | Detection | Fix |
|------|---------|-----------|-----|
| **1. Drain ack swallowed** | Outbox rows stay `pending` across multiple cycles | Check Worker logs; look for 200 with error body | Fix Worker error handling; reset rows to `pending` |
| **2. Tombstone missing** | Deleted entity still visible on remote machine | `SELECT * FROM outbox WHERE entity_id = ? AND operation = 'tombstone'` | Write tombstone row manually; audit code for hard DELETEs |
| **3. machine_id null/local** | Remote machine cannot see rows written on local | `SELECT count(*) FROM spores WHERE machine_id IS NULL OR machine_id = ''` | Backfill correct machine_id; re-queue affected outbox rows |

### D1 lazy migration is silent

D1 does not emit errors at deploy time when schema is stale. Queries against new columns fail silently until the first post-deploy request triggers the ALTER TABLE. Always warm up immediately after deploy.

### Outbox and backfill must share idempotency scope

If write-through and startup backfill use different idempotency keys (or one doesn't use `INSERT OR IGNORE`), you will get duplicate outbox rows that produce duplicate D1 upserts. Upserts are idempotent in D1, but duplicate rows inflate drain cost and complicate debugging.

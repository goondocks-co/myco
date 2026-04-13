---
name: myco:setup-cloudflare-team-sync
description: Use this skill when setting up Myco's team sync feature using Cloudflare Workers, D1, and Vectorize — or when debugging issues with an existing sync deployment. Activates for tasks involving myco team init, the Team page in the daemon UI, Cloudflare Worker deployment, wrangler CLI setup, machine identity, or cross-machine vault sync. Also applies when diagnosing team sync failures even if the user doesn't explicitly frame it as a Cloudflare problem — symptoms like pending count not draining, sync not working, record count shortfall, or embeddings not appearing on another machine all fall under this skill. Also covers the outbox implementation pattern: paired writes, the drain loop, Power Manager integration (runIn states, preventsDeepSleep), dead-letter handling, and adding new record types to team sync.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Set Up and Debug Cloudflare Team Sync

## Prerequisites

- Cloudflare account (free tier covers typical Myco volumes)
- wrangler CLI installed: `npm install -g wrangler`
- Authenticated with Cloudflare: `wrangler login`
- Myco installed and daemon running (`myco start`)
- Node.js ≥18

## Overview

Myco's team sync layer uses three Cloudflare services:

- **D1** — SQLite-compatible database for structured vault records
- **Vectorize** — Vector index for semantic embeddings
- **Workers** — Edge function that receives outbox pushes from all machines

The local `.myco/` vault is always the source of truth. The Cloudflare layer is a queryable mirror. Local writes go through a `team_outbox` table first; the drain loop pushes them to Cloudflare asynchronously.

## Steps

### 1. Initialize team sync infrastructure

```bash
myco team init
```

This provisions a D1 database (via `wrangler d1 create`) and a Vectorize index. Credentials are saved to `.myco/secrets.env`. The command is **idempotent** — if D1 already exists, it detects it via `wrangler d1 list --json`.

### 2. Deploy the Cloudflare Worker

```bash
wrangler deploy
```

Run from the Worker directory in your Myco installation. Verify by checking the Cloudflare dashboard or calling its URL directly.

### 3. Verify secrets

After `myco team init`, `.myco/secrets.env` contains:

```
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
CLOUDFLARE_API_TOKEN=<your-token>
D1_DATABASE_ID=<database-uuid>
VECTORIZE_INDEX_NAME=<index-name>
```

Do **not** copy these into `myco.yaml` — secrets stay in `secrets.env` only.

### 4. Verify machine identity

Each machine has a unique `machine_id` in `.myco/config`. If two machines share the same ID (e.g., after copying a `.myco/` directory), delete `.myco/config` on the new machine to regenerate it.

```bash
myco status   # shows machine_id
```

### 5. Verify sync is working

Open the Team page in the Myco daemon UI. You should see your machine listed, the pending count draining to 0, and record counts accumulating across machines.

## Debugging

### Pending count not draining

The outbox flushes on a timed interval across `active`, `idle`, and `sleep` daemon states. If the count stays elevated:

1. Check the Worker is deployed and accessible (test its URL directly)
2. Check `.myco/secrets.env` has valid, non-expired credentials
3. Check daemon logs for outbox drain errors (filter by `component=team-sync`)
4. Note: the outbox drains during `sleep` (every 5 minutes). It does **not** drain during `deep_sleep` — but the `preventsDeepSleep` predicate keeps the daemon at `sleep` while records are pending, so items should drain before deep sleep is entered

### Dead-lettered records

After 10 failed drain attempts, a record is dead-lettered and excluded from `countPending()`. It no longer blocks deep sleep. Inspect and reset:

```sql
-- Find dead-lettered records
SELECT record_type, record_id, retry_count, last_attempt_at
FROM team_outbox WHERE sent_at IS NULL AND retry_count >= 10;

-- Reset a dead-lettered record to retry (after fixing the root cause)
UPDATE team_outbox
SET retry_count = 0, last_attempt_at = NULL
WHERE id = '<outbox-entry-id>' AND sent_at IS NULL;
```

Dead-letter events emit at error level in logs. The Team UI shows a terracotta "Pending sync" card when `dead_letter_count > 0`, deep-linking to `/logs?component=team-sync`.

### Sync not visible on another machine

1. Confirm both machines share the same `D1_DATABASE_ID` and `VECTORIZE_INDEX_NAME` in `secrets.env`
2. Confirm both use the same Cloudflare account
3. Verify the Worker deployment is current

### Record count shortfall

If fewer records appear on Machine B than were pushed from Machine A, D1 batch writes may be partially failing — check Worker logs in the Cloudflare dashboard. Vectorize insert errors are non-fatal by design; they appear in Worker logs, not daemon logs.

## Common Pitfalls

### wrangler ≥4.77: `d1 create` output format changed

**Symptom:** `myco team init` fails with `Could not parse D1 database ID from wrangler output`.

**Fix:** `myco update`. The updated parser handles both the legacy plain-string and new JSON binding block formats, and falls back to `wrangler d1 list --json`.

**Manual workaround:** Run `wrangler d1 list --json`, find your database entry, manually set `D1_DATABASE_ID=<uuid>` in `.myco/secrets.env`.

### D1 schema migration runs lazily, not at deploy

`initD1Schema()` in the Worker is guarded by a per-instance flag and runs on the **first request** after deploy, not at deploy time. To force initialization: make one manual sync push right after deploying the Worker.

### Secrets in myco.yaml instead of secrets.env

Cloudflare credentials must live in `.myco/secrets.env`, never in `myco.yaml`.

### Machine identity collision

Two machines sharing the same `machine_id` will have colliding sync records in D1. Delete `.myco/config` on the duplicate machine.

### wrangler.toml bindings must match secrets.env names

If `database_name` or `index_name` in `wrangler.toml` differs from `secrets.env`, the Worker binds to a different resource than the daemon is pushing to — producing a silent data split.

## Implementation: The `team_outbox` Table (schema v9)

Located in `src/db/schema.ts`. Key columns:

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT PK | UUID for the outbox entry |
| `record_type` | TEXT | Identifies what kind of record (e.g., `'spore'`, `'session'`) |
| `record_id` | TEXT | FK-style reference to the primary record |
| `payload` | TEXT | JSON snapshot of the record at write time |
| `sent_at` | INTEGER | NULL until successfully pushed; Unix ms on success |
| `retry_count` | INTEGER | Incremented on each failed drain attempt (DEFAULT 0) |
| `last_attempt_at` | INTEGER | Unix ms of most recent drain attempt |

**Dead-letter threshold**: `MAX_OUTBOX_RETRIES = 10`. Records beyond this threshold are excluded from `listPending()` and `countPending()` — they no longer block deep sleep.

Query helpers in `src/db/queries/team-outbox.ts`: `listPending()`, `countPending()`, `markSent(id)`, `incrementRetry(id)`.

## Implementation: Paired Writes

Every new record type added to team sync must write to `team_outbox` in the **same SQLite transaction** as the primary insert. Never write to the outbox outside a transaction.

```typescript
export function insertSpore(db: Database, spore: Spore): void {
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO spores (...) VALUES (...)`).run(spore);
    db.prepare(`
      INSERT INTO team_outbox (id, record_type, record_id, payload, created_at)
      VALUES (?, 'spore', ?, ?, ?)
    `).run(crypto.randomUUID(), spore.id, JSON.stringify(spore), Date.now());
  });
  tx();
}
```

If the transaction rolls back, the outbox entry is also rolled back. The two writes are atomic.

## Implementation: Drain Loop and Power Manager

The drain job is registered in `src/daemon/main.ts` as a `PowerJob`:

```typescript
{
  name: 'team-sync-flush',
  runIn: ['active', 'idle', 'sleep'],  // NOT deep_sleep
  preventsDeepSleep: () => countPending(db) > 0,
  handler: drainOutbox,
}
```

**`runIn` must include `'sleep'`** — this was the original bug; items sat unprocessed until the daemon woke to active. The `sleep` state ticks every 5 minutes, so items drain within 5 minutes of being written.

**`preventsDeepSleep`** holds the daemon at `sleep` when pending records exist. Without this predicate, records written just before deep sleep could sit unsent for hours. Without `MAX_OUTBOX_RETRIES`, a permanently-failing record would hold deep sleep forever.

The drain loop re-hydrates records from primary tables (not the outbox payload, which may be stale). Handle deleted records by calling `markSent()` rather than leaving them to accumulate retries.

## Implementation: Adding a New Record Type

1. **Define the type constant** in `src/config/constants.ts`
2. **Wire the outbox write** — paired insert inside the same transaction as the primary write (see pattern above)
3. **Add a hydration branch** in the drain loop's `hydrateRecord()` for the new type
4. **Handle in the Cloudflare Worker** — add a handler in `src/worker/` that writes to D1 and/or Vectorize; handle each destination independently (D1 and Vectorize are independent failure modes)
5. **Update the Worker's D1 schema** — add the new table to `initD1Schema()` if needed; remember this runs lazily on first request after deploy

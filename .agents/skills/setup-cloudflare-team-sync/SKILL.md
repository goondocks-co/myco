---
name: myco:setup-cloudflare-team-sync
description: >-
  Use this skill when setting up or debugging Myco team sync on Cloudflare.
  It applies to `myco-team install`, the Team page in the daemon UI, Worker
  deployment, Wrangler setup, machine identity, cross-machine vault sync, and
  failure modes like pending outbox drains, missing remote records, or
  embeddings not appearing on another machine. It also covers the outbox
  pattern, paired writes, drain-loop behavior, PowerManager integration, and
  adding new record types to sync.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Set Up and Debug Cloudflare Team Sync

## Prerequisites

- Cloudflare account (free tier covers typical Myco volumes)
- wrangler CLI installed: `npm install -g wrangler`
- Authenticated with Cloudflare: `wrangler login`
- `@goondocks/myco-team` installed globally: `npm install -g @goondocks/myco-team`
- Myco installed and daemon running (starts automatically on session start)
- Node.js ≥22

## Overview

Myco's team sync layer uses three Cloudflare services:

- **D1** — SQLite-compatible database for structured vault records
- **Vectorize** — Vector index for semantic embeddings
- **Workers** — Edge function that receives outbox pushes from all machines

The local `.myco/` vault is always the source of truth. The Cloudflare layer is a queryable mirror. Local writes go through a `team_outbox` table first; the drain loop pushes them to Cloudflare asynchronously.

## Steps

### 1. Initialize team sync infrastructure

One team member runs this once from the project directory. It provisions the D1 database, Vectorize index, KV namespace, generates an API key, and deploys the Cloudflare Worker — all in one command.

```bash
myco-team install
```

The command is **idempotent** — if D1 or Vectorize already exist, it detects and reuses them.

On completion, the command outputs a **Worker URL** and **API key**. Share these with teammates.

### 2. Verify secrets

After `myco-team install`, two secrets are stored in `.myco/secrets.env`:

```
MYCO_TEAM_API_KEY=<hex-api-key>
MYCO_TEAM_MCP_TOKEN=<mcp-bearer-token>
```

The Worker URL and enabled flag are stored in `myco.yaml` under `team:`:

```yaml
team:
  enabled: true
  worker_url: https://myco-team-xxxxxxxx.workers.dev
```

Do **not** move secrets into `myco.yaml` — they stay in `secrets.env` only.

### 3. Verify machine identity

Each machine has a unique `machine_id` stored in `.myco/machine_id`. If two machines share the same ID (e.g., after copying a `.myco/` directory), delete `.myco/machine_id` on the new machine to regenerate it.

```bash
myco stats   # shows machine_id
```

### 4. Connect teammates

Each teammate opens the **Team** page in their Myco dashboard, pastes the Worker URL and API key, and clicks **Connect**. On first connect, all existing local knowledge is backfilled.

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

**Symptom:** `myco-team install` fails with `Could not parse D1 database ID from wrangler output`.

**Fix:** `myco update`. The updated parser handles both the legacy plain-string and new JSON binding block formats, and falls back to `wrangler d1 list --json`.

**Manual workaround:** Run `wrangler d1 list --json`, find your database entry, manually set `D1_DATABASE_ID=<uuid>` in `.myco/secrets.env`.

### D1 schema migration runs lazily, not at deploy

`initD1Schema()` in the Worker is guarded by a per-instance flag and runs on the **first request** after deploy, not at deploy time. To force initialization: make one manual sync push right after deploying the Worker.

### Secrets in myco.yaml instead of secrets.env

Cloudflare credentials must live in `.myco/secrets.env`, never in `myco.yaml`.

### Machine identity collision

Two machines sharing the same `machine_id` will have colliding sync records in D1. Delete `.myco/machine_id` on the duplicate machine to regenerate it.

### wrangler.toml bindings out of sync after manual edits

If `database_name` or `index_name` in `wrangler.toml` was manually edited, the Worker may bind to different resources than expected — producing a silent data split. Use `myco-team upgrade` to re-stage the deployment directory from the canonical source, which patches all bindings correctly.

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

---
name: myco:outbox-sync-drain-pattern
description: Use this skill whenever you need to add, modify, or debug Myco's outbox-based team sync system — the mechanism that replicates local vault data to Cloudflare D1 and Vectorize. Activates for tasks involving the team_outbox table, the drain worker, the preventsDeepSleep predicate, retry/dead-letter logic, adding new record types to team sync, or debugging why records aren't reaching remote machines. Apply this skill even if the user doesn't explicitly say "outbox" or "drain" — any time they're working with cross-machine sync, pending count not dropping, records missing on other machines, dead-lettered sync failures, or asking how a new entity type gets synced, this skill applies.
managed_by: myco
user-invocable: true
allowed-tools:
  - Read
  - Edit
  - Bash
  - mcp__myco-vault__vault_search_fts
---

# Implementing the Myco Outbox-Based Sync and Drain Pattern

## Architecture Overview

```
Local SQLite write
       │
       ▼ (same transaction)
  team_outbox
  (status=pending)
       │
       ▼ (team-sync-flush job — active/idle/sleep states)
  Cloudflare Worker (src/worker/)
       │
       ├──▶ D1 (relational records)
       └──▶ Vectorize (embeddings)
       │
       ▼ (on success)
  team_outbox.sent_at = NOW
```

The outbox is the durability guarantee: a record never leaves the local machine without first being written to `team_outbox` in the same SQLite transaction as the primary write.

---

## The `team_outbox` Table (schema v9)

Located in `src/db/schema.ts`. Key columns:

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT PK | UUID for the outbox entry |
| `record_type` | TEXT | Identifies what kind of record this is (e.g., `'spore'`, `'session'`) |
| `record_id` | TEXT | FK-style reference to the primary record |
| `payload` | TEXT | JSON snapshot of the record at write time |
| `sent_at` | INTEGER | NULL until successfully pushed; Unix ms on success |
| `retry_count` | INTEGER | Incremented on each failed drain attempt (DEFAULT 0) |
| `last_attempt_at` | INTEGER | Unix ms of most recent drain attempt |
| `created_at` | INTEGER | Unix ms of outbox entry creation |

**Dead-letter threshold**: `MAX_OUTBOX_RETRIES = 10`. After 10 failed attempts, the record is excluded from `listPending()` and `countPending()` — it no longer blocks deep sleep and is surfaced in the Team UI instead.

Query helpers live in `src/db/queries/team-outbox.ts`:
- `listPending()` — returns records where `sent_at IS NULL AND retry_count < MAX_OUTBOX_RETRIES`
- `countPending()` — count of same
- `markSent(id)` — sets `sent_at`
- `incrementRetry(id)` — increments `retry_count`, updates `last_attempt_at`

---

## Step 1: Paired Writes (Outbox + Primary in One Transaction)

Every new record type added to team sync must write to `team_outbox` in the same SQLite transaction as the primary insert. Never write to the outbox outside a transaction.

```typescript
// src/db/queries/spores.ts (example pattern)
export function insertSpore(db: Database, spore: Spore): void {
  const tx = db.transaction(() => {
    // 1. Primary write
    db.prepare(`INSERT INTO spores (...) VALUES (...)`).run(spore);

    // 2. Outbox write — same transaction
    db.prepare(`
      INSERT INTO team_outbox (id, record_type, record_id, payload, created_at)
      VALUES (?, 'spore', ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      spore.id,
      JSON.stringify(spore),
      Date.now()
    );
  });
  tx();
}
```

If the transaction rolls back, the outbox entry is also rolled back. The two writes are atomic.

---

## Step 2: The Drain Loop (team-sync-flush job)

The drain job is registered in `src/daemon/main.ts` as a `PowerJob`. It:

1. Calls `listPending()` to fetch all unsent, non-dead-lettered outbox rows
2. Hydrates full records from primary tables (outbox payload may be stale — always re-fetch)
3. Batches records by type and calls the Cloudflare Worker
4. Marks successes via `markSent(id)`
5. Calls `incrementRetry(id)` for any rows that fail

```typescript
// Conceptual drain loop
async function drainOutbox(db: Database): Promise<void> {
  const pending = listPending(db);
  if (pending.length === 0) return;

  for (const row of pending) {
    try {
      // Re-hydrate — outbox payload is a snapshot; re-fetch for freshness
      const record = hydrateRecord(db, row.record_type, row.record_id);
      if (!record) {
        // Record was deleted — mark sent to clear the outbox entry
        markSent(db, row.id);
        continue;
      }

      await pushToWorker(row.record_type, record);
      markSent(db, row.id);
    } catch (err) {
      incrementRetry(db, row.id);
      // Continue draining other records — don't abort the batch
    }
  }
}
```

Handle deleted records explicitly: if the primary record no longer exists, call `markSent()` to prevent the outbox entry from blocking forever.

---

## Step 3: Power Manager Integration

The drain job participates in two power-manager contracts. Both must be correct together.

### 3a. `runIn` — Controls Which States Trigger the Job

Registered in `src/daemon/main.ts`:

```typescript
{
  name: 'team-sync-flush',
  runIn: ['active', 'idle', 'sleep'],  // NOT deep_sleep
  preventsDeepSleep: () => countPending(db) > 0,
  handler: drainOutbox,
}
```

The `sleep` state ticks every 5 minutes. Outbox items written while the daemon is in `sleep` will drain at the next 5-minute tick. **Do not omit `'sleep'` from `runIn`** — this was the original bug; items sat unprocessed until the daemon woke.

### 3b. `preventsDeepSleep` — Holds the Daemon at `sleep` Until Outbox Clears

Evaluated each tick in `src/daemon/power.ts` `evaluateState()`. If any registered job returns `true`, the `deep_sleep` transition is capped at `sleep` and logged.

For team-sync: `() => countPending(db) > 0` — returns `true` only when there are pending non-dead-lettered records.

**Why this matters**: Without this predicate, records written just before the daemon enters `deep_sleep` could sit unsent for hours. With the predicate, the daemon stays at `sleep` (flushing every 5 min) until the outbox is empty.

**Infinite-hold risk**: A record that fails every drain attempt will hold `deep_sleep` forever without a retry ceiling. This is why `MAX_OUTBOX_RETRIES = 10` exists — dead-lettered records are excluded from `countPending()` and do not block sleep.

---

## Step 4: Adding a New Record Type

To sync a new entity type (e.g., `'skill_record'`):

1. **Define the type constant** — add `'skill_record'` to the record type constants in `src/config/constants.ts` or alongside existing type strings.

2. **Wire the outbox write** — in the primary insert function, add the paired outbox insert inside the transaction (see Step 1 pattern above).

3. **Add a hydration branch** — in the drain loop's `hydrateRecord()` function, add a case for the new type that fetches the live record from its primary table.

4. **Handle in the Cloudflare Worker** — in `src/worker/`, add a handler for the new `record_type` that writes to D1 and/or Vectorize as appropriate. D1 and Vectorize are separate failure modes — handle each independently.

5. **Update the Worker's D1 schema** — if the new type needs a D1 table, add it to `initD1Schema()` in the Worker. Remember: this runs lazily on first request after `npx wrangler deploy`, not at deploy time.

---

## Debugging

**Inspect pending outbox state:**
```sql
-- All unsent records
SELECT record_type, record_id, retry_count, created_at
FROM team_outbox
WHERE sent_at IS NULL
ORDER BY created_at;

-- Dead-lettered records (stuck, not blocking sleep)
SELECT record_type, record_id, retry_count, last_attempt_at
FROM team_outbox
WHERE sent_at IS NULL AND retry_count >= 10;

-- Drain rate check
SELECT DATE(created_at/1000, 'unixepoch') as day,
       COUNT(*) as written,
       SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) as drained
FROM team_outbox
GROUP BY day
ORDER BY day DESC;
```

**Check drain logs** — filter by `component=team-sync` in the log viewer to see `team-sync.retry` and `team-sync.dead-letter` events. Dead-letter events emit at error level.

**Team page UI** — the Team page (`ui/src/pages/Team.tsx`) shows a terracotta "Pending sync" card when `dead_letter_count > 0`, with a deep-link to `/logs?component=team-sync`.

**Common failure causes:**
- Worker not deployed after schema change — run `npx wrangler deploy` from `src/worker/`
- D1 schema not updated — `initD1Schema()` runs on first worker request after deploy
- `runIn` missing `'sleep'` — items accumulate until daemon wakes to `active`
- Vectorize and D1 failing independently — check each separately; one can succeed while the other fails

---

## Pitfalls

**Never write to the outbox outside a transaction.** If the outbox insert and primary write are separate, a crash between them leaves the data in an inconsistent state — either the record exists without an outbox entry (silent sync gap) or vice versa.

**Always handle deleted records in the drain loop.** If a record is inserted and then deleted before it drains, `hydrateRecord()` returns null. Mark the outbox row as sent to clear it — do not leave it to accumulate retries.

**D1 and Vectorize are independent failure modes.** A successful D1 push does not imply a successful Vectorize push. Handle each separately and mark the outbox entry sent only when both succeed (or track per-destination status if partial success is acceptable).

**Do not set `preventsDeepSleep` without a dead-letter ceiling.** Any job with `preventsDeepSleep: () => queue.length > 0` and no retry limit will hold the daemon at `sleep` indefinitely on permanent failure.

**The `sleep` state does flush.** Do not treat sleep as equivalent to deep_sleep — `runIn: ['active', 'idle', 'sleep']` means the drain job runs every 5 minutes in sleep mode. Items written in sleep will drain within 5 minutes.

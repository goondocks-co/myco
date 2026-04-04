---
name: myco:setup-cloudflare-team-sync
description: Use this skill when setting up Myco's team sync feature using Cloudflare Workers, D1, and Vectorize — or when debugging issues with an existing sync deployment. Activates for tasks involving myco team init, the Team page in the daemon UI, Cloudflare Worker deployment, wrangler CLI setup, machine identity, or cross-machine vault sync. Also applies when diagnosing team sync failures even if the user doesn't explicitly frame it as a Cloudflare problem — symptoms like pending count not draining, sync not working, record count shortfall, or embeddings not appearing on another machine all fall under this skill.
managed_by: myco
user-invocable: false
allowed-tools:
  - Read
  - Edit
  - Write
  - Bash
  - Grep
  - Glob
---

# Set Up and Debug Cloudflare Team Sync

Myco's team sync replicates vault data (sessions, spores, entities, embeddings) across machines using Cloudflare Workers, D1 (SQL), and Vectorize (embeddings). Each machine writes to a local SQLite `team_outbox` table; the `team-sync-flush` power-manager job drains these records to the Cloudflare Worker on a schedule.

## Prerequisites

- Cloudflare account with D1 and Vectorize enabled
- `wrangler` CLI installed and authenticated (`npx wrangler whoami`)
- Myco daemon installed and running
- `myco team init` command available (via the daemon UI or CLI)

## Setup Steps

### 1. Initialize Team Sync Config

```bash
myco team init
```

This writes the `team` block to `myco.yaml` and creates the local `team_outbox` table in the SQLite vault.

### 2. Create Cloudflare Resources

Create a D1 database:
```bash
npx wrangler d1 create myco-sync
```

Create a Vectorize index (dimensions must match your embedding model — 1024 for `bge-m3`):
```bash
npx wrangler vectorize create myco-embeddings --dimensions=1024 --metric=cosine
```

Copy the resource IDs from each command's output into `myco.yaml` under the `team` block.

### 3. Set a Unique Machine Identity

Each machine must have a unique `machine_id`. Set it in `myco.yaml`:

```yaml
team:
  machine_id: "my-machine-name"
```

> **Important:** The default `machine_id` is `"local"`. If left as `"local"`, records from different machines will collide during deduplication. Always set a descriptive, unique value before your first sync.

### 4. Configure wrangler.toml

Create `src/worker/wrangler.toml` with your D1 and Vectorize bindings:

```toml
[[d1_databases]]
binding = "DB"
database_name = "myco-sync"
database_id = "<your-d1-id>"

[[vectorize]]
binding = "VECTORIZE"
index_name = "myco-embeddings"
```

### 5. Deploy the Worker

**Always deploy from the `src/worker/` subdirectory**, not the project root:

```bash
cd src/worker
npx wrangler deploy
```

> **Critical — D1 lazy migration:** `initD1Schema()` runs on the **first incoming request** after deployment, not at build time or dry-run time. Running `wrangler deploy --dry-run` or building locally does **not** migrate D1. You must run a real `npx wrangler deploy` from `src/worker/` for schema changes to apply, and they only take effect when the first request hits the worker.

### 6. Verify Deployment

After deploying, trigger a test flush from the daemon UI (Team page → Sync Now) or wait for the next scheduled flush. Watch the worker logs:

```bash
npx wrangler tail
```

Confirm you see a schema-init log on the first request, then successful record inserts.

## Debugging

### Pending Count Not Draining

If `team_outbox` records accumulate but the pending count never drops, work through these checks in order:

---

**Check 1 — `runIn` configuration (most common cause)**

The `team-sync-flush` power-manager job must be scheduled in **both** `runIn: ['active', 'sleep']`. If `'sleep'` is absent, the flush job won't run when the machine transitions into sleep or deep_sleep states — the queue stalls until the machine returns to active.

Correct PowerJob definition:
```typescript
{
  id: 'team-sync-flush',
  runIn: ['active', 'sleep'],     // ← 'sleep' is required
  preventsDeepSleep: () => {
    return listPending().length > 0;  // excludes dead-lettered records
  },
  // ...
}
```

The `preventsDeepSleep` predicate keeps the machine in sleep (rather than dropping to deep_sleep) until the queue empties. It calls `listPending()`, which excludes dead-lettered records (see Check 2).

---

**Check 2 — Dead-lettered records**

As of schema v9, `team_outbox` tracks retry history:
- `retry_count INTEGER DEFAULT 0` — incremented on each failed flush attempt
- `last_attempt_at INTEGER` — Unix timestamp of most recent attempt

After **10 consecutive failures**, a record is **dead-lettered**: it is permanently excluded from `listPending()` to prevent the system from holding in sleep indefinitely over unrecoverable records.

Symptoms: pending count drops to zero, but records are still stuck and never reached the remote.

Check for dead-letter records:
```sql
SELECT id, retry_count, last_attempt_at FROM team_outbox WHERE retry_count >= 10;
```

If you see rows here, investigate the root cause of the sync failures (network, auth, worker error) before manually clearing or retrying. The **Team page** in the daemon UI shows a terracotta **"Pending sync"** card with a count when `dead_letter_count > 0`; this card deep-links to the log viewer for diagnosis.

---

**Check 3 — Worker authentication**

Use `npx wrangler tail` to confirm the worker is receiving requests and returning 2xx. Auth failures will show as 401/403 responses.

---

**Check 4 — Machine ID is not `"local"`**

Records written with `machine_id="local"` may dedup incorrectly on the remote. Confirm `myco.yaml` has a unique, non-default `machine_id`.

---

### Sync Working But Records Missing on Another Machine

**Vectorize propagation delay** — Vectorize index updates can take 5–30 seconds to propagate globally. Wait and retry before assuming a bug.

**Record count shortfall** — Compare local outbox flush count vs. remote record count. A gap suggests dead-letter records (see Check 2 above).

**Schema mismatch after redeploy** — If the worker was recently redeployed with schema changes, the new schema only applied on the first post-deploy request. Make a test request if you haven't yet, then re-examine.

### Embeddings Not Appearing on Another Machine

1. Check Vectorize index stats: `npx wrangler vectorize get myco-embeddings`
2. Confirm the `VECTORIZE` binding in `wrangler.toml` matches the index name
3. Verify the index dimensions match the embedding model (1024 for `bge-m3`)
4. Wait 30 seconds — Vectorize is eventually consistent

## Common Pitfalls

1. **D1 lazy migration** — `initD1Schema()` runs on the first request after `wrangler deploy`, not at build/dry-run time. Schema changes don't apply until a real deploy is followed by a real request. Always deploy from `src/worker/`.

2. **`runIn` missing `'sleep'`** — `team-sync-flush` must include `'sleep'` in its `runIn` array. Without it the flush job is skipped during sleep and deep_sleep, stalling the outbox.

3. **Dead-letter ceiling at 10 retries** — Records that fail 10 times are permanently excluded from `listPending()`. The pending count drops to zero but the records are unsynced. Watch for the terracotta "Pending sync" card on the Team page.

4. **`machine_id` defaults to `"local"`** — Set a unique machine identity before first sync. The default value breaks cross-machine deduplication.

5. **Wrong deploy directory** — `wrangler deploy` must be run from `src/worker/`. Running from the project root targets the wrong config and may deploy an incomplete bundle.

6. **Vectorize eventual consistency** — Allow 5–30 seconds after a successful flush before checking whether embeddings appear on another machine.

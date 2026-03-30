---
name: myco:setup-cloudflare-team-sync
description: Use this skill when setting up Myco's team sync via Cloudflare Workers, D1, and Vectorize — or debugging sync failures. Covers wrangler setup, machine identity, D1 schema, Vectorize bindings, silent failure modes, and the machine_id regression diagnosis pattern.
managed_by: myco
user-invocable: true
allowed-tools:
  - vault_state
  - vault_set_state
  - vault_search_fts
  - vault_search_semantic
  - vault_spores
  - vault_report
---

# Set Up and Debug Cloudflare Team Sync

Myco's team sync uses a Cloudflare Worker backed by D1 (relational) and Vectorize (embeddings) to synchronize vault data across machines. The sync pipeline runs locally via wrangler CLI and is managed through the Team page in the Daemon UI.

## When to Activate

- Running `myco team init` for the first time
- Deploying or redeploying the team-worker to Cloudflare
- Diagnosing sync failures: "pending count not draining," "record count shortfall," "embeddings not appearing on another machine"
- Investigating `machine_id='local'` appearing in D1 records
- Any work in `.myco/.team-worker/` or `src/team/`
- Debugging CWD-related wrangler failures

## Prerequisites

- Cloudflare account with Workers, D1, and Vectorize access
- `wrangler` CLI installed and authenticated (`wrangler login`)
- Myco daemon configured with team sync enabled in `myco.yaml`
- `CLOUDFLARE_API_TOKEN` and related secrets in `.myco/secrets.env` (not in `myco.yaml`)

## Initial Setup

### 1. Create D1 and Vectorize resources

```bash
wrangler d1 create myco-team-db
wrangler vectorize create myco-embeddings --dimensions 1024 --metric cosine
```

Record the IDs produced — you'll need them in `wrangler.toml`.

### 2. Configure `wrangler.toml`

Set D1 and Vectorize bindings in `.myco/.team-worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "myco-team-db"
database_id = "<your-d1-id>"

[[vectorize]]
binding = "VECTORIZE"
index_name = "myco-embeddings"
```

### 3. Run schema migration

```bash
(cd .myco/.team-worker && wrangler d1 execute myco-team-db --file=schema.sql)
```

**Always use subshell syntax** `(cd ... && wrangler ...)` to avoid mutating the shell CWD (see Common Pitfalls).

### 4. Deploy the Worker

```bash
(cd .myco/.team-worker && wrangler deploy)
```

### 5. Verify from the Team page

Open the Team page in the Daemon UI. The sync status panel should show the worker URL, last sync time, and outbox depth. Trigger a manual sync to validate the pipeline end-to-end.

## Machine Identity

Every session and prompt batch is tagged with a `machine_id` that identifies the originating machine. Machine identity is resolved at daemon startup via `getMachineId(vaultDir)` and `initTeamContext()`.

**The machine_id MUST propagate to all write call sites.** See the diagnosis section below for what happens when it doesn't.

## Diagnosing Record Count Shortfalls

If the record count on D1 is lower than the local vault count, work through this checklist:

1. **Check `machine_id` values in D1:**
   ```sql
   SELECT machine_id, COUNT(*) FROM sessions GROUP BY machine_id;
   ```
   If you see `machine_id='local'`, the daemon was writing records with the default value instead of the resolved machine identity — proceed to the machine_id regression diagnosis below.

2. **Check the outbox depth:** Pending records accumulate in the local `team-outbox` table. If the outbox is growing but not draining, verify the Worker is reachable and the sync task is running.

3. **Check for deletion tombstone gaps:** Records deleted locally without creating a tombstone are never signaled for remote deletion. D1 retains them silently.

4. **Check wrangler CWD:** If the sync commands ran with a mutated CWD (see below), some operations may have silently skipped.

## machine_id='local' Regression Diagnosis

### Root cause

Three daemon INSERT call sites historically omitted `machine_id`:
- `upsertSession` on session register (`main.ts:777`)
- `upsertSession` on auto-register from events (`main.ts:833`)
- `insertBatchStateless` on prompt capture (`main.ts:193`)

The daemon resolves machine identity correctly at startup (`getMachineId(vaultDir)` / `initTeamContext()` at lines 464/474), but never threaded the value to these write functions. SQLite silently used `DEFAULT_MACHINE_ID = 'local'` for every INSERT — no error, no warning.

### Why it's invisible

Any field with a DB-level `DEFAULT` produces a silent wrong write when omitted, not an error. The bug is undetectable in logs unless the stored value is explicitly inspected.

### Migration window trap

Running the v7 schema migration while the daemon is live only fixes historical rows. The still-running daemon process continues executing old code that omits `machine_id` — every new session and batch created between migration start and daemon restart receives `'local'` again. After migration, you must restart the daemon before the fix takes effect for new rows.

**If you hit this:** Run a manual backfill for any rows created in the migration window:
```sql
UPDATE sessions SET machine_id = '<correct-id>' WHERE machine_id = 'local' AND created_at > <migration_timestamp>;
-- Repeat for prompt_batches, skills, outbox entries, etc.
```
Then re-enqueue the affected rows for D1 sync.

### The fix

`getTeamMachineId()` is now the default fallback in all INSERT paths across query modules. Even if a caller forgets to pass `machine_id`, the correct resolved identity is used. The `StatelessBatchInsert` interface was extended with a `machine_id` field. 26 targeted smoke tests verify the fix including `insertBatchStateless machine_id threading`.

### Pattern to watch

Any daemon startup value resolved once and stored in a closure must be audited across all write call sites that include that field. The same silent-default pattern can recur for any new field added to session or batch write paths. `getTeamMachineId()` as call-site default makes omission safe — but new fields with `DEFAULT` values require the same audit.

## Common Pitfalls

### Wrangler CWD drift stops hook execution

Running `cd .myco/.team-worker && wrangler ...` in a non-subshell leaves the CWD in `.myco/.team-worker/`. Any subsequent hook or script that uses project-relative paths will silently fail or operate on the wrong directory. This was observed as empty `skill_candidates` on D1 and an 8-record shortfall in `skill_records` (32 local vs. 24 cloud).

**Fix:** Always use subshell syntax: `(cd .myco/.team-worker && wrangler ...)`. The parentheses create a subshell — CWD is never mutated in the parent shell.

### D1 and local records diverge after deletion

Deletions must go through the outbox/tombstone pathway to propagate to D1. Records deleted locally without creating a tombstone are never signaled for remote deletion — D1 silently retains stale rows. Always use the Myco deletion API rather than raw SQL DELETE to ensure tombstones are created.

### Sync appears to work but embeddings are missing on remote machines

Vectorize embeddings are enqueued separately from D1 records. Check the embedding outbox depth and confirm the Vectorize binding is correctly configured in `wrangler.toml`. A misconfigured binding causes silent write failures on the Cloudflare side with no local error.

### Secrets in `myco.yaml`

API tokens and sync credentials must be in `.myco/secrets.env`, never in `myco.yaml`. The yaml file is version-controlled; secrets.env is gitignored. If team sync credentials end up in git history, rotate them immediately.

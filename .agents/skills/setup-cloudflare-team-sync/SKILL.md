---
name: myco:setup-cloudflare-team-sync
description: Use this skill when setting up Myco's team sync feature using Cloudflare Workers, D1, and Vectorize — or when debugging issues with an existing sync deployment. Activates for tasks involving myco team init, the Team page in the daemon UI, Cloudflare Worker deployment, wrangler CLI setup, machine identity, or cross-machine vault sync. Also applies when diagnosing team sync failures even if the user doesn't explicitly frame it as a Cloudflare problem — symptoms like pending count not draining, sync not working, record count shortfall, or embeddings not appearing on another machine all fall under this skill.
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

The local `.myco/` vault is always the source of truth. The Cloudflare layer is a queryable mirror.

## Steps

### 1. Initialize team sync infrastructure

```bash
myco team init
```

This provisions:
- A D1 database (via `wrangler d1 create`)
- A Vectorize index (via `wrangler vectorize create`)

Credentials are saved automatically to `.myco/secrets.env`. The command is **idempotent**: if the D1 database already exists, it detects it via `wrangler d1 list --json` rather than failing on a duplicate create.

### 2. Deploy the Cloudflare Worker

```bash
wrangler deploy
```

Run this from the Worker directory in your Myco installation. Verify the worker is live by checking the Cloudflare dashboard or calling its URL directly.

### 3. Verify secrets

After `myco team init`, `.myco/secrets.env` will contain:

```
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
CLOUDFLARE_API_TOKEN=<your-token>
D1_DATABASE_ID=<database-uuid>
VECTORIZE_INDEX_NAME=<index-name>
```

These are read automatically by the daemon. Do **not** copy these into `myco.yaml` — secrets stay in `secrets.env`, never in YAML config.

### 4. Verify machine identity

Each machine has a unique `machine_id` auto-generated and stored in `.myco/config`. This is the key that distinguishes records from different machines in the shared D1 store.

```bash
myco status
```

Look for `machine_id` in the output. If two machines share the same ID (e.g., after copying a `.myco/` directory), delete `.myco/config` on the new machine to regenerate it.

### 5. Verify sync is working

Open the Team page in the Myco daemon UI. You should see:
- Your machine listed with a sync status
- Pending count draining to 0 after the outbox flush interval
- Record counts accumulating across machines

## Debugging

### Pending count not draining

The outbox flushes on a timed interval. If the count stays elevated:

1. Check the Worker is deployed and accessible (test its URL directly)
2. Check `.myco/secrets.env` has valid, non-expired credentials
3. Check daemon logs for outbox drain errors
4. Note: the outbox does **not** drain during `sleep` or `deep_sleep` daemon states — records accumulate and drain on next wake

### Sync not visible on another machine

1. Confirm both machines share the same `D1_DATABASE_ID` and `VECTORIZE_INDEX_NAME` in `secrets.env`
2. Confirm both machines use the same Cloudflare account
3. Verify the Worker deployment is current

### Record count shortfall

If fewer records appear on Machine B than were pushed from Machine A:
- D1 batch writes may be partially failing — check Worker logs in the Cloudflare dashboard
- Vectorize insert errors are non-fatal by design; they appear in Worker logs, not daemon logs

## Common Pitfalls

### wrangler ≥4.77: `d1 create` output format changed (breaks `myco team init`)

**Symptom:** `myco team init` fails with `Could not parse D1 database ID from wrangler output`.

**Cause:** wrangler ≥4.77 changed `wrangler d1 create` output from a plain string:

```
Created database with id: <uuid>
```

to a JSON binding block:

```json
{
  "d1_databases": [
    { "binding": "DB", "database_name": "myco-vault", "database_id": "<uuid>" }
  ]
}
```

The original Myco parser expected the plain-string format and cannot parse the JSON block.

**Fix:** Update Myco to the latest version (`myco update`). The updated parser handles both output formats and falls back to `wrangler d1 list --json` to detect already-created databases, making `myco team init` fully idempotent.

**Manual workaround (if you cannot update):** Run `wrangler d1 list --json`, find your database entry, and manually set `D1_DATABASE_ID=<uuid>` in `.myco/secrets.env`.

### D1 schema migration runs lazily, not at deploy

**Cause:** `initD1Schema` in the Worker is guarded by a per-instance `schemaInitialized` flag. It runs on the **first request** the Worker handles, not at deploy time.

**Impact:** If an automated health check or probe hits the Worker before any real sync push, it may arrive before the D1 tables exist, causing a schema error on that first call.

**Fix:** This is expected behavior. The first real sync push after deploy triggers schema creation; a retry immediately succeeds. To force initialization: make one manual sync push right after deploying the Worker.

### Secrets in myco.yaml instead of secrets.env

Cloudflare credentials (`CLOUDFLARE_API_TOKEN`, `D1_DATABASE_ID`, etc.) must live in `.myco/secrets.env`. Placing them in `myco.yaml` risks accidental git commits and puts them in a location the daemon does not read for secrets.

### Machine identity collision

If two machines share the same `machine_id` (copied `.myco/config`), their sync records will collide in D1. Delete `.myco/config` on the duplicate machine — a new unique ID is generated on next daemon start.

### wrangler.toml bindings must match secrets.env names

The Worker's `wrangler.toml` declares D1 and Vectorize bindings by name. If `database_name` or `index_name` in `wrangler.toml` differs from what's in `secrets.env`, the Worker will bind to a different resource than the daemon is pushing to, producing a silent data split.

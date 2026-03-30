---
name: myco:setup-cloudflare-team-sync
description: |
  Use this skill when setting up Myco's team sync feature using Cloudflare Workers, D1, and Vectorize — or when debugging issues with an existing sync deployment. Activates for tasks involving `myco team init`, the Team page in the daemon UI, Cloudflare Worker deployment, wrangler CLI setup, machine identity, or cross-machine vault sync. Also applies when diagnosing team sync failures even if the user doesn't explicitly frame it as a Cloudflare problem — symptoms like "pending count not draining," "sync not working," or "embeddings not appearing on another machine" all fall under this skill.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Set Up and Debug Cloudflare Team Sync

Myco's team sync replicates vault spores and embeddings across machines using a Cloudflare Worker as a lightweight relay. The Worker owns a D1 database (structured records) and a Vectorize index (embeddings). Each machine pushes its outbox to the Worker; teammates pull by querying the Worker. This skill covers initial provisioning, per-machine connection, and common failure patterns.

## Architecture Overview

```
Machine A (.myco/db.sqlite)          Machine B
  team_outbox table                    team_outbox table
       │  push                              ▲ pull
       ▼                                   │
  Cloudflare Worker ── D1 (records) ── Vectorize (embeddings)
```

Key design decisions:
- **Push-only outbox**: each machine appends to `team_outbox`; the agent drains it on each run. The Worker is the source of truth for cross-machine state.
- **`machine_id` dedup**: records are keyed by `machine_id` (a stable UUID per installation in `.myco/machine.json`), not by DB row ID (which is local). Fan-out search always filters `machine_id != localMachineId` to avoid treating your own records as teammate records.
- **Protocol versioned**: the Worker endpoint includes a version path (e.g., `/v1/push`). Breaking changes bump the version.
- **Embeddings via Workers AI**: the Worker uses `@cf/baai/bge-m3` via Cloudflare's OpenAI-compatible endpoint — same dimensionality as the local Ollama default, so embeddings are cross-machine comparable.

## Prerequisites

1. A Cloudflare account (free tier is sufficient for most teams)
2. `wrangler` CLI installed and authenticated: `wrangler login`
3. Myco v0.12.10+ installed in the project with `.myco/` initialized
4. Node.js ≥18 (wrangler dependency)

## Two-Phase Setup (Critical Distinction)

Team sync has **two completely separate operations** that are easy to confuse:

| Operation | Who runs it | When | Where |
|-----------|-------------|------|-------|
| **Provision** | Workspace owner, once | First time only | `myco team init` (CLI) |
| **Connect** | Each teammate | Per machine | Team page in daemon UI |

`myco team init` deploys the Cloudflare Worker and creates the D1 + Vectorize resources. It only needs to run **once**. Every subsequent machine uses the Team page to connect with the Worker URL and shared secret — they do **not** run `myco team init` again.

## Step 1: Provision the Worker (Owner Only)

```bash
# Authenticate with Cloudflare first
wrangler login

# From the project root
myco team init
```

This command:
1. Deploys `.myco/.team-worker/` to Cloudflare Workers
2. Creates a D1 database and Vectorize index, binds them to the Worker
3. Stores the Worker URL and credentials in `.myco/secrets.env` (never in `myco.yaml`)

**Gotcha — `.gitignore`:** `.myco/.team-worker/` must be in your vault's `.gitignore`. Projects initialized before v0.12.10 may be missing this entry. Check `.myco/.gitignore` and add it manually if absent:

```
.team-worker/
```

**Gotcha — wrangler ≥4.77 JSON output:** Older wrangler versions returned plain IDs for resource creation; wrangler ≥4.77 returns a JSON binding block. Myco v0.12.10+ handles this with JSON parsing + an idempotency fallback. If you see a parse error during `myco team init`, ensure you're on Myco v0.12.10+.

**Gotcha — Vectorize index deletion:** If you need to tear down and re-provision, the Cloudflare dashboard does **not** expose Vectorize index deletion. You must use the CLI:

```bash
wrangler vectorize delete <index-name>
```

## Step 2: Connect a Machine (Every Teammate)

Each machine connects via the Team page in the daemon UI — not the CLI. The owner shares:
- `MYCO_TEAM_WORKER_URL` (from `.myco/secrets.env`)
- `MYCO_TEAM_SECRET`

The connecting machine enters these in the Team page form. This writes values to `.myco/secrets.env` locally and does not touch `myco.yaml`.

## Step 3: Verify Sync is Working

After connecting, the daemon begins draining the outbox. The first sync from a machine with existing history may push ~1,000–1,500 records and takes several drain cycles (~200 records/cycle) to complete.

**Where to check progress:**
- **Team page** in the daemon UI → shows the pending outbox count. This is the authoritative progress indicator.
- Daemon logs do **not** show per-record sync progress by design — if you're watching logs expecting verbose output, you won't see it there.

A healthy sync: pending count starts high, drops by ~200 each agent run, reaches 0.

## Debugging Common Failures

### Pending count never decreases
- Verify the daemon is running: `myco status`
- Confirm `MYCO_TEAM_WORKER_URL` and `MYCO_TEAM_SECRET` are set in `.myco/secrets.env`
- Test the Worker directly: `curl https://<your-worker>.workers.dev/v1/health`

### projectHash collision — sync writing to wrong vault
This was a v0.12.10 bug: `projectHash` was derived from `process.cwd()` instead of the vault directory path. If the daemon was started from different working directories, hashes collided and records from one project contaminated another. **Fix (already in v0.12.10):** hash is derived from the vault dir path. If you see cross-project contamination, upgrade Myco.

### Vectorize error code 3002 not caught
Earlier Worker versions caught Vectorize errors by matching message strings; error 3002 (index not ready) used a different format and fell through as an unhandled exception. **Fix (v0.12.10):** error detection now checks `error.code` numerically. If you see uncaught Vectorize errors in Worker logs, redeploy the Worker:

```bash
# From .myco/.team-worker/
wrangler deploy
```

### Worker fails to locate its source at startup
`locateWorkerSource()` previously searched `src/worker` first, which only exists in the dev checkout. In installed environments the compiled output is at `dist/src/worker`. **Fix (v0.12.10):** loader tries `dist/src/worker` first via `resolvePackageRoot()`, then falls back. If you're running from source and the Worker fails to start, check `src/team/worker-locator.ts` for the path resolution logic.

### Fan-out search returns your own records as "teammate" records
The fan-out query must include `AND machine_id != ?` (bound to the local machine UUID from `.myco/machine.json`). If your own spores appear attributed to a teammate, this filter is missing or the wrong value is bound. The machine_id is a UUID — not a hostname or display name.

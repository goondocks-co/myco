---
name: myco:myco-team-operator-cli
description: |
  Use this when running myco-team operator commands (create, update, status,
  rotate-tokens, export, import, adopt, reindex-vectors, destroy) to provision,
  back up, recover, or tear down a team's Cloudflare Worker + D1 sync
  infrastructure — even if the user only asks to "set up team sync" or
  "I lost my team config." Covers the machine-scoped command surface (create
  replaced the legacy grove-scoped install), the export/import/adopt recovery
  trio needed because the Cloudflare Worker API key is permanently write-only
  once set via wrangler secret put, and the CLOUDFLARE_ACCOUNT_ID / --account-id
  disambiguation required when wrangler runs non-interactively under multiple
  Cloudflare accounts. Activates for any work touching packages/myco-team's
  CLI, wrangler secret/account selection, or team credential recovery.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# myco-team Operator CLI: Provisioning, Key Recovery & Account Disambiguation

The `myco-team` package provides a machine-scoped CLI for provisioning a
Cloudflare Worker + D1 team-sync backend (`packages/myco-team/src/main.ts`
dispatches commands into `packages/myco-team/src/cli.ts`). It addresses teams
by `--team-id` consistently (not a legacy per-project install scope), and
exposes a backup/recovery trio because one critical secret — the Worker API
key — cannot be read back from Cloudflare once it's set. Use this skill
whenever creating, updating, backing up, recovering, or destroying a team's
sync infrastructure.

## Prerequisites

- `wrangler` CLI authenticated (`wrangler login`).
- Know how many Cloudflare accounts the logged-in user has access to
  (`wrangler whoami` lists them). If more than one, set
  `CLOUDFLARE_ACCOUNT_ID` (or pass `--account-id <id>`, valid on every
  command) before running anything that spawns wrangler non-interactively —
  `create`, `rotate-tokens`, `adopt` all call `wrangler secret put`.
- The `wrangler secret put` call inside `create` (and again inside
  `rotate-tokens`/`adopt` regeneration) is the point of no return for key
  recovery — read the Recovery Trio procedure below before running `create`
  for the first time on a team.

## Command Surface

The CLI was modernized from a grove-scoped design to a fully machine-scoped
one — `create` replaced the legacy `install [project_dir]` entry point and
its `requireGroveInstallScope` call. If you see `install` or
`requireGroveInstallScope` referenced in older docs or code comments, treat
them as stale.

Run `myco-team --help` (or read the usage banner at the top of
`packages/myco-team/src/main.ts`) for the authoritative, current flag list.
As of this writing:

| Command | Flags | Purpose |
|---|---|---|
| `create` | `[--name "<team name>"] [--domain <zone>] [--observability]` | Provision a new team (D1 + Vectorize + KV + Worker). |
| `update` / `upgrade` | `--team-id <id> [--reindex-vectors] [--observability] [--json]` | Apply config/version changes to an existing team. `update` is an alias for `upgrade`. |
| `status` | `--team-id <id>` | Report current team config and masked credentials. |
| `rotate-tokens` | `[api\|mcp\|all] --team-id <id>` | Rotate the Worker API key and/or MCP token (default `all`). |
| `export` | `--team-id <id> [--out <dir-or-file>]` | Write a portable backup bundle (team config + secrets) to disk. |
| `import` | `<bundle-file>` | Restore a team purely from a previously exported bundle — no Cloudflare calls. |
| `adopt` | `--worker-url <url> [--api-key <key>] [--worker-name <name>]` | Reconstruct local state from a *live* worker when the bundle/local state is gone. |
| `reindex-vectors` | `--team-id <id>` | Rebuild the vector index. |
| `destroy` | `--team-id <id>` | Full teardown of Worker + D1 + KV for a team. |

Every command except `create`/`import`/`adopt` addresses its team via
`--team-id`; `import` and `adopt` instead identify the team from the bundle
file or the live worker, respectively, since the whole point is that local
state (including the team id) may be missing.

## Procedure A: Provisioning a New Team (`create`)

1. Confirm the Cloudflare account to target. If the authenticated user has
   multiple CF accounts, `wrangler` cannot prompt interactively when spawned
   by the operator CLI — it will fail before creating any resources (see
   Cross-Cutting Gotchas). Set the account first:
   ```bash
   export CLOUDFLARE_ACCOUNT_ID=<target-account-id>
   # or, per-invocation: myco-team create --account-id <target-account-id> --name <team-name>
   ```
2. Run `myco-team create --name "<team name>"`. This provisions D1,
   Vectorize, and a KV namespace, deploys the Worker, then writes the API
   key as a Worker secret via `wrangler secret put` (`packages/myco-team/src/cli.ts`,
   inside `teamCreate`).
3. **Immediately run `export`** (see Procedure B). The export bundle is the
   only durable record of the API key outside the running Worker — there is
   no way to retrieve it from Cloudflare later, including as the account
   owner.
4. Verify with `myco-team status --team-id <id>`.

## Procedure B: Backup and Recovery (`export` / `import` / `adopt`)

This trio exists because of a hard asymmetry in what Cloudflare exposes:

- **Recoverable** — team identity (`team_id`, `team_name`, `created_at`,
  embedding model) lives in D1's `team_config` table
  (`packages/myco-team/worker/src/schema.ts`) and is readable via
  authenticated Worker routes — `POST /connect` and `GET /config`
  (`packages/myco-team/worker/src/index.ts`). Worker URL and account
  metadata are always visible from the CF dashboard.
- **Not recoverable** — the Worker API key. It's a write-only secret;
  Cloudflare never returns it through any API, to anyone.

Treat `export` as a Terraform-style backup step, not an optional extra. The
three commands map to three distinct recovery scenarios — pick by what you
still have, not by habit:

**1. Backing up (always, after `create` or an `api`/`all` `rotate-tokens`):**
```bash
myco-team export --team-id <team-id> --out ./team-backup.json
```
This is a pure local read — no Cloudflare calls. Store the resulting file
somewhere durable and access-controlled: it contains the Team API key and
MCP token in plaintext and is written with `0600` permissions.

**2. You have a previously exported bundle file (most common recovery path):**
```bash
myco-team import ./team-backup.json
```
`import` is a **pure local operation — no Cloudflare calls at all**. It
parses the bundle, writes the team record, deployment metadata, and secrets
(API key, MCP token) into the local machine-scoped registry, and preserves
the original Team key unchanged. Safe to re-run; re-importing overwrites the
local registry entry.

**3. No bundle, but you still hold the API key and know the worker URL:**
```bash
myco-team adopt --worker-url https://<worker-subdomain>.workers.dev --api-key <key>
```
This calls `POST /connect` against the live Worker with the supplied key to
read back `team_id`/`team_name`/`created_at` from `team_config`, then
reconstructs the local team record, deployment metadata, and secrets. The
key itself is **not** changed. If you omit `--worker-name`, the worker name
is derived from the workers.dev URL's subdomain (or, for a custom domain,
falls back to the deterministic resource name derived from the team id —
pass `--worker-name` explicitly in that case).

**4. No bundle and no key, but you control the Cloudflare account:**
```bash
myco-team adopt --worker-url https://<worker-subdomain>.workers.dev
```
Omitting `--api-key` makes `adopt` regenerate the Team key via Cloudflare
account authority (`wrangler secret put`, overwriting the old secret), then
proceed exactly like scenario 3 with the new key. **This revokes every
existing key holder** — teammates with the old key must re-register. Note
`adopt` checks the local registry for an already-stored key matching that
worker URL before falling back to regeneration, so it won't unnecessarily
invalidate a key you already have on this machine.

There is no backdoor recovery path: authority to adopt requires either
holding the key or controlling the Cloudflare account — every
identity-bearing Worker route sits behind authenticated middleware. The
public health-check route is safe to leave open — it only exposes node
count and a token *hash*, never the key or token itself.

If both the bundle and the key are gone and you don't control the CF
account, there is no recovery — only a fresh `create` once the orphaned
Worker/D1 are destroyed by someone who does.

## Procedure C: Maintenance (`update`/`upgrade`, `rotate-tokens`, `reindex-vectors`)

- `update`/`upgrade --team-id <id>` — apply config or version changes to an
  existing team registration. `update` is a direct alias for `upgrade` in
  `packages/myco-team/src/main.ts`. Pass `--reindex-vectors` to also rebuild
  the vector index in the same call, or `--json` for a machine-readable
  `{ success, worker_url?, version?, error? }` result.
- `rotate-tokens [api|mcp|all] --team-id <id>` — rotate the Worker API key
  and/or MCP token independently (default `all`). Rotating `api` calls
  `wrangler secret put` with a freshly generated key and updates the local
  registry automatically — but **run `export` again immediately after**,
  since the previous export bundle now holds a key the Worker has already
  rejected, and the new key is exactly as unrecoverable as the old one was.
- `reindex-vectors --team-id <id>` — rebuild the vector index when
  embeddings drift or the embedding model changes; does not touch
  credentials.

## Procedure D: Teardown (`destroy`)

```bash
myco-team destroy --team-id <team-id>
```
Tears down the Worker, D1, and KV namespace for a team. Before destroying,
confirm no teammates still need the current export bundle: once the Worker
and D1 are gone, even a valid key can't recover team identity, since the
`team_config` table backing `/connect` and `GET /config` no longer exists.
If you intend to re-provision under the same name afterward, a fresh
`create` is required — `adopt` only works while the Worker still exists to
call `/connect` against.

`teamDestroy` (`packages/myco-team/src/cli.ts`) detaches the sync-queue and
DLQ consumer bindings from the Worker *before* deleting the Worker itself —
Cloudflare refuses to delete a Worker that's still a queue consumer (code
10064) and refuses to delete a queue still bound to a Worker (code 11005), a
mutual reference that breaks a naive delete-everything ordering. Every
teardown step also tolerates an already-absent resource via
`isAlreadyAbsentError()` (matches phrases like "not found", "does not exist",
Vectorize's already-deleted-index message, "no queue"/"no consumer", and the
specific CF codes 10007/10003/3005), so re-running `destroy` after a partial
failure converges instead of erroring on resources it already removed.

## Cross-Cutting Gotchas

**Cloudflare Worker API key is permanently write-only.** Once set via
`wrangler secret put`, no API — not even one available to the CF account
owner — will return it. This is why `export` must run after every `create`
and every `api`/`all` `rotate-tokens`, not just once at initial setup. If
you lose both the local state and the export bundle, your only paths
forward are `adopt` without `--api-key` (if you still control the CF
account) or a fresh `create` (after the orphaned Worker/D1 are destroyed,
or via `destroy` if you still have access).

**Multi-account wrangler used to leak partial resources — now guarded in `create`.**
Before a fix, a multi-account Cloudflare login made `create` provision D1,
Vectorize, and KV into an arbitrary account and only fail later at the final
`wrangler secret put` step — leaving orphaned resources behind. `create` now
calls `resolveCloudflareAccount()` (`packages/myco-deploy/src/cloudflare.ts`,
which parses `wrangler whoami`'s account table via `parseWranglerAccounts()`)
**before any resource is created**: on a TTY it shows an interactive picker;
non-interactively (>=2 accounts, no `CLOUDFLARE_ACCOUNT_ID` set) it throws
immediately, listing the available accounts, e.g.:
```
More than one Cloudflare account is available and none was selected.
Pass --account-id <id> (or set CLOUDFLARE_ACCOUNT_ID). Available accounts:
  Chris Kirby: b134c2135129c4800082e677fbffb286
  Collagen Advocacy Network: 1f776044f26a8bbc73dc418bfafd4e0f
```
This preflight is wired into `create` only — `rotate-tokens` and `adopt`'s
key-regeneration path still call `wrangler secret put` directly with no
account preflight, so ambiguity there surfaces as a `wrangler secret put`
failure (no new-resource leak risk, since those paths rotate a secret rather
than provision). Set `CLOUDFLARE_ACCOUNT_ID` in the environment, or pass
`--account-id <id>` (accepted on every command per
`packages/myco-team/src/main.ts`), before invoking any of `create`,
`rotate-tokens`, or `adopt` if there's any chance the account is ambiguous:
```bash
CLOUDFLARE_ACCOUNT_ID=b134c2135129c4800082e677fbffb286 myco-team create --name my-team
```

**`import` and `adopt` are not interchangeable.** `import` only ever reads a
local bundle file and makes zero network calls; `adopt` only ever talks to a
live Worker and makes zero use of an exported file. Picking the wrong one
for the recovery scenario you're actually in (bundle present vs. bundle
lost) is the most common mistake — see Procedure B's four numbered
scenarios above.

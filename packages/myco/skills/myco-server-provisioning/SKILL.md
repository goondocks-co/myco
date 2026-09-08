---
name: myco-server-provisioning
description: >-
  Provision, update, roll back and destroy the Cloudflare Deployment — the Worker front
  door — with `myco server <verb> --target cloudflare`. One verb, from artifacts the
  binary carries: no source checkout on the machine that deploys, and no container
  runtime anywhere.
when_to_use: >-
  Use for any Cloudflare provisioning or deploy work, for D1 migration ordering against
  a live Deployment, for the free-tier surface rule, when changing the Worker bundle the
  binary carries, and when debugging a wrangler failure during a deploy. Also read it
  before adding any binding to `wrangler.toml`.
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
user-invocable: true
---

# Cloudflare Deployment lifecycle

The Cloudflare Deployment is one of two front doors. It is storage, MCP, ingest and a scheduler; it runs no harness. Provisioning is **one verb from artifacts the binary carries** — there is no source checkout on the machine that deploys, and no container runtime anywhere.

## The operator contract

Node and wrangler are a prerequisite **on the operator's own machine, for these verbs only**. Never on a member host, never on a worker host, never inside the Deployment.

```bash
npm install -g wrangler && wrangler login
myco server create --target cloudflare --account-id <id> [--url https://myco.example.com]
myco server status   --target cloudflare
myco server update   --target cloudflare
myco server rollback --target cloudflare [--version <id>]
myco server destroy  --target cloudflare --yes
```

`create` is idempotent: every resource is ensured, an existing record keeps its ids, and a re-run converges. That also makes it the adopt path for resources created by hand. `destroy` removes the Worker only — the database, bucket, store and record all stand, because the Worker is re-creatable from the binary and the data is not.

`--account-id` is required rather than defaulted. A login reaching several accounts and a command that picks one silently is how resources land in the wrong account, and a half-provisioned account is worse than a refused command. `wrangler whoami` lists them.

`--dir` and `--no-drain` are refused **by name**. Neither applies: there is no checkout to point at, and a deploy replaces no runtime so it waits for nothing.

## What a deploy is made of

A deploy runs entirely out of `~/.myco/server/cloudflare/deploy/`, which the binary writes and resets on every run:

| Staged | From |
|---|---|
| `worker/worker.js` | `BUNDLED_WORKER`, built by wrangler from `packages/myco-server/src` |
| `ui/dist/**` | `BUNDLED_SERVER_UI`, the Deployment dashboard |
| `migrations/*.sql` | `renderMigrationFiles()`, rendered from `SCHEMA_STEPS` |
| `wrangler.deploy.toml` | `renderDeployConfig(record)` |

`packages/myco/src/server/cloudflare-stage.ts` is the single writer of that directory. Do not add a second one, and do not hand a deploy a path an operator typed.

**The entry sits alone under `worker/` and the config sets `find_additional_modules = false`.** Both. `no_bundle = true` turns that option on by default and `base_dir` defaults to the entry's directory, so an entry beside the dashboard and the migrations carries both into the Worker script as modules — measured at 31 extra modules and 65 KiB. Either measure alone would prevent it; keeping both means the regression needs two independent mistakes.

## Changing the Worker

Any change under `packages/myco-server/src/` changes the bundle. It is **generated, not committed**: `codegen` builds it, and `prelint`/`pretest` build it so a fresh clone has it before the typechecker reads it. Regeneration is skipped when every input is older than the module, so those hooks are free on an unchanged tree.

The generated module records the wrangler version that built it, and that is compared to the lockfile before the staleness check — a bundler bump fails on the next command rather than the next command that happens to rebuild. Run `npm ci` if it fires.

To build it by hand: `npx tsx packages/myco/scripts/gen-worker-bundle.ts`. It builds against the committed configuration minus its `[assets]` table, because assets upload beside the script rather than into it and wrangler refuses to run at all when the directory that table names is absent.

## The free-tier rule

The Deployment is meant to run on the Workers free plan. **Containers are a paid surface** (`Free: N/A` in Cloudflare's pricing), which is why the harness container was removed and why the free tier became reachable. Durable Objects are on the free plan only with the **SQLite** backend, which is what `new_sqlite_classes` gives.

Before adding any table to `wrangler.toml`, add it to `FREE_TIER_SURFACES` (`packages/myco/src/server/deploy-config.ts`). The gate holds in both directions over the committed base and the rendered config, so an unlisted surface fails by name rather than at an operator's first bill, and a retired one cannot sit in the list granting silent permission to a future one.

## Durable Object class lifecycle

The `migrations` array is an **ordered ledger, appended to** — never edited in place. Retiring a class means removing its binding and its code, then appending a delete entry while leaving the entry that created it:

```toml
[[migrations]]
tag = "v3-harness-retired"
deleted_classes = [ "HarnessContainer" ]
```

Three things to know before you run one:

- **It is one-way and it destroys the namespace's stored data.** Rehearse against a throwaway Worker name that first carried the class, not against a fresh one — a delete on a namespace that never existed proves nothing.
- **The class must be absent from the code**, or the deploy is refused.
- The parity harness drops any migration naming a class the Worker no longer exports, because a local boot resolves every named class against the code it runs (`parityDrops`, `deploy-config.ts`).

Cloudflare's newer declarative `exports` field is mutually exclusive with `migrations`. Moving across is a separate change with its own risk; do not mix them.

## Order, and what it protects

Migrations apply **before** the deploy, always. The schema window is fail-closed forward: a Worker running against a database it is ahead of refuses rather than half-applying.

The deployment record at `~/.myco/server/cloudflare/record.json` is written **before** the first deploy, so a failure mid-create leaves a record naming what already exists. It holds no credentials — the account id and resource names are not secrets, and the token that reaches them lives in the operator's own wrangler login.

Secrets travel on **stdin, never argv**: the wrapping key into the Secrets Store, `SESSION_SECRET` onto the live Worker after the first deploy. Never `WRANGLER_LOG=debug` while installing one; it prints the request.

## Debugging a failed deploy

- **`Docker build exited with code: 1`** — a `[[containers]]` table is back in the configuration. It should not be; containers are gone and are a paid surface.
- **`The entry-point file ... was not found`** — a config outside the package. Wrangler resolves `main` relative to the config file's own directory.
- **`assets.directory ... does not exist`** — building the bundle against the committed config instead of the stripped one.
- **A deploy that carries 30-odd extra modules** — `find_additional_modules` is on, or something joined the entry's directory.
- **Nothing dispatches** — expected until a worker attaches. The Worker runs no harness; `myco server status` reports the runtime capability as absent, and every dispatch is refused by name until then.

## What this Deployment does not do

It runs no harness and starts no container. Task execution belongs to workers that attach from wherever harnesses are logged in. A change that gives the Worker a runtime is a change of architecture, not a configuration edit — take it to the plan first.

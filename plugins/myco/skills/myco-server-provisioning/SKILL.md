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

## Guided owner setup

Lead with `myco setup` for a new owner. On a fresh machine, choose **Start a new Myco**, then Cloudflare. To choose explicitly:

```bash
myco setup --create cloudflare
```

Node and Wrangler are prerequisites on the operator's machine. Setup asks for the Cloudflare account and address before creating resources, guides GitHub sign-in registration, prints a private owner link and waits for linking before signing this machine in. Choose the address before registering sign-in.

Rerun `myco setup` after interruption; it continues from observed state. Existing machine connections can select a joining journey, so use `--create cloudflare` explicitly when creating is intended. Use `myco setup --status` for read-only progress, with `--check-remote` for remote checks.

After sign-in, follow **Get started** on **Today** for the next action. Creating a server does not enroll a runner. A runner is an explicit choice on a machine with a supported coding agent signed in; see [Runners](https://myco.sh/runners). Automatic work also needs **Work on a schedule** enabled in **Settings**.

For a 1.4 machine, follow **myco-setup** or [Moving from Myco 1.4](https://myco.sh/upgrade#upgrading-from-myco-14). Guided setup previews the move and asks for approval. The manual reference is `myco cutover --dry-run`, then `myco cutover`; keep its backups and `restore.md`. `myco cutover --dismiss-earlier-copies` only acknowledges earlier copies locally after review; it deletes no history and contacts no Deployment.

To leave a wrong Deployment, use `myco logout <address>`. It preserves capture and runner registrations and updates each agent separately. A partial logout names any agent configuration it could not update; fix the named files and rerun the same command, even after local membership has been removed. With an unreachable server, `myco logout <address> --local-only` removes local connections without revoking the remote credential.

## Manual operator reference

Node and Wrangler are needed here, not on machines merely capturing sessions or running tasks. Server commands select the sole existing Deployment, or local on a fresh home. If both Deployments exist, or an old Compose installation is retained, name the supported target explicitly.

```bash
npm install -g wrangler
wrangler login
wrangler whoami
myco server create --target cloudflare --account-id <id> [--url https://myco.example.com]
myco server github-app --target cloudflare --url <chosen-address>
myco server setup-owner --target cloudflare
myco server status --target cloudflare
myco server update --target cloudflare
myco server rollback --target cloudflare [--version <id>]
myco server destroy --target cloudflare --yes
```

Use the printed workers.dev address or a custom domain in the same Cloudflare account. Complete GitHub app registration, then open the private, expiring owner link from `setup-owner`, sign in and choose **Connect this account**. Repeating owner setup replaces a pending link; an already connected account is preserved and setup refuses. Hosted owner setup uses the operator's Cloudflare login while the Deployment keeps serving.

Sign this machine in with `myco setup --join <address>`, then follow the dashboard checklist. Invite teammates through **People & machines** → **Invite a teammate**; **Connect GitHub** gives them dashboard sign-in.

`create` is idempotent: every resource is ensured, an existing record keeps its ids, and a re-run converges. That also makes it the adopt path for resources created by hand. `destroy` removes the Worker only — the database, bucket, store and record all stand, because the Worker is re-creatable from the binary and the data is not.

Every verb checks those prerequisites before it runs anything: wrangler resolvable without a fetch (`npx --no-install`), and a Cloudflare identity — an interactive `wrangler login`, or `CLOUDFLARE_API_TOKEN` in a shell that cannot open a browser, which is taken on trust rather than verified, so a stale or wrong-scope token fails in the first command's own words. Each missing one is refused by name in one line, so the first thing an operator reads is Myco's instruction rather than wrangler's.

Creating resources requires `--account-id`; subsequent commands can use the recorded account. A login reaching several accounts must not silently choose where new resources go. `wrangler whoami` lists the accounts.

`--dir` and `--no-drain` are refused **by name**. Neither applies: there is no checkout to point at, and a deploy replaces no runtime so it waits for nothing.

## What a deploy is made of

A deploy runs entirely out of `~/.myco/server/cloudflare/deploy/`, which the binary writes and resets on every run:

| Staged | From |
|---|---|
| `worker/worker.js` | `BUNDLED_WORKER`, built by wrangler from `packages/myco-server/src` |
| `ui/dist/**` | `BUNDLED_SERVER_UI`, the Deployment dashboard |
| `migrations/*.sql` | `renderMigrationFiles()`, rendered from `SCHEMA_STEPS` |
| `wrangler.deploy.toml` | `renderDeployConfig(record, recordPath)` |

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

Before advancing an existing database's schema, create and update obtain a current D1 Time Travel bookmark and save it with the before/after schema versions, timestamp and prior Worker version in `~/.myco/server/cloudflare/record.json` under `schemaUpdates`. A missing or invalid bookmark refuses the operation before remote mutation. Fresh provisioning into a verified empty database is exempt; a resumed create uses the existing-database gate. Code-only updates need no bookmark. Recovery records admitted bookmarks in `recovery.json` until publication.

A failed migration command is settled against the live schema through the same probe as status. The target version confirms application, records completion and permits the Worker deploy; the update names the provider error and confirmation. The starting version means failed with nothing applied. Any other version, including an intermediate migration, or a failed probe keeps the outcome unknown and stops before the Worker. Read the reported version and `myco server status --target cloudflare` before choosing a retry or recovery.

`myco server rollback --target cloudflare` rolls back code only. For a schema rollback, use the exact database restore command printed by the update within Time Travel retention, then return to the compatible Worker version with `myco server rollback --target cloudflare --version <worker-version-before-update>`. Database restore discards later writes and does not restore R2 objects. Keep its output and undo bookmark.

Use `myco server backup --target cloudflare --to <dir>` for a full verified database-and-blob recovery artifact. Keep the credentials it names separately. Restore into fresh resources under a fresh `MYCO_HOME` with `myco server restore --target cloudflare --from <dir> --secrets-from <file> --account-id <id> --source-retired --yes` only when the source is retired; use `--fork` instead if it remains serving. See [backup and recovery](https://myco.sh/self-hosting#back-up-and-restore).

The deployment record at `~/.myco/server/cloudflare/record.json` is written **before** the first deploy, so a failure mid-create leaves a record naming what already exists. It holds no credentials — the account id and resource names are not secrets, and the token that reaches them lives in the operator's own wrangler login.

Secrets travel on **stdin, never argv**: the wrapping key into the Secrets Store, `SESSION_SECRET` onto the live Worker after the first deploy. Never `WRANGLER_LOG=debug` while installing one; it prints the request.

## Debugging a failed deploy

- **`Docker build exited with code: 1`** — a `[[containers]]` table is back in the configuration. It should not be; containers are gone and are a paid surface.
- **`The entry-point file ... was not found`** — a config outside the package. Wrangler resolves `main` relative to the config file's own directory.
- **`assets.directory ... does not exist`** — building the bundle against the committed config instead of the stripped one.
- **A deploy that carries 30-odd extra modules** — `find_additional_modules` is on, or something joined the entry's directory.
- **Work stays queued** — check `myco server status --target cloudflare` and **Runners**. The Deployment runs no harness; queued work waits for a registered runner with a usable agent sign-in and model profile. A concurrency limit also queues work; a daily ceiling holds off another start until a later wake.

## What this Deployment does not do

It runs no harness and starts no container. Task execution belongs to registered runners using coding agents signed in on their machines. Runners update themselves between runs. A change that gives the Worker a runtime is a change of architecture, not a configuration edit — take it to the plan first.

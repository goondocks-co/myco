# Parity harness (#1042)

Every feature child in the #905 realignment closes only when its scenario here
is green on **both** targets: the self-hosted Bun server (in-process via
`entry/bun.ts serve()`) and the Cloudflare Worker (real workerd via
`wrangler dev` with local D1/R2). Failures name the target in the describe
label.

Run: `npm run test:parity` (the default `npm test` reaches the entry and
skips — the gate is `MYCO_PARITY=1`).

## Adding a scenario

Write `scenarios/<feature>.ts` exporting a `ParityScenario` (`harness.ts`);
`parity.test.ts` runs every scenario a file there exports, so there is no list
to edit. Give it a weight under `parity` in `scripts/test-durations.json`. A
scenario receives a `ParityTarget`; a paired scenario receives two separately
booted targets. Create state the way a client does, over HTTP
(`/events` with `memberHeaders()`, `/mcp`, `/api/*` with `ownerHeaders()`),
and read store state back through `target.sql('SELECT …')` — every value a
scenario interpolates into SQL goes through `lit()` from `harness.ts`. A row
that must be older than a time-to-live is aged with `ageRows()` from
`harness.ts`, never written directly. Of the worker, a scenario imports only
`constants`, `hash` and `auth/owner/cookie`; a limit a scenario is about moves
to `constants.ts`. `npm run check:test-additions` refuses, in the statements a
change adds, other worker imports and a `target.sql` call whose first string
argument writes (INSERT, UPDATE, DELETE, REPLACE INTO). It reads only the
statement's own text: a write held in a variable, a helper or an alias passes
it, so review still checks for those.

## Target notes

- The derived Cloudflare config strips `global_fetch_strictly_public` (a
  scenario's loopback provider stub must be reachable) and drops `[assets]`
  (a fresh worktree has no ui/dist; every scenario route is worker-owned).
  Neither affects the routes scenarios exercise.
- `SECRET_WRAP_KEY` on the Worker is a secrets-store binding (`.get()`), so a
  scenario needing a stored provider credential cannot supply it via `--var`;
  use the openai-compatible/base_url path (no credential) or extend the
  target with a stub binding first.
- Every non-health Cloudflare request must carry `cf-connecting-ip` (wrangler
  dev injects none; without a source identity the pipeline answers 503).
  `memberHeaders()`/`ownerHeaders()` already do.

## Dedicated scenarios

A scenario whose bindings or settings would change what the others observe
sets `dedicated` and runs against targets booted for it alone. On Cloudflare it
may name another Worker `main`.

`dedicated.latestSchemaUpgrade` boots a Deployment whose users wrote through
its routes (`upgrade-seed/`): sessions, a published transcript, an attachment,
a tombstone, spores recalled into a prompt, plans, Deployment, Project and
machine settings, a device-signed machine's harness report and uncaptured
repository, a runner with its catalog and a claimed run, and a backup. Its rows
are carried (`schema-carry.ts`) into a store built from the steps the newest
`myco/v*` release tag shipped, and every later step upgrades it: Wrangler's own
apply on Cloudflare, the self-hosted migrator (`migrateOnly`) natively, then
budget completion on both. The carry names no table, so a step that adds a
table, a column or a constraint needs no change to these files.

What it proves is limited to the tables the seed fills and the fields
`upgrade-seed/` reads back (`observe`). Two rules keep that honest, and the
carry enforces both:

- A step that changes a table the seed leaves empty (its definition, an
  index, a trigger, or its rows) refuses the boot, naming the step and the
  table, unless a step since the release retires that table. Seed it through
  its route in `upgrade-seed/`.
- The carry builds the release's rows from the latest writers, so a column
  only the release holds is filled with defaults. That is accepted when a step
  since the release declares the column in its `retires`; an undeclared one
  refuses the boot and says to declare it, with its reason. A row the latest
  writers wrote that the release's schema refuses (a value a step since the
  release renames or adds) is left behind with what references it, and named
  in the boot log; on a table no step since the release changes, it fails the
  boot, since the carry or the seed is then wrong.

What this scenario does not exercise: a step that narrows a CHECK, NOT NULL or
UNIQUE over values release-era writers produced, and a step that moves data out
of a column before dropping it. The carried rows come from the latest writers,
which never produce the values such a step meets. Each keeps its own unit test,
seeded at the release's shape beside the step, as
`storage-schema-upgrade.test.ts`, `harness-report-schema-upgrade.test.ts` and
`record-scheme.test.ts` do.

The two-Deployment isolation scenario boots two independent front doors on
each runtime. It asserts distinct database, blob and secret bindings, sweeps
the current HTTP route and MCP operation registries in both directions with
valid foreign authority, and compares exact application-table rows and local
blob-store bytes before and after. It also transplants each Deployment's sealed
secret row into the other store and checks unreadability under the other key,
then restores both rows. Native Bun writes and queries vectors in both physical SQLite
files. Local workerd/D1 has no local Vectorize runtime binding, so the
Cloudflare scenario checks generated Vectorize binding selection separately
without claiming a Vectorize read/write proof.

The recall gold set (`scenarios/recall-gold.ts`, #1154) is the one today. It:
- configures a self-hosted embedding provider and adds `AI` and `VECTORIZE`
  stand-ins to the Worker (`recall/worker-entry.ts`), which would otherwise
  break the `provider_unavailable` assertions in `recall` and `search`;
- holds each target's served blocks to
  `packages/myco-server/src/evals/recall-baseline.ts`.

After an intended change to what prompts are served, record the baseline again
with `MYCO_EVAL_RECORD=1 npm run test:parity`. Recording regenerates only the
baseline, and the KPI page's Recall quality reads it.

Recording compares against the previous record first, and prints every case as
regressed, improved, or changed at the same score. It refuses to write
regressions unless `MYCO_EVAL_ACCEPT_REGRESSIONS=1` accepts them. Each case's
pass and graded score sit in the baseline, so the PR diff shows them too.

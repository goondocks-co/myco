# Parity harness (#1042)

Every feature child in the #905 realignment closes only when its scenario here
is green on **both** targets: the self-hosted Bun server (in-process via
`entry/bun.ts serve()`) and the Cloudflare Worker (real workerd via
`wrangler dev` with local D1/R2). Failures name the target in the describe
label.

Run: `npm run test:parity` (the default `npm test` reaches the entry and
skips — the gate is `MYCO_PARITY=1`).

## Adding a scenario

Write `scenarios/<feature>.ts` exporting a `ParityScenario` (`harness.ts`),
add it to the `scenarios` list in `parity.test.ts`. A scenario receives a
`ParityTarget`; a paired scenario receives two separately booted targets.
Drive the three surfaces over HTTP
(`/events` with `memberHeaders()`, `/mcp`, `/api/*` with `ownerHeaders()`)
and seed or assert store state through `target.sql` — every value a scenario
interpolates into SQL goes through `lit()` from `harness.ts`.

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

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
`ParityTarget` and nothing else: drive the three surfaces over HTTP
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

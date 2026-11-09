The CI workflow has two scopes, and the `check` job is the one required result of both.

**Every pull request and main push:** lint and types, the native build, 18 Node test shards, two DOM test shards,
a parity smoke (`scripts/ci-scopes.mjs`), a small UI smoke, a Windows smoke, hook startup checks and container checks.
Darwin release-recipe build and verification jobs run when build or release inputs change.

**The full run** (nightly on main through `.github/workflows/nightly.yml`, a `full-ci` pull request label, or a release
tag through `publish.yml`) adds the full Windows contract list, all seven parity shards, every dashboard screen, and
the scale and cost suites listed in `scripts/ci-scopes.mjs`.

A nightly failure opens or updates the one issue titled "Nightly full CI is failing" with the failed jobs and commit.
A release tag runs the full suite on its own commit and cannot publish unless it passes.

Timing limits (per-test timeout headroom, shard and job budgets, hook startup and work budgets) report as warnings on
pull requests and main pushes, and fail only a full run from `nightly.yml` or a release. A test over its own timeout
still fails everywhere.

The `check` job requires every job that belongs to the scope to succeed, including every matrix entry.
Superseded pull request runs are cancelled; pushes to main are not cancelled.

Each Node shard owns whole phases from `scripts/run-bun-tests.mjs`. Shared-process
groups, isolated chunks, and solo files retain their isolation boundaries. DOM
files retain Bun's per-file isolation. Each parity shard boots its own self-hosted
and Cloudflare targets and runs its selected scenarios against both.

Run a shard locally:

```sh
MYCO_TEST_KIND=node MYCO_TEST_SHARD=1/18 npm test
MYCO_TEST_KIND=dom MYCO_TEST_SHARD=1/2 npm test
MYCO_PARITY_SHARD=1/7 npm run test:parity
```

To repeat one whole group, use the workflow's shard assignment and the label
printed by `MYCO_RUNNER_DRY_RUN=1 npm test`. `MYCO_TEST_GROUP` filters after shard
assignment; an unknown label or a group assigned elsewhere is an error.

```sh
MYCO_TEST_KIND=node MYCO_TEST_SHARD=2/18 \
  MYCO_TEST_GROUP='node env shared tests-myco-server-3' \
  MYCO_RUNNER_GROUP_BUDGET_MS=3600000 npm test -- --rerun-each 20
```

The larger group budget covers the repeated work. Each test keeps its normal
timeout, and every sibling file in the selected group still runs.

Without those variables, the commands run their full suites. Do not run multiple
shards in the same checkout concurrently: the runner owns shared bundle/report
directories and swaps the Bun configuration for DOM tests. CI uses separate
runners and checkouts.

`node scripts/check-test-shards.mjs` audits the workflow's actual matrix against
test discovery and the full parity catalogue. Every test file and scenario must
appear exactly once, and the aggregate gate must depend on every job. Run this
audit without other tests running in the checkout.

`scripts/test-durations.json` stores approximate milliseconds measured from the
linked GitHub runs. Only files taking at least one second are listed; other files
use a small default weight. Weights affect placement, never test inclusion.
New files and scenarios enter the shards automatically. Refresh slow-file and
scenario weights from CI logs when jobs become unbalanced. Test jobs publish
phase durations in their summaries and upload JUnit reports and logs.

Aim for PR feedback within five minutes. Compare completed workflow elapsed time,
including runner queues and the aggregate gate, rather than summing parallel job
durations. Splitting jobs adds setup work and may increase billed runner minutes.

macOS distribution builds verify the staged executable against its release
checksum manifest. Tagged releases require this gate
before GitHub publication; see [macOS release signing](macos-release-signing.md).

Every main push and PRs changing build or release inputs also cross-compile
darwin-arm64 on Linux, then sign it on macos-15 through the release's shared
signing script and verify the staged raw binaries in execute mode.
The selector covers workflows, actions, scripts, package manifests and lockfiles,
and `.bun-version`; other PRs retain the native Darwin verification. The aggregate
allows the two release-recipe jobs to skip only when the selector says they are
not required. darwin-x64 remains signature-only in the release gate because the
runner's Rosetta cannot execute the Bun x64 build. Ad hoc signing with preserved
metadata is validated on an arm64 Mac against the Linux-built x64 release asset;
native x64 execution and the hosted workflow remain validation limits.

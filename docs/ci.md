# Pull request checks

The CI workflow runs lint, the native build, eight Node test shards, two DOM test
shards, three parity shards, container checks, and Windows contracts independently.
The `check` job requires every job to succeed, including every matrix entry.
Superseded pull request runs are cancelled; pushes to main are not cancelled.

Each Node shard owns whole phases from `scripts/run-bun-tests.mjs`. Shared-process
groups, isolated chunks, and solo files retain their isolation boundaries. DOM
files retain Bun's per-file isolation. Each parity shard boots its own self-hosted
and Cloudflare targets and runs its selected scenarios against both.

Run a shard locally:

```sh
MYCO_TEST_KIND=node MYCO_TEST_SHARD=1/8 npm test
MYCO_TEST_KIND=dom MYCO_TEST_SHARD=1/2 npm test
MYCO_PARITY_SHARD=1/3 npm run test:parity
```

To repeat one whole group, use the workflow's shard assignment and the label
printed by `MYCO_RUNNER_DRY_RUN=1 npm test`. `MYCO_TEST_GROUP` filters after shard
assignment; an unknown label or a group assigned elsewhere is an error.

```sh
MYCO_TEST_KIND=node MYCO_TEST_SHARD=2/5 \
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

macOS distribution builds also verify the staged executable and the binary
inside the packed npm platform package. Tagged releases require this gate
before GitHub or npm publication; see [macOS release signing](development/macos-release-signing.md).

Every main push and PRs changing build or release inputs also cross-compile
darwin-arm64 on Linux, then sign it on macos-14 through the release's shared
signing script and verify the staged and npm-packed binaries in execute mode.
The selector covers workflows, actions, scripts, package manifests and lockfiles,
and `.bun-version`; other PRs retain the native Darwin verification. The aggregate
allows the two release-recipe jobs to skip only when the selector says they are
not required. darwin-x64 remains signature-only in the release gate because the
runner's Rosetta cannot execute the Bun x64 build. Ad hoc signing with preserved
metadata is validated on an arm64 Mac against the Linux-built x64 release asset;
native x64 execution and the hosted workflow remain validation limits.

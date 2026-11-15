The CI workflow has two scopes, and the `check` job is the one required result of both.

**Every pull request and main push:** lint and types, the native build, 17 Node test shards, two DOM test shards,
a parity smoke (`scripts/ci-scopes.mjs`), a small UI smoke, a Windows smoke, hook startup checks and container checks.
Darwin release-recipe build and verification jobs run when build or release inputs change. The build job also runs
`npm run check:test-budget`. That fails a change whose pull request plan is over the node runner budget in
`scripts/check-test-budget.mjs`, or whose test-to-product line ratio rises while the ratio is above 1.0. Each plan
file is charged at the larger of its declared weight and its recorded CI time, and a file with no recorded time is
charged at least the floor beside that budget. The ratio counts non-blank, non-comment lines. Make room for
the runner budget by deleting or demoting tests, and for the ratio by deleting test code. Never raise the budget.

**The full run** (nightly on main through `.github/workflows/nightly.yml`, a `full-ci` pull request label, or a release
tag through `publish.yml`) adds the full Windows contract list, all seven parity shards, every dashboard screen, and
the heavy and scale suites listed in `scripts/ci-scopes.mjs`: nested `bun test` or binary processes, whole setup
journeys, SIGKILL and resume, recovery and restore, D1 scale and cost, and native lifecycle suites that spawn a
server. A pull request keeps one fast critical-flow test for each of those areas. Parity beyond the smoke runs only
in the full run.

A nightly failure opens or updates the one issue titled "Nightly full CI is failing" with the failed jobs and commit.
A release tag runs the full suite on its own commit and cannot publish unless it passes.

Shard, job, hook-startup and hook-work budgets report as warnings on pull requests and main pushes, and fail only a
full run from `nightly.yml` or a release. Those shard and job budgets are what may fail a run whose tests passed,
because they keep a job inside its time limit. The per-test 80% timeout near-miss is listed in the step summary on pull
requests, main pushes and tagged releases, and fails only the nightly. A near-miss is reported, not failed. A test over
its own timeout, or a failed assertion, still fails everywhere. A test file that fails only with a Miniflare proxy or
devalue internal assertion, `TypeError: Unable to connect`, or D1 `Network connection lost` is rerun once, alone, and
that rerun is the result. The step summary names the file and the signature. Any other failure is not retried.

The `check` job requires every job that belongs to the scope to succeed, including every matrix entry.
Superseded pull request runs are cancelled; pushes to main are not cancelled.

Each Node shard owns whole phases from `scripts/run-bun-tests.mjs`. Shared-process
groups, isolated chunks, and solo files retain their isolation boundaries. DOM
files retain Bun's per-file isolation. Each parity shard boots its own self-hosted
and Cloudflare targets and runs its selected scenarios against both.

Run a shard locally:

```sh
MYCO_TEST_KIND=node MYCO_TEST_SHARD=1/17 npm test
MYCO_TEST_KIND=dom MYCO_TEST_SHARD=1/2 npm test
MYCO_PARITY_SHARD=1/7 npm run test:parity
```

To repeat one whole group, use the workflow's shard assignment and the label
printed by `MYCO_RUNNER_DRY_RUN=1 npm test`. `MYCO_TEST_GROUP` filters after shard
assignment; an unknown label or a group assigned elsewhere is an error.

```sh
MYCO_TEST_KIND=node MYCO_TEST_SHARD=2/17 \
  MYCO_TEST_GROUP='node env shared tests-myco-server-3' \
  MYCO_RUNNER_GROUP_BUDGET_MS=3600000 npm test -- --rerun-each 20
```

The larger group budget covers the repeated work. Each test keeps its normal
timeout, and every sibling file in the selected group still runs.

Without those variables, the commands run their full suites. Each run writes its
bundles under its own temp root; shards run at once in one checkout need a
`MYCO_RUNNER_REPORT_DIR` each, so a finished shard never prunes another's reports.

`MYCO_TEST_SELECTION_FILE` names a file listing test files, one per line: the run
plans only those files, with the full run's groups, isolation and duration
weights, so `MYCO_TEST_SHARD` splits them as CI would. It takes no test targets.

## Before pushing: `npm run check:pr`

`check:pr` runs what pull request CI most often fails on, locally:

- the dependency, migration, test-addition, budget and server gates;
- the changed tests, every test that imports a changed file (heavy suites
  included), PR-scope `tests/meta`, and the tests of any consumer row below, as
  one selection split into parallel shards (`--jobs N`, default half the CPUs up
  to 8; `--skip-importers` leaves the importing tests out and says so on the final
  line). A file that fails beside the other shards runs once more on its own and
  fails the check only if it fails again; one that passes alone is named as
  load-sensitive;
- the build job's dashboard bundle and every generator `npm run build` runs, in a
  scratch copy, failing with the command whose output is not committed;
- the type checks, the shard audit, and the consumer rows in
  `scripts/check-pr-plan.mjs`: checks that read a change without importing it
  (installer tests, the self-hosted image's build inputs, the compiled sign-in,
  routing and hook-startup checks, parity smoke on the self-hosted target, the
  dashboard screens, the docs site), each naming the CI job it stands in for.
  Rows that cannot run on the machine (Windows, the Darwin release recipe, the
  Cloudflare parity target, screens without an installed Chromium) are named on
  the final line with the reason.

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

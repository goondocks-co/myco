// What a pull request runs and what only the full run does. A pull request sets MYCO_TEST_SCOPE=pr; the full run
// (nightly, the full-ci label, a release tag) sets MYCO_TEST_SCOPE=full and runs everything. A file is listed here
// only to move it to the full run: scripts/check-test-shards.mjs proves each one is still covered by the full plan.

/** Scale and cost suites: what they prove is how a read or a write grows with data, not what it answers. */
export const NIGHTLY_ONLY_FILES = [
  'tests/myco-server/budget-read-bound.test.ts',
  'tests/myco-server/canopy-capture-cost.test.ts',
  'tests/myco-server/embedding-bounded-cost.test.ts',
  'tests/myco-server/embedding-read-budget.test.ts',
  'tests/myco-server/embedding-running-cost.test.ts',
  'tests/myco-server/events-read-budget-runtime.test.ts',
  'tests/myco-server/extraction-coverage-budget.test.ts',
  'tests/myco-server/injection-snapshot-budget-runtime.test.ts',
  'tests/myco-server/legacy-history-budget.test.ts',
  'tests/myco-server/raw-proof-cost.test.ts',
  'tests/myco-server/remaining-read-cost.test.ts',
  'tests/myco-server/response-owner-cost.test.ts',
  'tests/myco-server/session-long.test.ts',
  'tests/server/cloudflare-backup-streaming.test.ts',
];

/** Files that need the binary the build job compiles: the build job runs them, so test shards need no build first. */
export const BUILD_JOB_FILES = [
  'tests/member/rbac-routing-smoke.test.ts',
];

/** The parity a pull request runs: the capture and read spine on every store, then both populated schema upgrades. */
export const PARITY_SMOKE_SCENARIOS = [
  'session turns: capture keyed to prompts, turns read, turn body, tool calls on their own, rail summaries and filters',
  'schema upgrade: a Deployment populated by its users upgrades from the previous schema with every record, refusal and write unchanged',
  'budget: populated schema upgrade keeps activation and its refusal visible',
];

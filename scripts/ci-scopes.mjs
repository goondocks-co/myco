// What a pull request runs and what only the full run does. A pull request sets MYCO_TEST_SCOPE=pr; the full run
// (nightly, the full-ci label, a release tag) sets MYCO_TEST_SCOPE=full and runs everything. A file is listed here
// only to move it to the full run: scripts/check-test-shards.mjs proves each one is still covered by the full plan.

/**
 * Heavy and scale suites: nested bun test or a spawned binary, whole setup journeys, SIGKILL and resume,
 * recovery and restore, D1 scale and cost, and native lifecycle suites that spawn a server. The full run
 * (nightly and release) runs them. A pull request keeps one fast critical-flow file for each area.
 */
export const HEAVY_AND_SCALE_SUITES = [
  'tests/member/offline-recovery.test.ts',
  'tests/meta/setup-no-real-services.test.ts',
  'tests/myco-server/auto-join-cost.test.ts',
  'tests/myco-server/backup-restore-boundaries.test.ts',
  'tests/myco-server/backup-retention.test.ts',
  'tests/myco-server/budget-read-bound.test.ts',
  'tests/myco-server/canopy-capture-cost.test.ts',
  'tests/myco-server/document-publication-recovery.test.ts',
  'tests/myco-server/embedding-bounded-cost.test.ts',
  'tests/myco-server/embedding-read-budget.test.ts',
  'tests/myco-server/embedding-running-cost.test.ts',
  'tests/myco-server/events-read-budget-runtime.test.ts',
  'tests/myco-server/extraction-coverage-budget.test.ts',
  'tests/myco-server/injection-served-cost.test.ts',
  'tests/myco-server/injection-snapshot-budget-runtime.test.ts',
  'tests/myco-server/legacy-history-budget.test.ts',
  'tests/myco-server/lineage-restore.test.ts',
  'tests/myco-server/machine-head-cost.test.ts',
  'tests/myco-server/plan-status-intent.test.ts',
  'tests/myco-server/plans-activity-cost.test.ts',
  'tests/myco-server/raw-proof-cost.test.ts',
  'tests/myco-server/recovery-alarm-runtime.test.ts',
  'tests/myco-server/recovery-download-runtime.test.ts',
  'tests/myco-server/recovery-producer-object.test.ts',
  'tests/myco-server/remaining-read-cost.test.ts',
  'tests/myco-server/response-owner-cost.test.ts',
  'tests/myco-server/restore-job-pacing.test.ts',
  'tests/myco-server/restore-job.test.ts',
  'tests/myco-server/run-list-read-cost.test.ts',
  'tests/myco-server/search-read-cost.test.ts',
  'tests/myco-server/session-deletion-cost.test.ts',
  'tests/myco-server/session-long.test.ts',
  'tests/myco-server/session-read-cost.test.ts',
  'tests/myco-server/settings-cost.test.ts',
  'tests/myco-server/spore-lifecycle-cost.test.ts',
  'tests/myco-server/today-read-cost.test.ts',
  'tests/scripts/run-bun-tests-guards.test.ts',
  'tests/server/cloudflare-backup-streaming.test.ts',
  'tests/server/cloudflare-recovery-database.test.ts',
  'tests/server/cloudflare-recovery.test.ts',
  'tests/server/local-lifecycle-inspection.test.ts',
  'tests/server/local-lifecycle-prepare.test.ts',
  'tests/server/local-lifecycle-preserve.test.ts',
  'tests/server/local-recovery.test.ts',
  'tests/server/recovery-bundle.test.ts',
  'tests/server/recovery-hold-destination.test.ts',
  'tests/server/recovery-materialize-boundaries.test.ts',
  'tests/server/recovery-materialize.test.ts',
  'tests/setup/create-sigkill-resume-cloudflare.test.ts',
  'tests/setup/journeys-legacy.test.ts',
  'tests/setup/journeys-owner-consent.test.ts',
  'tests/setup/journeys-owner-create.test.ts',
  'tests/setup/journeys-owner-link.test.ts',
  'tests/setup/sigkill-resume.test.ts',
  'tests/setup/status-journey-contract.test.ts',
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

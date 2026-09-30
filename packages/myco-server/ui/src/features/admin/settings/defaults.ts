/**
 * What the server does with each setting nobody has written: the value it
 * applies, or what leaving it unset means.
 *
 * The server keeps these beside the code that reads each setting, in modules
 * the dashboard's build cannot import. So they are copied here, and
 * `tests/myco-server/settings-defaults.test.ts` reads the server's own readers
 * over an empty store and fails where the two disagree. The catalogue reads
 * this table; `tests/meta/server-ui-settings-catalogue.test.ts` holds every
 * setting that still does something to an entry.
 */
import { CANOPY_DEFAULT_EXCLUDE_PATTERNS } from '@goondocks/myco-shared/canopy';

/** The value the server applies to an unwritten setting, or what unset means, in a word or two. */
export type LeafDefault = { value: unknown } | { unset: string };

export const LEAF_DEFAULTS: Readonly<Record<string, LeafDefault>> = {
  // When Myco works (core/scheduled-tasks.ts scheduleLeaves).
  'agent.scheduled_tasks_enabled': { value: false },
  'agent.scheduled_tasks_active_window_days': { value: 14 },
  'agent.cold_project_threshold_days': { value: 14 },
  // core/release-provenance.ts DEFAULT_RECONCILE_INTERVAL_MINUTES.
  'release_provenance.reconcile_interval_minutes': { value: 15 },
  // core/limits.ts readDispatchLimits: unset is null, which holds nothing back.
  'agent.limits.concurrent_runs': { unset: 'No limit' },
  'agent.limits.task_concurrent_runs': { unset: 'No limit' },
  'agent.limits.task_runs_per_hour': { unset: 'No limit' },
  // core/harness.ts: no preference, and no fallback beyond it.
  'worker.harness': { unset: 'None' },
  'worker.harness_fallback': { value: [] },
  // core/recall.ts recallLeaves and core/injection.ts injectionLeaves.
  'instructions.template': { value: '' },
  'cortex.instructions.inject_on_session_start': { value: true },
  'cortex.instructions.inject_on_subagent_start': { value: true },
  'cortex.digest.tier': { value: 5000 },
  'cortex.spores.inject_on_prompt_submit': { value: true },
  'cortex.spores.max_per_prompt': { value: 7 },
  'cortex.plans.inject_intent_nudge_on_prompt_submit': { value: true },
  // core/scheduled-tasks.ts: unset, the map refresh is off at the interval TASK_SCHEDULE declares for it.
  'cortex.canopy.refresh.background_enabled': { value: false },
  'cortex.canopy.refresh.background_period_minutes': { value: 360 },
  'cortex.canopy.exclude.patterns': { value: [] },
  'cortex.canopy.exclude.default_patterns': { value: CANOPY_DEFAULT_EXCLUDE_PATTERNS },
  // core/harness.ts: with no provider, the server runs none of its own work.
  'agent.provider.type': { unset: 'None' },
  'agent.provider.model': { unset: 'None' },
  'agent.provider.base_url': { unset: 'The provider’s own' },
  'agent.model': { unset: 'None' },
  'agent.tasks': { value: {} },
  // core/embedding/configured-provider.ts; core/embedding/jobs.ts keeps embedding unless the leaf is false.
  'embedding.provider': { unset: 'None' },
  'embedding.model': { unset: 'None' },
  'embedding.base_url': { unset: 'The provider’s own' },
  'embedding.prevent_deep_sleep': { value: true },
  // core/import-policy.ts importPolicy.
  'import.enabled': { value: true },
  'import.window_days': { value: 30 },
  'import.max_sessions_per_harness': { value: 50 },
  // ingest/retention.ts: unset or 0 keeps raw transcripts forever.
  'retention.transcripts': { unset: 'Forever' },
  // core/jobs-run.ts RUN_RETENTION_DAYS_DEFAULT.
  'agent.run_retention_days': { value: 30 },
  // core/recovery-schedule.ts: unset schedules nothing.
  'backup.auto_interval_hours': { unset: 'Off' },
  'backup.recovery.keep_stagings': { value: 2 },
  'backup.retention.keep_daily': { value: 14 },
  'backup.retention.keep_weekly': { value: 8 },
  // core/store-maintenance.ts: no check is configured until it is turned on with an interval.
  'maintenance.auto_optimize': { value: false },
  'maintenance.auto_optimize_interval_hours': { unset: 'Not set' },
  'maintenance.auto_integrity_check': { value: false },
  'maintenance.auto_integrity_check_interval_hours': { unset: 'Not set' },
};

/** The default of a setting that has one, or undefined. */
export function defaultValueOf(leaf: string): unknown {
  const entry = LEAF_DEFAULTS[leaf];
  return entry !== undefined && 'value' in entry ? entry.value : undefined;
}

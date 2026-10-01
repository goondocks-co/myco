/**
 * The dashboard's table of setting defaults says what the server applies.
 *
 * `features/admin/settings/defaults.ts` copies each default: the modules
 * that hold them carry runtime imports the dashboard's build does not. This
 * reads the server's own readers over an empty store, the state of a
 * Deployment where nobody has written a setting, and holds the table to what
 * they answer: a value the server applies must match, and a setting whose
 * reader answers "nothing" must be one the table says means that when unset.
 */
import { describe, expect, it } from 'bun:test';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { CANOPY_DEFAULT_EXCLUDE_PATTERNS } from '@goondocks/myco-shared/canopy';
import { scheduleLeaves } from '@myco-server-worker/core/scheduled-tasks.js';
import { TASK_SCHEDULE } from '@myco-server-worker/core/jobs.js';
import { readDispatchLimits } from '@myco-server-worker/core/limits.js';
import { recallLeaves } from '@myco-server-worker/core/recall.js';
import { importPolicy } from '@myco-server-worker/core/import-policy.js';
import { autoCreateProjects } from '@myco-server-worker/api/member-projects.js';
import { runRetentionDays } from '@myco-server-worker/core/jobs-run.js';
import { backupRetentionPolicy } from '@myco-server-worker/core/backup-retention.js';
import { keptStagings } from '@myco-server-worker/core/staging-retention.js';
import { cadenceOf } from '@myco-server-worker/core/store-maintenance.js';
import { DEFAULT_RECONCILE_INTERVAL_MINUTES } from '@myco-server-worker/core/release-provenance.js';
import { scheduledIntervalHours } from '@myco-server-worker/core/recovery-schedule.js';
import { transcriptRetentionDays } from '@myco-server-worker/ingest/retention.js';
import { LEAF_DEFAULTS } from '../../packages/myco-server/ui/src/features/admin/settings/defaults.ts';
import { sqliteEnv } from './helpers/fixtures.js';

/** What the table holds for a leaf: its value, or "unset". */
function tabled(leaf: string): unknown {
  const entry = LEAF_DEFAULTS[leaf];
  if (entry === undefined) throw new Error(`no default for ${leaf}`);
  return 'value' in entry ? entry.value : 'unset';
}

describe('the settings page\'s defaults', () => {
  it('match what the server applies to every setting nobody has written', async () => {
    const { serverEnv, db } = sqliteEnv();
    const schedule = await scheduleLeaves(serverEnv);
    const limits = await readDispatchLimits({ db });
    const recall = recallLeaves({});
    const imports = await importPolicy(db);
    const backups = await backupRetentionPolicy(db);
    const mapSchedule = (schedule.overrides[MAP_TASK] as { schedule: { enabled: boolean; intervalSeconds?: number } }).schedule;
    const declaredMap = TASK_SCHEDULE[MAP_TASK]!;

    const server: Record<string, unknown> = {
      'agent.scheduled_tasks_enabled': schedule.enabled,
      'agent.scheduled_tasks_active_window_days': schedule.activeWindowDays,
      'agent.cold_project_threshold_days': schedule.coldThresholdDays,
      'release_provenance.reconcile_interval_minutes': DEFAULT_RECONCILE_INTERVAL_MINUTES,
      'agent.limits.concurrent_runs': limits.concurrent_runs ?? 'unset',
      'agent.limits.task_concurrent_runs': limits.task_concurrent_runs ?? 'unset',
      'agent.limits.task_runs_per_hour': limits.task_runs_per_hour ?? 'unset',
      'instructions.template': recall.instructionsTemplate,
      'cortex.instructions.inject_on_session_start': recall.instructionsAtSessionStart,
      'cortex.instructions.inject_on_subagent_start': recall.instructionsAtSubagentStart,
      'cortex.digest.tier': recall.digestTier,
      'cortex.spores.inject_on_prompt_submit': recall.injection.enabled,
      'cortex.spores.max_per_prompt': recall.injection.maxPerPrompt,
      'cortex.plans.inject_intent_nudge_on_prompt_submit': recall.planNudge,
      'cortex.canopy.refresh.background_enabled': mapSchedule.enabled,
      'cortex.canopy.refresh.background_period_minutes': (mapSchedule.intervalSeconds ?? declaredMap.intervalSeconds) / 60,
      'cortex.canopy.exclude.default_patterns': CANOPY_DEFAULT_EXCLUDE_PATTERNS,
      'capture.auto_create_projects': await autoCreateProjects(db),
      'import.enabled': imports.enabled,
      'import.window_days': imports.windowDays,
      'import.max_sessions_per_harness': imports.maxPerAgent,
      'retention.transcripts': transcriptRetentionDays(undefined) ?? 'unset',
      'agent.run_retention_days': await runRetentionDays(serverEnv),
      'backup.auto_interval_hours': (await scheduledIntervalHours(serverEnv)) ?? 'unset',
      'backup.recovery.keep_stagings': await keptStagings(db),
      'backup.retention.keep_daily': backups.keepDaily,
      'backup.retention.keep_weekly': backups.keepWeekly,
      'maintenance.auto_optimize': (await cadenceOf(serverEnv, 'optimize')).state === 'on',
      'maintenance.auto_integrity_check': (await cadenceOf(serverEnv, 'integrity')).state === 'on',
    };
    const disagree = Object.entries(server)
      .filter(([leaf, value]) => JSON.stringify(tabled(leaf)) !== JSON.stringify(value))
      .map(([leaf, value]) => `${leaf}: server ${JSON.stringify(value)}, page ${JSON.stringify(tabled(leaf))}`);
    expect(disagree).toEqual([]);
    // An interval with no check turned on configures nothing: the page says it is not set.
    expect([tabled('maintenance.auto_optimize_interval_hours'), tabled('maintenance.auto_integrity_check_interval_hours')]).toEqual(['unset', 'unset']);
  });
});

import { NEXT_RUN_INTERRUPTION } from './schema-vNEXT-run-interruptions.js';
import { reaching, retiring, type SchemaStep } from './schema-step.js';
import { subjectInterruptionSchema } from './runs/interruptions.js';
import { interruptedRunHourTriggers } from './runs/run-hours.js';

/** Interrupted attempts are visible records, bounded per subject, with completed work clearing the bound. */
export const RUN_INTERRUPTION_STEPS: readonly SchemaStep[] = [{
  version: NEXT_RUN_INTERRUPTION,
  statements: [
    ...subjectInterruptionSchema(),
    "CREATE INDEX IF NOT EXISTS idx_run_subject_completed ON agent_runs(project_id,task,subject,started_at DESC) WHERE status='completed'",
    'DROP TRIGGER IF EXISTS run_hour_finish',
    'DROP TRIGGER IF EXISTS run_hour_insert',
    ...interruptedRunHourTriggers().map(item => item.sql),
  ],
  retires: retiring('trigger', ['run_hour_finish','run_hour_insert'], 'Run hours include interrupted work separately from failures.'),
  reaches: [
    ...reaching(['agent_runs','spore_curation_work'], 'Subject completion resolves interrupted work and guards its automatic retry bound.'),
  ],
}];

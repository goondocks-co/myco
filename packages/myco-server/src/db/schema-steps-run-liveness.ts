import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_RUN_LIVENESS } from './schema-vNEXT-run-liveness.js';
import { contactHourSchemaStatements } from './runners/contact-hours.js';
import { REQUEUED_INDEX, waitHourSchemaStatements } from './runs/wait-hours.js';

/**
 * A run keeps when its lease was last renewed and when its current stay in the queue began, and each attempt the hold
 * its run waited under and since when; each runner's check-ins are counted by the hour as its contact is recorded, and
 * each stay in the queue by the hours it began and ended as the run leaves the queue, whatever takes it out. Every one
 * rides a write Myco already makes, and history starts here: what was not recorded before cannot be counted.
 */
export const RUN_LIVENESS_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_RUN_LIVENESS,
    statements: [
      'ALTER TABLE agent_runs ADD COLUMN last_renewed_at INTEGER',
      'ALTER TABLE agent_runs ADD COLUMN waited_for TEXT',
      'ALTER TABLE agent_runs ADD COLUMN queue_entered_at INTEGER',
      'ALTER TABLE agent_run_attempts ADD COLUMN waited_for TEXT',
      'ALTER TABLE agent_run_attempts ADD COLUMN waited_since INTEGER',
      ...contactHourSchemaStatements(),
      ...waitHourSchemaStatements(),
      REQUEUED_INDEX,
    ],
    reaches: [
      ...changing(['agent_runs'], 'A renewal records when it renewed the lease, a return to the queue when the stay began, a claim the hold the run waited under, and a run leaving the queue counts its stay by the hour.'),
      ...changing(['agent_run_attempts'], 'An attempt keeps the hold its run waited under and when that wait began.'),
      ...reaching(['runner_contacts'], 'A recorded runner contact counts its check-in by the hour.'),
    ],
    deploymentIndexes: [{ index: 'idx_agent_runs_requeued', read: 'The Runs page finds the earliest stay of work put back in the queue' }],
  },
];

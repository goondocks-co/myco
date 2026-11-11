import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_RUN_LIVENESS } from './schema-vNEXT-run-liveness.js';
import { contactHourSchemaStatements } from './runners/contact-hours.js';
import { waitHourSchemaStatements } from './runs/wait-hours.js';

/**
 * A run keeps when its lease was last renewed, and each attempt the hold its run waited under before a machine took it;
 * each runner's check-ins are counted by the hour as its contact is recorded, and the runs that waited by the hours they
 * were queued and taken as a claim records its attempt. Every one rides a write Myco already makes, and history starts
 * here: what was not recorded before cannot be counted.
 */
export const RUN_LIVENESS_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_RUN_LIVENESS,
    statements: [
      'ALTER TABLE agent_runs ADD COLUMN last_renewed_at INTEGER',
      'ALTER TABLE agent_runs ADD COLUMN waited_for TEXT',
      'ALTER TABLE agent_run_attempts ADD COLUMN waited_for TEXT',
      ...contactHourSchemaStatements(),
      ...waitHourSchemaStatements(),
    ],
    reaches: [
      ...changing(['agent_runs'], 'A renewal records when it renewed the lease, and a claim the hold the run waited under.'),
      ...changing(['agent_run_attempts'], 'An attempt keeps the hold its run waited under, and its insert counts the wait by the hour.'),
      ...reaching(['runner_contacts'], 'A recorded runner contact counts its check-in by the hour.'),
    ],
  },
];

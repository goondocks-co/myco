import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_RUN_DRIFT } from './schema-vNEXT-run-drift.js';
import { servedPromptSchemaStatements } from './runs/served-prompts.js';

/**
 * Each attempt keeps the runner version and the coding agent version it ran with, copied in the claim's own write from
 * what the runner reports, and each run counts the prompts Myco served it as the serving records them. History starts
 * here: an attempt claimed before reads "not reported", and a run queued before has no count.
 */
export const RUN_DRIFT_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_RUN_DRIFT,
    statements: [
      'ALTER TABLE agent_run_attempts ADD COLUMN runner_version TEXT',
      'ALTER TABLE agent_run_attempts ADD COLUMN agent_version TEXT',
      'ALTER TABLE run_head ADD COLUMN prompts INTEGER NOT NULL DEFAULT 0',
      ...servedPromptSchemaStatements(),
    ],
    reaches: [
      ...changing(['agent_run_attempts'], 'An attempt keeps the runner and coding agent versions it ran with.'),
      ...changing(['run_head'], 'A run counts the prompts Myco served it.'),
      ...reaching(['run_served_material'], 'Serving a prompt counts it on the run it was served to.'),
      ...changing(['schema_meta'], 'The served-prompt count records when it started counting, so a run queued before reads as not recorded.'),
    ],
  },
];

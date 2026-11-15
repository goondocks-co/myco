
import { changing, reaching, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_DIRECT_TITLES } from './schema-vNEXT-direct-titles.js';
import { liveTriggers } from './runs/live.js';

const TRIGGERS = ['run_live_insert', 'run_live_update', 'run_live_add', 'run_live_remove', 'run_live_counts'];

/** Direct calls remain visible work while runner admission counts runner work alone. */
export const DIRECT_TITLE_STEPS: readonly SchemaStep[] = [{
  version: NEXT_DIRECT_TITLES,
  statements: [
    'ALTER TABLE run_live ADD COLUMN direct INTEGER NOT NULL DEFAULT 0 CHECK(direct IN (0,1))',
    ...TRIGGERS.map(name => 'DROP TRIGGER IF EXISTS ' + name),
    ...liveTriggers().map(trigger => trigger.sql),
    "UPDATE run_live SET direct=1 WHERE EXISTS(SELECT 1 FROM agent_runs r WHERE r.project_id=run_live.project_id AND r.id=run_live.run_id AND r.provider='direct')",
  ],
  retires: retiring('trigger', TRIGGERS, 'Admission counters distinguish direct calls from runner work.'),
  reaches: [
    ...changing(['run_live'], 'The maintained work rows retain direct execution identity and reclassify existing direct calls.'),
    ...reaching(['agent_runs', 'projection_catchup', 'task_due', 'task_runtime'], 'Run changes publish the execution identity into the work projection.'),
  ],
}];

import { reaching, type SchemaStep } from './schema-step.js';
import { NEXT_PULLED_WAITING } from './schema-vNEXT-pulled-waiting.js';
import { IN_FLIGHT_RUN_STATUSES } from './run-statuses.js';

/** Ready rows retain their due deadline in the promoted column; each wait reads its oldest eligible row. */
export const PULLED_WAITING_STEPS: readonly SchemaStep[] = [
  { version: NEXT_PULLED_WAITING, statements: [
    'CREATE INDEX IF NOT EXISTS idx_learning_card_waiting ON learning_sessions(project_id,card_stage,card_promoted_at,session_id) WHERE card_stage IS NOT NULL',
  ], reaches: reaching(['learning_sessions'], 'Ready card work seeks its oldest due deadline within one Project and stage.'),
    deploymentIndexes: [{ index: 'idx_learning_card_waiting', read: 'Needs you seeks the oldest ready card deadline by Project and stage' }],
  },
  { version: NEXT_PULLED_WAITING + 1, statements: [
    'CREATE INDEX IF NOT EXISTS idx_learning_stage_waiting ON learning_sessions(project_id,learning_stage,learning_promoted_at,session_id) WHERE learning_stage IS NOT NULL',
  ], reaches: reaching(['learning_sessions'], 'Ready learning work seeks its oldest due deadline within one Project and stage.'),
    deploymentIndexes: [{ index: 'idx_learning_stage_waiting', read: 'Needs you seeks the oldest ready learning deadline by Project and stage' }],
  },
  { version: NEXT_PULLED_WAITING + 2, statements: [
    "CREATE INDEX IF NOT EXISTS idx_task_runtime_budget ON task_runtime(project_id,task,origin) WHERE queued_count>0 AND origin='automatic' AND hold_reason='budget'",
  ], reaches: reaching(['task_runtime'], 'The current budget hold read seeks only automatic budget-held heads.'),
    deploymentIndexes: [{ index: 'idx_task_runtime_budget', read: 'Budget holds skip unrelated manual and capacity-held queued work' }],
  },
  { version: NEXT_PULLED_WAITING + 3, statements: [
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_project_live ON agent_runs(project_id,status,queued_at,id) WHERE ${IN_FLIGHT_RUN_STATUSES}`,
  ], reaches: reaching(['agent_runs'], 'Named live-work reads seek the Project and status without visiting terminal history.'),
    deploymentIndexes: [{ index: 'idx_agent_runs_project_live', read: 'Named Project work pages and counts seek only in-flight runs' }],
  },
];

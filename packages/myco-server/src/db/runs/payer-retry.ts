import { STORED_KEY_READER_CODES } from '@goondocks/myco-shared/run-diagnostic';
import { write } from '../index.js';
import { RUN_CONTEXT_OBJECT_SQL } from './queue.js';

const retryStoredKeyRun = write<[projectId: string, runId: string, attemptId: string, nextId: string]>({
  name: 'runs.retryOnRunnerSignIn',
  sql: `INSERT INTO agent_runs (project_id,id,agent_id,task,instruction,provider,model,status,dry_run,queued_at,
    held_by,dispatch_spec,run_context,origin,subject,runner_fallback_reason,runner_fallback_from)
   SELECT project_id,?4,agent_id,task,instruction,provider,model,'queued',dry_run,completed_at,
     'worker',dispatch_spec,json_set(json_remove(${RUN_CONTEXT_OBJECT_SQL}, '$.harnessStop', '$.endedNote', '$.learningRetry', '$.fallbackRunId',
       '$.materialRead', '$.runControlRefusals', '$.budgetEstimateUsd', '$.budgetQuotedAt'),
       '$.replaces',id),origin,subject,runner_secret_outcome,id
   FROM agent_runs WHERE project_id=?1 AND id=?2 AND dispatched_by=?3 AND status='failed'
     AND json_extract(run_context,'$.fallbackRunId')=?4 AND runner_payer='stored' AND runner_fallback_allowed=1 AND runner_fallback_from IS NULL
     AND error_code IN ('${STORED_KEY_READER_CODES.out_of_credit}','${STORED_KEY_READER_CODES.invalid_key}')`,
});

/** Queue the same work only from the stored-key attempt whose end won settlement. */
export const retryOnRunnerSignIn = (projectId: string, runId: string, attemptId: string, nextId: string) =>
  retryStoredKeyRun.bind(projectId, runId, attemptId, nextId);

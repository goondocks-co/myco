import { NEXT_RUNNER_SECRET_HEALTH } from './schema-vNEXT-runner-secret-health.js';
import { changing, retiring, type SchemaStep } from './schema-step.js';
import { RUNNER_SECRET_END } from './settings/runner-secret-health.js';
import { loginRetryStatements } from './schema-v694.js';
import { STORED_KEY_READER_CODES } from '@goondocks/myco-shared/run-diagnostic';

export const RUNNER_SECRET_HEALTH_STEPS: readonly SchemaStep[] = [{
  version: NEXT_RUNNER_SECRET_HEALTH,
  statements: [
    'ALTER TABLE deployment_secrets ADD COLUMN runner_failure TEXT',
    'ALTER TABLE deployment_secrets ADD COLUMN runner_retry_at INTEGER',
    'ALTER TABLE deployment_secrets ADD COLUMN runner_probe TEXT',
    'ALTER TABLE agent_runs ADD COLUMN runner_secret_slot TEXT',
    'ALTER TABLE agent_runs ADD COLUMN runner_secret_generation TEXT',
    'ALTER TABLE agent_runs ADD COLUMN runner_secret_outcome TEXT',
    `CREATE TRIGGER IF NOT EXISTS runner_secret_replaced AFTER UPDATE OF iv ON deployment_secrets
      WHEN OLD.iv IS NOT NEW.iv BEGIN
        UPDATE deployment_secrets SET runner_failure=NULL,runner_retry_at=NULL,runner_probe=NULL
          WHERE name=NEW.name AND iv=NEW.iv;
      END`,
    RUNNER_SECRET_END,
    `CREATE TRIGGER IF NOT EXISTS curation_runner_secret_retry AFTER UPDATE OF status ON agent_runs
      WHEN OLD.status='running' AND NEW.status='failed' AND NEW.task='curate-spores'
        AND NEW.error_code IN (${Object.values(STORED_KEY_READER_CODES).map(code => `'${code}'`).join(',')}) BEGIN
        UPDATE spore_curation_work SET due_at=MIN(due_at,NEW.completed_at),failures=failures-1,
          first_started_at=CASE WHEN failures=1 THEN NULL ELSE first_started_at END
          WHERE project_id=NEW.project_id AND run_id=NEW.id AND decision IS NULL AND failures>0;
      END`,
    'DROP TRIGGER IF EXISTS agent_run_login_retry',
    ...loginRetryStatements(['agent_invalid_key', ...Object.values(STORED_KEY_READER_CODES)]),
  ],
  reaches: changing(['deployment_secrets','agent_runs'], 'Stored key health and the key generation used by a runner attempt.'),
  retires: retiring('trigger', ['card_run_retry', 'agent_run_login_retry'], 'Both triggers include stored-key refusals in sign-in retry handling.'),
}];

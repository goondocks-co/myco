import { RUNNER_KEY_RECHECK_MS } from '@goondocks/myco-shared/runner-fleet';
import { NEXT_RUNNER_PAYER } from './schema-vNEXT-runner-payer.js';
import { changing, type SchemaStep } from './schema-step.js';

export const RUNNER_PAYER_STEPS: readonly SchemaStep[] = [{
  version: NEXT_RUNNER_PAYER,
  statements: [
    "ALTER TABLE runners ADD COLUMN credential_choice_times TEXT NOT NULL DEFAULT '{}'",
    'ALTER TABLE runner_signin_audit ADD COLUMN fallback_to_own INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE agent_runs ADD COLUMN runner_payer TEXT',
    'ALTER TABLE agent_runs ADD COLUMN runner_fallback_reason TEXT',
    'ALTER TABLE agent_runs ADD COLUMN runner_fallback_allowed INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE agent_runs ADD COLUMN runner_fallback_from TEXT',
    'ALTER TABLE agent_run_attempts ADD COLUMN runner_payer TEXT',
    'ALTER TABLE agent_run_attempts ADD COLUMN runner_fallback_reason TEXT',
    'ALTER TABLE deployment_secrets ADD COLUMN runner_failure_since INTEGER',
    'CREATE TABLE IF NOT EXISTS runner_key_removals (slot TEXT PRIMARY KEY, removed_at INTEGER NOT NULL)',
    `CREATE TRIGGER IF NOT EXISTS runner_secret_failure_since AFTER UPDATE OF runner_failure ON deployment_secrets
      WHEN OLD.runner_failure IS NOT NEW.runner_failure BEGIN
        UPDATE deployment_secrets SET runner_failure_since=CASE WHEN NEW.runner_failure IS NULL THEN NULL
          ELSE NEW.runner_retry_at - ${RUNNER_KEY_RECHECK_MS} END WHERE name=NEW.name AND iv=NEW.iv;
      END`,
  ],
  reaches: changing(['runners', 'runner_signin_audit', 'agent_runs', 'agent_run_attempts', 'deployment_secrets'], 'Runner payer choices, actual payer, one sign-in retry and the first observation of a held key.'),
}];

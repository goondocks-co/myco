import { changing, reaching, type SchemaStep } from './schema-step.js';
import { NEXT_TURN_COVERAGE } from './schema-vNEXT-turn-coverage.js';
import { TURN_SOURCE_FAILURE_LIMIT } from '../core/turn-source.js';

const partial = (row: string) => `(${row}.state='carded' AND ${row}.partial_reason IS NOT NULL)`;
const count = (row: string, delta: string) => `INSERT INTO learning_project_counts(project_id,partial_turns) VALUES(${row}.project_id,${delta})
  ON CONFLICT(project_id) DO UPDATE SET partial_turns=partial_turns+excluded.partial_turns;
  UPDATE change_marks SET revision=revision+1 WHERE kind='learning';`;

export const TURN_COVERAGE_STEPS: readonly SchemaStep[] = [{
  version: NEXT_TURN_COVERAGE,
  statements: [
    'ALTER TABLE session_prompts ADD COLUMN source_bytes INTEGER',
    'ALTER TABLE turn_cards ADD COLUMN partial_reason TEXT',
    'ALTER TABLE turn_cards ADD COLUMN source_failures INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE turn_cards ADD COLUMN source_run_id TEXT',
    'ALTER TABLE learning_project_counts ADD COLUMN partial_turns INTEGER NOT NULL DEFAULT 0',
    `CREATE INDEX IF NOT EXISTS idx_turn_cards_source_run ON turn_cards(project_id,source_run_id) WHERE source_run_id IS NOT NULL AND state='pending'`,
    `CREATE TRIGGER IF NOT EXISTS turn_source_failed AFTER UPDATE OF status ON agent_runs
      WHEN NEW.status='failed' AND OLD.status<>'failed' BEGIN
      UPDATE turn_cards SET source_failures=source_failures+1,source_run_id=NULL,
        partial_reason=CASE WHEN source_failures+1>=${TURN_SOURCE_FAILURE_LIMIT} THEN 'read_failed' ELSE partial_reason END
      WHERE project_id=NEW.project_id AND source_run_id=NEW.id AND state='pending'; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_source_changed AFTER UPDATE OF changes ON turn_cards WHEN NEW.changes<>OLD.changes
      AND (OLD.partial_reason IS NOT NULL OR OLD.source_failures<>0 OR OLD.source_run_id IS NOT NULL) BEGIN
      UPDATE turn_cards SET partial_reason=NULL,source_failures=0,source_run_id=NULL
      WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND turn_key=NEW.turn_key; END`,
    `CREATE TRIGGER IF NOT EXISTS turn_partial_insert AFTER INSERT ON turn_cards WHEN ${partial('NEW')} BEGIN ${count('NEW', '1')} END`,
    `CREATE TRIGGER IF NOT EXISTS turn_partial_update AFTER UPDATE OF state,partial_reason ON turn_cards
      WHEN ${partial('NEW')}<>${partial('OLD')} BEGIN ${count('NEW', `${partial('NEW')}-${partial('OLD')}`)} END`,
    `CREATE TRIGGER IF NOT EXISTS turn_partial_delete AFTER DELETE ON turn_cards WHEN ${partial('OLD')} BEGIN
      UPDATE learning_project_counts SET partial_turns=partial_turns-1 WHERE project_id=OLD.project_id;
      UPDATE change_marks SET revision=revision+1 WHERE kind='learning'; END`,
  ],
  reaches: [
    ...changing(['session_prompts','turn_cards','learning_project_counts'], 'Turn source size, failed reads and partial cards retain their disposition and contribute to the learning status counter.'),
    ...reaching(['agent_runs'], 'Every failed card run settles its outstanding turn reads at the run transition.'),
  ],
}];

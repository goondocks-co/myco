import { retiring, type SchemaStep } from './schema-step.js';
import { occurredAt } from './session-dates.js';
import { contextPlacementSchemaStatements } from './sessions/placement-schema.js';
import { projectStatisticsSchemaStatements } from './sessions/statistics-schema.js';

/** Placeholder first step of this change; the coordinator assigns the real numbers at merge. */
export const NEXT_S2C2 = 773;
/** The last step of this change: the schema version a server of this change runs. */
export const LAST_S2C2 = NEXT_S2C2 + 5;

/**
 * Sessions across Projects order by the instant, the Project and the id, on an index built in a step of its own before
 * the step that retires the index it replaces. Two rows of `uncaptured_roots` tie on their last miss, so a page of
 * repositories keys on the machine and root as well.
 */
export const VNEXT_S2C2_STEPS: readonly SchemaStep[] = [
  { version: NEXT_S2C2, statements: [`CREATE INDEX IF NOT EXISTS idx_sessions_occurred_project ON sessions (${occurredAt()}, project_id, session_id)`] },
  { version: NEXT_S2C2 + 1, statements: ['DROP INDEX IF EXISTS idx_sessions_occurred_deployment'],
    retires: retiring('index', ['idx_sessions_occurred_deployment'], 'idx_sessions_occurred_project orders the same sessions with a complete tuple.') },
  { version: NEXT_S2C2 + 2, statements: [
    'CREATE INDEX IF NOT EXISTS idx_uncaptured_roots_recent ON uncaptured_roots (last_seen_at, machine_id, root_key)',
    'CREATE INDEX IF NOT EXISTS idx_uncaptured_roots_member_recent ON uncaptured_roots (member_id, last_seen_at, machine_id, root_key)',
    'DROP INDEX IF EXISTS idx_uncaptured_roots_seen',
    'DROP INDEX IF EXISTS idx_uncaptured_roots_member',
  ] },
  { version: NEXT_S2C2 + 3, statements: projectStatisticsSchemaStatements() },
  { version: NEXT_S2C2 + 4, statements: ['CREATE INDEX IF NOT EXISTS idx_prompt_context_answers_delivered ON prompt_context_answers (project_id, session_id, delivered_prompt_id) WHERE delivered_prompt_id IS NOT NULL'] },
  { version: LAST_S2C2, statements: contextPlacementSchemaStatements() },
];

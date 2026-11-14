import { PROJECT_ID_GRAMMAR } from './project-id.js';
import { V110_STATEMENTS } from './schema-v110.js';
import { LEARNING_SOURCE_STEPS } from './schema-v546.js';
import { VNEXT_S4B2_STEPS } from './schema-vNEXT-s4b2.js';
import { VNEXT_S7_STEPS } from './schema-vNEXT-s7.js';

/** The stored progress and generated stages of a session in the forward learning window. */
const LEARNING_WINDOW_SESSION_TABLE = `CREATE TABLE IF NOT EXISTS learning_sessions (project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,next_seq INTEGER NOT NULL DEFAULT 1 CHECK(next_seq>0),
    max_seq INTEGER NOT NULL DEFAULT 0 CHECK(max_seq>=0),revision INTEGER NOT NULL DEFAULT 0,
  learned_seq INTEGER NOT NULL DEFAULT 0,
  init_state TEXT NOT NULL DEFAULT 'pending' CHECK (init_state IN ('pending','awaiting_publication','ready')),
  eligible_at INTEGER,
  pending_cards INTEGER NOT NULL DEFAULT 0,
  due_cards INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  skipped_by_owner INTEGER NOT NULL DEFAULT 0,
  handoff TEXT CHECK (handoff IS NULL OR length(CAST(handoff AS BLOB)) <= 4096),
  carded_seq INTEGER NOT NULL DEFAULT 0,
  last_completed_at INTEGER,
  last_completed_reason TEXT,
  last_completed_run TEXT,
  source_activity_at INTEGER,
  source_day INTEGER GENERATED ALWAYS AS (CAST(source_activity_at / 86400000 AS INTEGER)) VIRTUAL,
  quiet_at INTEGER NOT NULL DEFAULT 0,
  card_failures INTEGER NOT NULL DEFAULT 0,
  card_retry_at INTEGER NOT NULL DEFAULT 0,
  card_ready_at INTEGER GENERATED ALWAYS AS (MAX(quiet_at,card_retry_at)) VIRTUAL,
  learning_ready_at INTEGER GENERATED ALWAYS AS (MAX(quiet_at,COALESCE(eligible_at,0))) VIRTUAL,
  signal_cards INTEGER NOT NULL DEFAULT 0,
  last_carded_at INTEGER,
  next_model_due_at INTEGER,
  counted INTEGER NOT NULL DEFAULT 0,
  card_promoted_at INTEGER,
  learning_promoted_at INTEGER,
  quiet_generation INTEGER,
  card_deadline INTEGER GENERATED ALWAYS AS (CASE WHEN pending_cards>0 AND source_activity_at IS NOT NULL AND (counted=0 OR next_model_due_at IS NOT NULL) THEN MAX(quiet_at,card_retry_at,COALESCE(next_model_due_at,0)) END) VIRTUAL,
  learning_deadline INTEGER GENERATED ALWAYS AS (CASE WHEN eligible_at IS NOT NULL AND source_activity_at IS NOT NULL THEN MAX(quiet_at,eligible_at) END) VIRTUAL,
  aged_out_at INTEGER,
  card_stage TEXT GENERATED ALWAYS AS
      (CASE WHEN aged_out_at IS NULL AND card_deadline IS NOT NULL AND card_promoted_at=card_deadline THEN 'cards' END) VIRTUAL,
  learning_stage TEXT GENERATED ALWAYS AS
      (CASE WHEN aged_out_at IS NULL AND learning_deadline IS NOT NULL AND learning_promoted_at=learning_deadline THEN 'learning' END) VIRTUAL,PRIMARY KEY(project_id,session_id),FOREIGN KEY(project_id) REFERENCES projects(project_id))`;

const columns = [
  'project_id', 'session_id', 'next_seq', 'max_seq', 'revision', 'learned_seq', 'init_state', 'eligible_at', 'pending_cards', 'due_cards', 'failures', 'skipped_by_owner', 'handoff', 'carded_seq', 'last_completed_at', 'last_completed_reason', 'last_completed_run', 'source_activity_at', 'quiet_at', 'card_failures', 'card_retry_at', 'signal_cards', 'last_carded_at', 'next_model_due_at', 'counted', 'card_promoted_at', 'learning_promoted_at', 'quiet_generation', 'aged_out_at'
] as const;

/** Copy the row identity and every stored field while replacing generated stage definitions. */
export const LEARNING_WINDOW_SESSION_REBUILD = [
  'DROP TABLE IF EXISTS _learning_window_sessions',
  `CREATE TABLE IF NOT EXISTS _learning_window_sessions AS SELECT rowid AS saved_rowid,${columns.join(',')} FROM learning_sessions`,
  'DROP TABLE IF EXISTS learning_sessions',
  LEARNING_WINDOW_SESSION_TABLE,
  `INSERT INTO learning_sessions(rowid,${columns.join(',')}) SELECT saved_rowid,${columns.join(',')} FROM _learning_window_sessions`,
  'DROP TABLE IF EXISTS _learning_window_sessions',
] as const;

const retained = (statements: readonly string[], kind: 'TRIGGER' | 'INDEX', names: readonly string[]): string[] => names.map(name => {
  const statement = statements.find(sql => sql.startsWith(`CREATE ${kind} IF NOT EXISTS ${name} `));
  if (statement === undefined) throw new Error(`Missing retained learning ${kind.toLowerCase()}: ${name}`);
  return statement;
});

/** Retained session triggers and source lookup indexes. */
export const LEARNING_WINDOW_RETAINED_OBJECTS = [
  ...retained(V110_STATEMENTS, 'INDEX', ['idx_learning_completed']),
  ...retained(LEARNING_SOURCE_STEPS.flatMap(step => [...step.statements]), 'INDEX', ['idx_learning_source_eligible', 'idx_learning_source_missing']),
  ...retained(VNEXT_S4B2_STEPS.flatMap(step => [...step.statements]), 'TRIGGER', ['learning_session_counted']),
  ...retained(VNEXT_S7_STEPS.flatMap(step => [...step.statements]), 'TRIGGER', ['learning_session_quiet_insert', 'learning_source_quiet']),
];

import { PROJECT_ID_GRAMMAR } from './project-id.js';

/** The last schema step of the session deletion and job work; the three index builds before it run one per step. */
export const NEXT_S2D = 763;

/**
 * Durable session deletion and bulk reread jobs, the recurring orphan audit that replaces the deletion-window gate, and
 * the two session-keyed paths the deletion pages walk.
 */
export const VNEXT_S2D_STEPS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  { version: NEXT_S2D - 3, statements: [
    'CREATE INDEX IF NOT EXISTS idx_publication_dependencies_session ON publication_dependencies(project_id,session_id,child_event_id,prerequisite_kind,prerequisite_id)',
  ] },
  { version: NEXT_S2D - 2, statements: [
    'CREATE INDEX IF NOT EXISTS idx_spores_prompt ON spores(project_id,prompt_id) WHERE prompt_id IS NOT NULL',
  ] },
  { version: NEXT_S2D - 1, statements: [
    'CREATE INDEX IF NOT EXISTS idx_document_transcript_pins_session ON document_transcript_pins(project_id,session_id,transcript_id)',
  ] },
  { version: NEXT_S2D, statements: [
    `CREATE TABLE IF NOT EXISTS session_deletion_jobs(
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','complete')),
      phase TEXT NOT NULL,removed INTEGER NOT NULL DEFAULT 0,blobs_released INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,accepted_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,completed_at INTEGER,
      failure TEXT,failed_at INTEGER,
      PRIMARY KEY(project_id,session_id)) WITHOUT ROWID`,
    "CREATE INDEX IF NOT EXISTS idx_session_deletion_jobs_running ON session_deletion_jobs(accepted_at,project_id,session_id) WHERE state='running'",
    `CREATE TABLE IF NOT EXISTS transcript_reread_jobs(
      id TEXT PRIMARY KEY,agent TEXT,project_id TEXT CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT,
      state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','complete')),
      after_project TEXT NOT NULL DEFAULT '',after_transcript TEXT NOT NULL DEFAULT '',
      walked INTEGER NOT NULL DEFAULT 0,rewound INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,
      requested_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,completed_at INTEGER,
      CHECK ((agent IS NULL) <> (project_id IS NULL)),CHECK ((project_id IS NULL) = (session_id IS NULL)))`,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_reread_selector ON transcript_reread_jobs(COALESCE(agent,''),COALESCE(project_id,''),COALESCE(session_id,'')) WHERE state='running'",
    "CREATE INDEX IF NOT EXISTS idx_transcript_reread_running ON transcript_reread_jobs(created_at,id) WHERE state='running'",
    'ALTER TABLE orphan_sweep_state ADD COLUMN armed_at INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE orphan_sweep_state ADD COLUMN next_pass_at INTEGER NOT NULL DEFAULT 0',
    `CREATE TRIGGER IF NOT EXISTS search_revision_turn_session_tombstones_update AFTER UPDATE OF project_id,session_id ON session_tombstones
      WHEN (OLD.project_id IS NOT NEW.project_id OR OLD.session_id IS NOT NEW.session_id) BEGIN UPDATE search_revisions SET revision = revision + 1 WHERE kind = 'turn'; END`,
    "CREATE TRIGGER IF NOT EXISTS search_revision_turn_session_tombstones_insert AFTER INSERT ON session_tombstones BEGIN UPDATE search_revisions SET revision = revision + 1 WHERE kind = 'turn'; END",
    "CREATE TRIGGER IF NOT EXISTS search_revision_turn_session_tombstones_delete AFTER DELETE ON session_tombstones BEGIN UPDATE search_revisions SET revision = revision + 1 WHERE kind = 'turn'; END",
    `CREATE TRIGGER IF NOT EXISTS search_revision_plan_session_tombstones_update AFTER UPDATE OF project_id,session_id ON session_tombstones
      WHEN (OLD.project_id IS NOT NEW.project_id OR OLD.session_id IS NOT NEW.session_id) BEGIN UPDATE search_revisions SET revision = revision + 1 WHERE kind = 'plan'; END`,
    "CREATE TRIGGER IF NOT EXISTS search_revision_plan_session_tombstones_insert AFTER INSERT ON session_tombstones BEGIN UPDATE search_revisions SET revision = revision + 1 WHERE kind = 'plan'; END",
    "CREATE TRIGGER IF NOT EXISTS search_revision_plan_session_tombstones_delete AFTER DELETE ON session_tombstones BEGIN UPDATE search_revisions SET revision = revision + 1 WHERE kind = 'plan'; END",
    'DROP INDEX IF EXISTS idx_session_tombstones_created',
  ] },
];

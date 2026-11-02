import { SESSION_PATHS_LIMIT } from './document-tables.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

/** Catalog summaries and bounded catch-up progress for session tools and cards. */
const STATEMENTS: readonly string[] = [
  'ALTER TABLE session_prompts ADD COLUMN failed_tools INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_prompts ADD COLUMN myco_calls INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_prompts ADD COLUMN files_named INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_prompts ADD COLUMN tool_rollup TEXT',
  'ALTER TABLE session_prompts ADD COLUMN tool_state TEXT',
  'ALTER TABLE session_prompts ADD COLUMN rollup_build TEXT',
  'ALTER TABLE session_prompts ADD COLUMN tool_revision INTEGER NOT NULL DEFAULT 0',
  'DROP INDEX IF EXISTS idx_session_prompts_turns',
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_turns ON session_prompts (project_id,session_id,generation,ord,prompt_id) WHERE turn_key = prompt_id`,
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_user_turns ON session_prompts (project_id,session_id,generation,ord,prompt_id) WHERE turn_key = prompt_id AND origin='user'`,
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_failed ON session_prompts (project_id,session_id,generation,ord,prompt_id)
    WHERE turn_key = prompt_id AND failed_tools > 0`,
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_myco ON session_prompts (project_id,session_id,generation,ord,prompt_id)
    WHERE turn_key = prompt_id AND myco_calls > 0`,
  'ALTER TABLE turn_cards ADD COLUMN headline TEXT',
  'ALTER TABLE turn_cards ADD COLUMN marks TEXT',
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_key ON turn_cards (project_id,session_id,created_at,turn_key) WHERE signal = 'high'`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_headline ON turn_cards (project_id,session_id,turn_key) WHERE card IS NOT NULL AND headline IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_reuse ON turn_cards (project_id,session_id,input_hash,covered DESC,turn_key) WHERE card IS NOT NULL`,
  'ALTER TABLE session_paths ADD COLUMN edits INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_paths ADD COLUMN last_turn TEXT',
  'ALTER TABLE session_documents ADD COLUMN files_edited INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN myco_calls INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN myco_build INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN rollup_after INTEGER',
  'ALTER TABLE session_documents ADD COLUMN rollup_page INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN rollup_record INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN rollup_epoch INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN paths_build TEXT',
  'ALTER TABLE session_documents ADD COLUMN paths_capped INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN paths_count INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN rollup_due INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE session_documents ADD COLUMN rollup_failure TEXT',
  'ALTER TABLE session_documents ADD COLUMN rollup_checked INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE session_turn_totals(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,generation INTEGER NOT NULL,owner TEXT NOT NULL,
    files INTEGER NOT NULL DEFAULT 0,named INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,session_id,generation,owner))`,
  `CREATE TABLE session_turn_entries(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,generation INTEGER NOT NULL,owner TEXT NOT NULL,
    kind TEXT NOT NULL,name TEXT NOT NULL,n INTEGER NOT NULL,failed INTEGER NOT NULL,at INTEGER NOT NULL,text TEXT,
    PRIMARY KEY(project_id,session_id,generation,owner,kind,name))`,
  `CREATE TABLE session_path_build(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,generation INTEGER NOT NULL,path TEXT NOT NULL,
    calls INTEGER NOT NULL,edits INTEGER NOT NULL,at INTEGER NOT NULL,turn TEXT,PRIMARY KEY(project_id,session_id,generation,path))`,
  'CREATE INDEX IF NOT EXISTS idx_session_turn_entries_count ON session_turn_entries(project_id,session_id,generation,owner,kind,n DESC,name) WHERE kind IN (\'tool\',\'myco\')',
  'CREATE INDEX IF NOT EXISTS idx_session_turn_entries_error ON session_turn_entries(project_id,session_id,generation,owner,kind,at,name) WHERE kind=\'error\'',
  `CREATE TRIGGER session_turn_entries_insert AFTER INSERT ON session_turn_entries WHEN NEW.kind IN ('file','named') BEGIN
    UPDATE session_turn_totals SET files=files+(NEW.kind='file'),named=named+(NEW.kind='named')
    WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND generation=NEW.generation AND owner=NEW.owner; END`,
  `CREATE TRIGGER session_turn_entries_delete AFTER DELETE ON session_turn_entries WHEN OLD.kind IN ('file','named') BEGIN
    UPDATE session_turn_totals SET files=files-(OLD.kind='file'),named=named-(OLD.kind='named')
    WHERE project_id=OLD.project_id AND session_id=OLD.session_id AND generation=OLD.generation AND owner=OLD.owner; END`,
  `CREATE TABLE IF NOT EXISTS session_edit_paths(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
    generation INTEGER NOT NULL,path TEXT NOT NULL,PRIMARY KEY(project_id,session_id,generation,path))`,
  `UPDATE session_documents SET rollup_after = -1,paths_count=(SELECT COUNT(*) FROM session_paths p
    WHERE p.project_id=session_documents.project_id AND p.session_id=session_documents.session_id AND p.generation=session_documents.generation)`,
  `CREATE INDEX IF NOT EXISTS idx_session_documents_rollup ON session_documents (rollup_due,rollup_checked,project_id,session_id) WHERE rollup_after IS NOT NULL AND state='live'`,
  `CREATE INDEX IF NOT EXISTS idx_session_chunks_pages ON session_chunks (project_id,session_id,generation,chunk_no) WHERE kind='page'`,
  `CREATE TRIGGER session_paths_cap BEFORE INSERT ON session_paths
    WHEN NOT EXISTS (SELECT 1 FROM session_paths WHERE project_id=NEW.project_id AND session_id=NEW.session_id AND generation=NEW.generation AND path=NEW.path)
      AND (SELECT paths_count FROM session_documents WHERE project_id=NEW.project_id AND session_id=NEW.session_id) >= ${SESSION_PATHS_LIMIT}
    BEGIN UPDATE session_documents SET paths_capped=1 WHERE project_id=NEW.project_id AND session_id=NEW.session_id
      AND (generation=NEW.generation OR generation IS NULL) AND paths_capped=0; SELECT RAISE(IGNORE); END`,
  `CREATE TRIGGER session_paths_insert AFTER INSERT ON session_paths BEGIN
    UPDATE session_documents SET paths_count=paths_count+1 WHERE project_id=NEW.project_id AND session_id=NEW.session_id
      AND (generation=NEW.generation OR generation IS NULL); END`,
  `CREATE TRIGGER session_paths_delete AFTER DELETE ON session_paths BEGIN
    UPDATE session_documents SET paths_count=paths_count-1 WHERE project_id=OLD.project_id AND session_id=OLD.session_id
      AND (generation=OLD.generation OR generation IS NULL); END`,
  `CREATE TRIGGER session_edit_paths_insert AFTER INSERT ON session_edit_paths BEGIN
    UPDATE session_documents SET files_edited=files_edited+1 WHERE project_id=NEW.project_id AND session_id=NEW.session_id
      AND (generation=NEW.generation OR generation IS NULL); END`,
  `CREATE TRIGGER session_edit_paths_delete AFTER DELETE ON session_edit_paths BEGIN
    UPDATE session_documents SET files_edited=files_edited-1 WHERE project_id=OLD.project_id AND session_id=OLD.session_id
      AND (generation=OLD.generation OR generation IS NULL); END`,
];

/** Each existing-table index build has its own deployment transaction. */
const indexes = STATEMENTS.filter(sql => sql.startsWith('CREATE INDEX') && !sql.includes('ON session_turn_entries'));
export const V121_STATEMENTS = STATEMENTS.filter(sql => !indexes.includes(sql) && !sql.startsWith('DROP INDEX'));
export const UX_SCHEMA_STEPS = [
  { version: 121, statements: V121_STATEMENTS },
  ...indexes.map((sql, at) => ({ version: 122 + at, statements: [
    ...(sql.includes('idx_session_prompts_turns ON') ? ['DROP INDEX IF EXISTS idx_session_prompts_turns'] : []), sql,
  ] })),
];

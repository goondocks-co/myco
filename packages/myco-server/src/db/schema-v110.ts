import { PROJECT_ID_GRAMMAR } from './project-id.js';

/** An open turn falls due for its card once nothing has been recorded in it for this long. */
export const TURN_QUIET_MS = 600_000;

const project = `project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR})`;

/** The card of the turn a record belongs to is due again when the record changes. */
function turnChangedTrigger(table: string, operation: 'INSERT' | 'UPDATE', columns = '', when = 'NEW.prompt_id IS NOT NULL'): string {
  return `CREATE TRIGGER IF NOT EXISTS ${table}_turn_card_${operation.toLowerCase()}
    AFTER ${operation}${columns === '' ? '' : ` OF ${columns}`} ON ${table} WHEN ${when} BEGIN
    UPDATE turn_cards SET state = 'pending', changes = changes + 1, due_at = MAX(COALESCE(due_at, 0), NEW.created_at + ${TURN_QUIET_MS})
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id AND turn_key = COALESCE((SELECT p.parent_prompt_id
        FROM prompt_batches p WHERE p.project_id = NEW.project_id AND p.prompt_id = NEW.prompt_id), NEW.prompt_id); END`;
}

/**
 * Two-stage learning: a session's learning progress, and one card per turn. A top-level prompt opens a turn; the
 * previous turn of its session is due for carding at once, and an open turn falls due after it has been quiet. A
 * record written into a carded turn makes that card due again.
 */
export const V110_STATEMENTS: readonly string[] = [
  ...[
    'learned_seq INTEGER NOT NULL DEFAULT 0',
    `init_state TEXT NOT NULL DEFAULT 'pending' CHECK (init_state IN ('pending','awaiting_publication','ready'))`,
    'eligible_at INTEGER',
    'pending_cards INTEGER NOT NULL DEFAULT 0',
    'due_cards INTEGER NOT NULL DEFAULT 0',
    'failures INTEGER NOT NULL DEFAULT 0',
    'skipped_by_owner INTEGER NOT NULL DEFAULT 0',
    'handoff TEXT CHECK (handoff IS NULL OR length(CAST(handoff AS BLOB)) <= 4096)',
    'carded_seq INTEGER NOT NULL DEFAULT 0',
    'last_completed_at INTEGER',
    'last_completed_reason TEXT',
  ].map((column) => `ALTER TABLE learning_sessions ADD COLUMN ${column}`),
  `CREATE INDEX IF NOT EXISTS idx_learning_eligible ON learning_sessions (project_id, eligible_at)`,
  `CREATE INDEX IF NOT EXISTS idx_learning_eligible_all ON learning_sessions (eligible_at)`,
  `CREATE INDEX IF NOT EXISTS idx_learning_init_walk ON session_read_facts (last_received_at DESC, project_id DESC, session_id DESC)
    WHERE has_session = 1 AND tombstoned = 0`,
  `CREATE INDEX IF NOT EXISTS idx_learning_completed ON learning_sessions (last_completed_at) WHERE last_completed_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_learning_init_pending ON learning_sessions (project_id, session_id) WHERE init_state <> 'ready'`,
  `CREATE TABLE IF NOT EXISTS turn_cards (${project}, session_id TEXT NOT NULL, turn_key TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','carded')), changes INTEGER NOT NULL DEFAULT 0,
    due_at INTEGER, claimed_until INTEGER,
    first_seq INTEGER, last_seq INTEGER, records TEXT,
    input_hash TEXT, input_chars INTEGER, raw_chars INTEGER,
    card TEXT, signal TEXT CHECK (signal IS NULL OR signal IN ('none','low','high')), signal_reason TEXT,
    shared_with TEXT, covered INTEGER NOT NULL DEFAULT 0 CHECK (covered IN (0,1)),
    run_id TEXT, model TEXT, created_at INTEGER NOT NULL, carded_at INTEGER,
    PRIMARY KEY (project_id, session_id, turn_key))`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_due ON turn_cards (project_id, due_at) WHERE state = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_due_all ON turn_cards (due_at) WHERE state = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_uncovered ON turn_cards (project_id, session_id, created_at) WHERE state = 'carded' AND covered = 0`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_hash ON turn_cards (project_id, session_id, input_hash)`,
  `CREATE TRIGGER IF NOT EXISTS prompt_batches_learning_session AFTER INSERT ON prompt_batches
    WHEN EXISTS (SELECT 1 FROM schema_meta WHERE key = 'learning_resumed_at') BEGIN
    INSERT OR IGNORE INTO learning_sessions (project_id, session_id) VALUES (NEW.project_id, NEW.session_id); END`,
  `CREATE TRIGGER IF NOT EXISTS prompt_batches_turn_card_open AFTER INSERT ON prompt_batches
    WHEN NEW.parent_prompt_id IS NULL AND EXISTS (SELECT 1 FROM learning_sessions l
      WHERE l.project_id = NEW.project_id AND l.session_id = NEW.session_id AND l.init_state = 'ready') BEGIN
    UPDATE turn_cards SET due_at = MIN(COALESCE(due_at, NEW.created_at), NEW.created_at)
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id AND state = 'pending' AND created_at <= NEW.created_at;
    INSERT OR IGNORE INTO turn_cards (project_id, session_id, turn_key, due_at, created_at)
      VALUES (NEW.project_id, NEW.session_id, NEW.prompt_id, NEW.created_at + ${TURN_QUIET_MS}, NEW.created_at);
    UPDATE learning_sessions SET eligible_at = NULL, pending_cards = (SELECT COUNT(*) FROM turn_cards c
      WHERE c.project_id = NEW.project_id AND c.session_id = NEW.session_id AND c.state = 'pending')
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
  turnChangedTrigger('prompt_batches', 'INSERT', '', 'NEW.parent_prompt_id IS NOT NULL'),
  turnChangedTrigger('prompt_batches', 'UPDATE', 'text,content_hash'),
  turnChangedTrigger('responses', 'INSERT'),
  turnChangedTrigger('tool_calls', 'INSERT'),
  turnChangedTrigger('tool_calls', 'UPDATE', 'output_preview,success,error_message'),
  turnChangedTrigger('plans', 'INSERT'),
  turnChangedTrigger('plans', 'UPDATE', 'content_hash,status'),
  `CREATE TRIGGER IF NOT EXISTS turn_cards_pending_count AFTER UPDATE OF state ON turn_cards WHEN OLD.state <> NEW.state BEGIN
    UPDATE learning_sessions SET pending_cards = pending_cards + CASE WHEN NEW.state = 'pending' THEN 1 ELSE -1 END,
      eligible_at = CASE WHEN NEW.state = 'pending' THEN NULL ELSE eligible_at END
      WHERE project_id = NEW.project_id AND session_id = NEW.session_id; END`,
];

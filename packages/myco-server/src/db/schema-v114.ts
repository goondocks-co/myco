/** How long the publisher may take over new capture; bytes or an event received this long ago must be published. */
export const DOCUMENTS_GUARD_GRACE_MS = 15 * 60_000;
export const DOCUMENTS_CONVERTING = 'documents_converting';
export const DOCUMENTS_PUBLICATION_BEHIND = 'documents_publication_behind';
export const DOCUMENTS_QUEUE_BEHIND = 'documents_queue_behind';
export const DOCUMENTS_UNLOCATED = 'documents_unlocated';

const quiet = `CAST(strftime('%s','now') AS INTEGER) * 1000 - ${DOCUMENTS_GUARD_GRACE_MS}`;
const now = `CAST(strftime('%s','now') AS INTEGER) * 1000`;
const live = `t.project_id = s.project_id AND t.session_id = s.session_id`;
/** The bytes of a transcript received before the grace: those below its first segment received within it. */
const settled = `COALESCE((SELECT MIN(g.base_offset) FROM transcript_segments g WHERE g.project_id = t.project_id
          AND g.transcript_id = t.transcript_id AND g.received_at >= ${quiet}), t.size)`;
/** Whether the publisher's own frontier has consumed a transcript's bytes up to `offset`; a transcript it never published has consumed none. */
const covers = (offset: string) => `(p.transcript_id IS NOT NULL AND (p.published_offset >= ${offset}
          OR (p.state = 'awaiting' AND COALESCE(p.awaited_size, -1) >= ${offset})))`;

/**
 * Readers move to documents. The step refuses while any session still waits for conversion, while any transcript's
 * publisher stands behind the bytes received before the grace or behind newer bytes with its session not due, while a
 * queued member event received before the grace is unpublished, or while any prompt of a live document has no page
 * locator. A transcript with no publication row is behind, and a publisher waiting on a partial record has consumed
 * every byte up to the size it waited at. Turn cards gain full-text search, a prompt is found by its id alone, prompts
 * are measured by time, a prompt's latest receipt is found without reading its others, a prompt's attachments and
 * context answers are read in their full order, and a converting session records the restore that holds it from
 * conversion.
 */
export const V114_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS _v114_guard_documents (
    converting INTEGER NOT NULL CONSTRAINT ${DOCUMENTS_CONVERTING} CHECK (converting = 0),
    behind INTEGER NOT NULL CONSTRAINT ${DOCUMENTS_PUBLICATION_BEHIND} CHECK (behind = 0),
    queued INTEGER NOT NULL CONSTRAINT ${DOCUMENTS_QUEUE_BEHIND} CHECK (queued = 0),
    unlocated INTEGER NOT NULL CONSTRAINT ${DOCUMENTS_UNLOCATED} CHECK (unlocated = 0))`,
  `INSERT INTO _v114_guard_documents (converting, behind, queued, unlocated) SELECT
    (SELECT COUNT(*) FROM session_documents d WHERE d.state <> 'live'
      AND NOT EXISTS (SELECT 1 FROM session_tombstones x WHERE x.project_id = d.project_id AND x.session_id = d.session_id)),
    (SELECT COUNT(*) FROM transcripts t JOIN sessions s ON ${live}
      LEFT JOIN session_documents d ON d.project_id = t.project_id AND d.session_id = t.session_id AND d.state = 'live'
      LEFT JOIN transcript_publication p ON p.project_id = t.project_id AND p.transcript_id = t.transcript_id AND p.generation = d.generation
      WHERE NOT EXISTS (SELECT 1 FROM session_tombstones x WHERE x.project_id = t.project_id AND x.session_id = t.session_id)
        AND (NOT ${covers(settled)} OR (NOT ${covers('t.size')} AND (d.due_at IS NULL OR d.due_at > ${now})))),
    (SELECT COUNT(*) FROM publish_queue q JOIN events e ON e.project_id = q.project_id AND e.event_id = q.event_id
      WHERE e.received_at < ${quiet}),
    (SELECT COUNT(*) FROM session_prompts p INDEXED BY idx_session_prompts_unlocated JOIN session_documents d
      ON d.project_id = p.project_id AND d.session_id = p.session_id AND d.generation = p.generation AND d.state = 'live'
      WHERE p.page IS NULL)`,
  'DROP TABLE _v114_guard_documents',
  'ALTER TABLE session_documents ADD COLUMN restore_hold TEXT',
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_prompt ON session_prompts (project_id, prompt_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_created ON session_prompts (project_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_prompt_order ON attachments (project_id, session_id, prompt_id, created_at, attachment_id)`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_context_answers_prompt_order ON prompt_context_answers (project_id, session_id, prompt_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_spore_injections_delivered_at ON spore_injections (project_id, session_id, delivered_prompt_id, created_at)
    WHERE delivered_prompt_id IS NOT NULL`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS turn_cards_fts USING fts5(card, content='turn_cards', content_rowid='rowid')`,
  `CREATE TRIGGER IF NOT EXISTS turn_cards_fts_ai AFTER INSERT ON turn_cards BEGIN
    INSERT INTO turn_cards_fts(rowid, card) VALUES (new.rowid, new.card); END`,
  `CREATE TRIGGER IF NOT EXISTS turn_cards_fts_au AFTER UPDATE OF rowid, card ON turn_cards BEGIN
    INSERT INTO turn_cards_fts(turn_cards_fts, rowid, card) VALUES ('delete', old.rowid, old.card);
    INSERT INTO turn_cards_fts(rowid, card) VALUES (new.rowid, new.card); END`,
  `CREATE TRIGGER IF NOT EXISTS turn_cards_fts_ad AFTER DELETE ON turn_cards BEGIN
    INSERT INTO turn_cards_fts(turn_cards_fts, rowid, card) VALUES ('delete', old.rowid, old.card); END`,
  `INSERT INTO turn_cards_fts(turn_cards_fts) VALUES ('rebuild')`,
];

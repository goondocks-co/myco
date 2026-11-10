import { reaching, type Reach, changing } from './schema-step.js';
/**
 * Readers move to documents. Turn cards gain full-text search, a prompt is found by its id alone, prompts are measured
 * by time, a prompt's latest receipt is found without reading its others, a prompt's attachments and context answers
 * are read in their full order, and a converting session records the restore that holds it from conversion.
 */
export const V114_STATEMENTS: readonly string[] = [
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

/** Why the step reaches tables earlier steps created. */
export const V114_REACHES: readonly Reach[] = [
  ...changing(['session_documents'], 'A restore holds the sessions it converts from conversion, and from other restores, under its own identity.'),
  ...reaching(['session_prompts'], 'A prompt cited by id alone is found in its Project without knowing its session. Prompt measures read a window of prompt times, not every prompt.'),
  ...reaching(['attachments'], 'A turn reads each prompt\'s first page of attachments, however many share a time.'),
  ...reaching(['prompt_context_answers'], 'A turn reads each prompt\'s first page of context answers, however many share a time.'),
  ...reaching(['spore_injections'], 'A turn reads the latest receipt of each of its prompts without reading the others.'),
  ...reaching(['turn_cards'], 'Card search is an external-content index over the cards already written. Card search follows every card written. Card search follows every card rewritten. Card search drops every card deleted.'),
];

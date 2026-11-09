/** Placeholder first step of this change; the coordinator assigns the real numbers at merge. */
export const NEXT_S2B2 = 740;

const PROJECT_ID_GRAMMAR = "project_id NOT GLOB '*[^A-Za-z0-9._-]*' AND length(project_id) BETWEEN 1 AND 64 AND project_id NOT IN ('.', '..')";

/**
 * Card settlement deadlines and prompt locator repair, each large index alone in its transaction.
 *
 * A pending card is promoted once its deadline has passed: `settle_promoted_at` records the deadline it reached, so
 * a card is ready exactly while that equals its `settle_at`, and a publisher write that moves the deadline
 * takes it out of the ready set without touching the column. The deadline index holds the cards not yet promoted; the
 * ready index holds them in source-activity order.
 *
 * Locator repair is a finite queue seeded by a catch-up over the prompts whose page is unknown or recorded as held by
 * none. The queue row holds its own cursor against one generation, so a rebuilt session restarts the walk.
 */
export const CARD_SETTLE_AND_LOCATOR_STEPS: ReadonlyArray<{ version: number; statements: readonly string[] }> = [
  { version: NEXT_S2B2, statements: ['ALTER TABLE turn_cards ADD COLUMN settle_promoted_at INTEGER'] },
  { version: NEXT_S2B2 + 1, statements: [
    `CREATE INDEX IF NOT EXISTS idx_turn_cards_settle_deadline ON turn_cards(settle_at DESC,project_id,session_id,turn_key)
      WHERE state='pending' AND settle_at IS NOT NULL AND settle_promoted_at IS NOT settle_at`,
    'DROP INDEX IF EXISTS idx_turn_cards_settle',
  ] },
  { version: NEXT_S2B2 + 2, statements: [
    `CREATE INDEX IF NOT EXISTS idx_turn_cards_settle_ready ON turn_cards(source_activity_at DESC,project_id,session_id,turn_key,settle_at)
      WHERE state='pending' AND settle_at IS NOT NULL AND settle_promoted_at=settle_at`,
    'DROP INDEX IF EXISTS idx_turn_cards_source_settle',
  ] },
  { version: NEXT_S2B2 + 3, statements: [
    'CREATE INDEX IF NOT EXISTS idx_session_prompts_locator_repair ON session_prompts(project_id,session_id,generation,prompt_id) WHERE page IS NULL OR page=-1',
    'DROP INDEX IF EXISTS idx_session_prompts_unlocated',
  ] },
  { version: NEXT_S2B2 + 4, statements: [
    `CREATE TABLE IF NOT EXISTS document_locator_repair(
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),session_id TEXT NOT NULL,
      generation INTEGER NOT NULL,locate_after INTEGER,due_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id,session_id)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_document_locator_repair_due ON document_locator_repair(due_at,project_id,session_id)',
    `INSERT INTO projection_catchup(projection,phase,done) SELECT 'document_locators','documentLocators',
      NOT EXISTS(SELECT 1 FROM session_prompts INDEXED BY idx_session_prompts_locator_repair WHERE page IS NULL OR page=-1) ON CONFLICT DO NOTHING`,
  ] },
];

export const LATEST_S2B2 = NEXT_S2B2 + CARD_SETTLE_AND_LOCATOR_STEPS.length - 1;

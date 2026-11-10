import { builtOn, reaching, type SchemaStep, changing } from './schema-step.js';
/** Source activity remains independent of settlement, eligibility and retry deadlines. */
const setup = [
  'ALTER TABLE turn_cards ADD COLUMN source_activity_at INTEGER',
  'ALTER TABLE learning_sessions ADD COLUMN source_activity_at INTEGER',
  'CREATE TABLE IF NOT EXISTS _learning_source_ranges (cards_high INTEGER NOT NULL, sessions_high INTEGER NOT NULL)',
  `INSERT INTO _learning_source_ranges SELECT COALESCE((SELECT MAX(rowid) FROM turn_cards),0),
    COALESCE((SELECT MAX(rowid) FROM learning_sessions),0)`,
  `CREATE TRIGGER IF NOT EXISTS session_documents_learning_activity AFTER UPDATE OF last_record_at ON session_documents
    WHEN NEW.last_record_at IS NOT OLD.last_record_at BEGIN
      UPDATE learning_sessions SET source_activity_at=NEW.last_record_at
        WHERE project_id=NEW.project_id AND session_id=NEW.session_id; END`,
];

const PARTS = 32;
const range = (high: string, part: number): string =>
  `rowid > ((SELECT ${high} FROM _learning_source_ranges)/${PARTS})*${part}${part === PARTS - 1 ? ''
    : ` AND rowid <= ((SELECT ${high} FROM _learning_source_ranges)/${PARTS})*${part + 1}`}`;

/** Existing cards use their session's recorded source activity; no readiness clock supplies recency. */
const cards = Array.from({ length: PARTS }, (_, part) => [
  `UPDATE turn_cards SET source_activity_at=COALESCE((SELECT d.last_record_at FROM session_documents d
    WHERE d.project_id=turn_cards.project_id AND d.session_id=turn_cards.session_id),created_at)
    WHERE ${range('cards_high', part)}`,
]);
const sessions = Array.from({ length: PARTS }, (_, part) => [
  `UPDATE learning_sessions SET source_activity_at=(SELECT d.last_record_at FROM session_documents d
    WHERE d.project_id=learning_sessions.project_id AND d.session_id=learning_sessions.session_id)
    WHERE ${range('sessions_high', part)}`,
]);

const indexes = [
  `CREATE INDEX IF NOT EXISTS idx_learning_source_activity ON learning_sessions (project_id,source_activity_at DESC,session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_turn_cards_source_settle ON turn_cards (source_activity_at DESC,project_id,session_id,turn_key,settle_at)
    WHERE state='pending' AND settle_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_learning_source_eligible ON learning_sessions (project_id,source_activity_at DESC,session_id,eligible_at)
    WHERE eligible_at IS NOT NULL`,
  'CREATE INDEX IF NOT EXISTS idx_turn_cards_source_missing ON turn_cards (source_activity_at) WHERE source_activity_at IS NULL',
  'CREATE INDEX IF NOT EXISTS idx_learning_source_missing ON learning_sessions (source_activity_at) WHERE source_activity_at IS NULL',
].map(sql => [sql]);

const BACKFILL = 'Learning queue metadata backfills in disjoint rowid transactions while preserving cards and coverage.';
const QUEUES = 'Learning source activity, quiet eligibility and retry deadlines stay in indexed work queues.';
/** The repair indexes a Deployment-wide page reads, each with the read it serves. */
const REPAIR_READS: Readonly<Record<string, string>> = {
  idx_turn_cards_source_missing: 'the source-activity repair advances through bounded pages of cards across Projects',
  idx_learning_source_missing: 'the source-activity repair advances through bounded pages of sessions across Projects',
};

/** Source timestamps backfill in disjoint rowid transactions, preserving cards, coverage and retry deadlines. */
export const LEARNING_SOURCE_STEPS: readonly SchemaStep[] = [
  { statements: setup, reaches: [...changing(['turn_cards', 'learning_sessions'], BACKFILL), ...reaching(['session_documents'], QUEUES)] },
  ...cards.map((statements) => ({ statements, reaches: changing(['turn_cards'], BACKFILL) })),
  ...sessions.map((statements) => ({ statements, reaches: changing(['learning_sessions'], BACKFILL) })),
  ...indexes.map((statements) => {
    const index = /INDEX IF NOT EXISTS (\w+)/.exec(statements[0]!)![1]!;
    const read = REPAIR_READS[index];
    return { statements, reaches: reaching([builtOn(statements[0]!)], QUEUES), ...(read === undefined ? {} : { deploymentIndexes: [{ index, read }] }) };
  }),
  { statements: ['DROP TABLE _learning_source_ranges'] },
].map((step, index) => ({ version: 546 + index, ...step }));

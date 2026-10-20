import { PROJECT_ID_GRAMMAR } from './project-id.js';

/**
 * Schema v91: where each parsed prompt's identity comes from. A prompt a parser derives under a scheme that keys every
 * record of its transcript (claude-v2) records how it holds its harness key (`claim`: it owns the key, reuses an owned
 * one, is another line carrying it, or is harness context), and the key, thread and record it is derived from. The
 * three never change for a prompt id: a second derivation of the id from another source is refused, and recorded once
 * in `prompt_identity_conflicts`, so a count reads it.
 */
export const V91_STATEMENTS: readonly string[] = [
  `ALTER TABLE prompt_batches ADD COLUMN claim TEXT CHECK (claim IN ('owner', 'reused', 'sibling', 'context'))`,
  `ALTER TABLE prompt_batches ADD COLUMN source_key TEXT`,
  `ALTER TABLE prompt_batches ADD COLUMN source_thread TEXT`,
  `ALTER TABLE prompt_batches ADD COLUMN source_record TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_batches_claimed ON prompt_batches (project_id, created_at) WHERE claim IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS prompt_identity_conflicts (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
    session_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_thread TEXT NOT NULL,
    source_record TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id, prompt_id, source_key, source_thread, source_record)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_identity_conflicts_created ON prompt_identity_conflicts (project_id, created_at)`,
];

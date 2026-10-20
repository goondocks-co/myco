import { DECLARED_SCHEMES, promptSchemeBackfillSql } from '../ingest/prompt-scheme.js';

/**
 * Schema v90: each transcript's prompt identity scheme, pinned. `transcripts.prompt_identity_scheme` is backfilled for
 * the rows already held (`promptSchemeBackfillSql`, over the manifests' declarations, which the shipped migration's
 * recorded digest holds as they were) and then never changes: the trigger refuses an update of a set
 * scheme, and only an update of that column, so the segment and parse writes to the same row are untouched.
 * `prompt_batches.prompt_key_hash` is a parsed prompt's key hash (`promptKeyHash`).
 */
export const V90_STATEMENTS: readonly string[] = [
  `ALTER TABLE transcripts ADD COLUMN prompt_identity_scheme TEXT`,
  promptSchemeBackfillSql(DECLARED_SCHEMES),
  `CREATE TRIGGER IF NOT EXISTS transcripts_prompt_identity_scheme_immutable
    BEFORE UPDATE OF prompt_identity_scheme ON transcripts
    WHEN OLD.prompt_identity_scheme IS NOT NULL AND OLD.prompt_identity_scheme IS NOT NEW.prompt_identity_scheme
    BEGIN SELECT RAISE(ABORT, 'a transcript''s prompt identity scheme never changes'); END`,
  `ALTER TABLE prompt_batches ADD COLUMN prompt_key_hash TEXT`,
];

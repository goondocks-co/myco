/**
 * Schema v90: each transcript's prompt identity scheme, pinned. The step backfills `transcripts.prompt_identity_scheme`
 * for the rows held then, per transcript, over the manifests' declarations as the step shipped them, and the column then
 * never changes: the trigger refuses an update of a set scheme, and only an update of that column, so the segment and
 * parse writes to the same row are untouched. `prompt_batches.prompt_key_hash` is a parsed prompt's key hash
 * (`promptKeyHash`).
 *
 * The statements are the shipped step's own, written out: a step that has run on a database never changes, whatever
 * the declarations and the admission policy (`ingest/prompt-scheme.ts`) now say.
 */
export const V90_STATEMENTS: readonly string[] = [
  `ALTER TABLE transcripts ADD COLUMN prompt_identity_scheme TEXT`,
  `UPDATE transcripts SET prompt_identity_scheme = CASE WHEN parser_version > 0 OR parsed_at IS NOT NULL OR parsed_offset > 0
      THEN COALESCE(CASE agent WHEN 'antigravity' THEN 'member-transcript-v1' WHEN 'claude-code' THEN 'claude-v1' WHEN 'cline' THEN 'stamp-or-offset-v1' WHEN 'codex' THEN 'offset-v1' WHEN 'copilot' THEN 'hook-mint-v1' WHEN 'cursor' THEN 'offset-v1' WHEN 'opencode' THEN 'stamp-or-offset-v1' WHEN 'pi' THEN 'offset-v1' WHEN 'windsurf' THEN 'hook-mint-v1' END, CASE agent WHEN 'antigravity' THEN 'member-transcript-v1' WHEN 'claude-code' THEN 'claude-v1' WHEN 'cline' THEN 'stamp-or-offset-v1' WHEN 'codex' THEN 'codex-turn-v1' WHEN 'copilot' THEN 'hook-mint-v1' WHEN 'cursor' THEN 'offset-v1' WHEN 'opencode' THEN 'stamp-or-offset-v1' WHEN 'pi' THEN 'offset-v1' WHEN 'windsurf' THEN 'hook-mint-v1' END) ELSE CASE agent WHEN 'antigravity' THEN 'member-transcript-v1' WHEN 'claude-code' THEN 'claude-v1' WHEN 'cline' THEN 'stamp-or-offset-v1' WHEN 'codex' THEN 'codex-turn-v1' WHEN 'copilot' THEN 'hook-mint-v1' WHEN 'cursor' THEN 'offset-v1' WHEN 'opencode' THEN 'stamp-or-offset-v1' WHEN 'pi' THEN 'offset-v1' WHEN 'windsurf' THEN 'hook-mint-v1' END END
    WHERE prompt_identity_scheme IS NULL AND agent IS NOT NULL`,
  `CREATE TRIGGER IF NOT EXISTS transcripts_prompt_identity_scheme_immutable
    BEFORE UPDATE OF prompt_identity_scheme ON transcripts
    WHEN OLD.prompt_identity_scheme IS NOT NULL AND OLD.prompt_identity_scheme IS NOT NEW.prompt_identity_scheme
    BEGIN SELECT RAISE(ABORT, 'a transcript''s prompt identity scheme never changes'); END`,
  `ALTER TABLE prompt_batches ADD COLUMN prompt_key_hash TEXT`,
];

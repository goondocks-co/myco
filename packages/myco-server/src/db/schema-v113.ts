/**
 * A prompt's catalog row records the page of its owner that holds its record, so a prompt read by name opens that page.
 * The publisher and conversion write it for every prompt on every page they lay out; a document written before this
 * step has its prompts located by the publisher's backfill, which resumes after the last page chunk it read
 * (`session_documents.locate_after`) and finds the prompts still unlocated through their own index.
 */
export const V113_STATEMENTS: readonly string[] = [
  'ALTER TABLE session_prompts ADD COLUMN page INTEGER',
  'ALTER TABLE session_documents ADD COLUMN locate_after INTEGER',
  `CREATE INDEX IF NOT EXISTS idx_session_prompts_unlocated ON session_prompts (project_id, session_id, generation) WHERE page IS NULL`,
];

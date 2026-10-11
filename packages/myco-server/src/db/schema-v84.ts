import { PROJECT_ID_GRAMMAR } from './project-id.js';

/** Every answered prompt-context request, including empty answers and contributor failures. */
export const V84_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS prompt_context_answers (
    project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),
    session_id TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('served', 'empty')),
    context_chars INTEGER NOT NULL CHECK (context_chars >= 0),
    parts TEXT NOT NULL,
    skipped TEXT NOT NULL,
    failures TEXT NOT NULL,
    selection TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, session_id, prompt_id, id))`,
  `CREATE INDEX IF NOT EXISTS idx_prompt_context_answers_created ON prompt_context_answers (project_id, created_at)`,
];

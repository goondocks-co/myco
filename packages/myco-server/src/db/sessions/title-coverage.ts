/** The canonical last turn's publication revision. */
export const titleTurnRevisionSql = (document: string): string => `(SELECT p.tool_revision FROM session_prompts p
  WHERE p.project_id=${document}.project_id AND p.session_id=${document}.session_id AND p.generation=${document}.generation AND p.prompt_id=${document}.open_turn_key)`;

/** A title covers the last published turn and the work recorded under it. */
export const titleBehindSql = (session: string, document: string): string => `${session}.title IS NOT NULL AND ${document}.state='live'
  AND ${document}.title_tracking=1 AND ${document}.open_turn_key IS NOT NULL
  AND (${session}.title_through_turn_key IS NOT ${document}.open_turn_key OR ${session}.title_through_turn_revision IS NOT ${titleTurnRevisionSql(document)})`;

/** A retry reservation belongs to one turn revision. */
export const titleAttemptedSql = (session: string, document: string): string => `(${session}.title_attempt_turn_key IS ${document}.open_turn_key
  AND ${session}.title_attempt_turn_revision IS ${titleTurnRevisionSql(document)})`;

/** The live generation of a session's document, as a scalar subquery over `project` and `session` expressions. */
export const liveGenerationSql = (project: string, session: string): string =>
  `(SELECT generation FROM session_documents WHERE project_id = ${project} AND session_id = ${session} AND state = 'live')`;

/** True when a prompt of that id sits in the session's live document; the expressions name the hint being placed. */
export function placedPromptSql(hint: { project: string; session: string; prompt: string }): string {
  return `EXISTS (SELECT 1 FROM session_prompts placed WHERE placed.project_id = ${hint.project} AND placed.session_id = ${hint.session}
    AND placed.generation = ${liveGenerationSql(hint.project, hint.session)} AND placed.prompt_id = ${hint.prompt})`;
}

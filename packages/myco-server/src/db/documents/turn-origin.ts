/** A session's opening turn, read as `alias`: the first prompt of the given generation that opens a turn. */
export const openingTurnSql = (alias: string, project: string, session: string, generation: string): string =>
  `FROM session_prompts ${alias} WHERE ${alias}.project_id=${project} AND ${alias}.session_id=${session} AND ${alias}.generation=${generation}
 AND ${alias}.turn_key=${alias}.prompt_id ORDER BY ${alias}.ord,${alias}.prompt_id LIMIT 1`;

/** Captured launch lineage assigns only the opening turn to another agent. */
export const turnOriginSql = (prompt: string): string => `CASE WHEN
 EXISTS(SELECT 1 FROM sessions launch WHERE launch.project_id=${prompt}.project_id AND launch.session_id=${prompt}.session_id AND launch.launch_parent_session_id IS NOT NULL)
 AND ${prompt}.prompt_id=(SELECT opening.prompt_id ${openingTurnSql('opening', `${prompt}.project_id`, `${prompt}.session_id`, `${prompt}.generation`)})
 THEN 'agent_dispatch' ELSE ${prompt}.origin END`;

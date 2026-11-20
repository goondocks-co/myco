/** Captured launch lineage assigns only the opening turn to another agent. */
export const turnOriginSql = (prompt: string): string => `CASE WHEN
 EXISTS(SELECT 1 FROM sessions launch WHERE launch.project_id=${prompt}.project_id AND launch.session_id=${prompt}.session_id AND launch.launch_parent_session_id IS NOT NULL)
 AND ${prompt}.prompt_id=(SELECT opening.prompt_id FROM session_prompts opening
 WHERE opening.project_id=${prompt}.project_id AND opening.session_id=${prompt}.session_id AND opening.generation=${prompt}.generation
 AND opening.turn_key=opening.prompt_id ORDER BY opening.ord,opening.prompt_id LIMIT 1)
 THEN 'agent_dispatch' ELSE ${prompt}.origin END`;

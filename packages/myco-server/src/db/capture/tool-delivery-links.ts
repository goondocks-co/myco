import { write, type Bound } from '../index.js';
import { jsonPages } from '../json-pages.js';

const TABLES = ['spore_injections', 'prompt_context_answers', 'session_injections'] as const;
export type DeliveryTable = (typeof TABLES)[number];
type LinkParams = [project: string, session: string, links: string];

const retain = write<LinkParams>({ name: 'contextLinks.retain', sql: `INSERT INTO tool_prompt_links(project_id,session_id,tool_call_id,prompt_id)
  SELECT ?1,?2,json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?3) WHERE true
  ON CONFLICT(project_id,session_id,tool_call_id) DO UPDATE SET prompt_id=excluded.prompt_id
    WHERE tool_prompt_links.prompt_id<>excluded.prompt_id` });

const resolutions = TABLES.map(table => write<LinkParams>({ name: `contextLinks.resolve.${table.replaceAll('_', '')}`, sql: `
  UPDATE ${table} AS r SET delivered_prompt_id=l.prompt_id,delivered_scope_reason=NULL
  FROM json_each(?3) j JOIN tool_prompt_links l ON l.project_id=?1 AND l.session_id=?2 AND l.tool_call_id=j.value
  JOIN context_delivery_anchors a ON a.project_id=l.project_id AND a.session_id=l.session_id AND a.tool_call_id=l.tool_call_id AND a.kind='${table}'
  WHERE r.project_id=?1 AND r.session_id=?2 AND r.${table === 'session_injections' ? 'kind' : 'id'}=a.record_id
    AND r.delivered_at IS NOT NULL AND r.delivered_prompt_id IS NULL AND r.delivered_scope_reason='transcript_only'` }));

/** Resolve only delivered records anchored to these canonical tool ids, in their writer's transaction. */
export function resolveToolDeliveries(project: string, session: string, toolCallIds: readonly string[]): Bound[] {
  return jsonPages(toolCallIds).flatMap(page => resolutions.map(statement => statement.bind(project, session, JSON.stringify(page))));
}

/** Publish exact native request-to-prompt evidence and place previously delivered context atomically. */
export function toolPromptLinkStatements(project: string, session: string, links: ReadonlyMap<string, string>): Bound[] {
  return jsonPages([...links]).flatMap(page => [
    retain.bind(project, session, JSON.stringify(page)),
    ...resolveToolDeliveries(project, session, page.map(([key]) => key)),
  ]);
}

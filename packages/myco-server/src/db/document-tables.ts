/** Characters a catalog preview of a prompt keeps. */
export const DOCUMENT_PREVIEW_CHARS = 160;

/** Session-owned document catalog rows, each carrying `session_id`. */
export const DOCUMENT_SESSION_TABLES = [
  'session_documents', 'session_chunks', 'retired_objects', 'session_pages', 'session_sealed_records', 'session_prompts',
  'transcript_publication', 'publish_queue', 'session_paths', 'myco_tool_calls',
] as const;

/** Immutable document directories and publisher frontiers carried by portable backups. */
export const DOCUMENT_ARTIFACT_TABLES = ['session_documents','session_chunks','transcript_publication'] as const;

/** The event kinds a document holds as records; a member event of one is queued for publication. */
export const DOCUMENT_EVENT_KINDS: readonly string[] = ['prompt', 'response', 'tool.use', 'tool.failure', 'plan'];

/** Canonical record ids remain readable after their raw bodies are archived. */
export const DOCUMENT_ID_FIELDS: Readonly<Record<string,string>> = {prompt:'promptId',response:'responseId','tool.use':'toolCallId','tool.failure':'toolCallId'};
/** A JSON metadata field, absent when event payload bytes are not JSON. */
export const eventPayloadFieldSql = (field: string, alias = ''): string => `json_extract(CASE WHEN json_valid(${alias}payload) THEN ${alias}payload END,'$.${field}')`;
export const documentRecordIdSql = (alias = ''): string => `CASE ${alias}kind WHEN 'prompt' THEN ${eventPayloadFieldSql('promptId',alias)} WHEN 'response' THEN ${eventPayloadFieldSql('responseId',alias)} ELSE ${eventPayloadFieldSql('toolCallId',alias)} END`;

export const DOCUMENT_IDENTITIES_SQL = `(SELECT project_id,session_id,${documentRecordIdSql()} record_id FROM events WHERE kind IN ('prompt','response','tool.use','tool.failure'))`;

export const ARCHIVED_EVENT_FIELDS = ['promptId','responseId','toolCallId','blob','outputBlob'] as const;
export const archivedEventPayloadSql = (): string => `json_object(${ARCHIVED_EVENT_FIELDS.map(field=>`'${field}',${eventPayloadFieldSql(field)}`).join(',')})`;
export function archivedEventMetadata(payload: Record<string,unknown>): string {
  return JSON.stringify(Object.fromEntries(ARCHIVED_EVENT_FIELDS.map(field=>[field,typeof payload[field]==='string'?payload[field]:null])));
}
export function isArchivedEventMetadata(value: unknown): boolean {
  if(typeof value!=='string')return false;
  let parsed: unknown;
  try { parsed=JSON.parse(value); } catch { return false; }
  return typeof parsed==='object'&&parsed!==null&&!Array.isArray(parsed)&&Object.entries(parsed).every(([key,value])=>
    (ARCHIVED_EVENT_FIELDS as readonly string[]).includes(key)&&(value===null||typeof value==='string'));
}

/** A catalog prompt belongs to its session's live generation. */
export const liveDocumentPromptSql = (row: string): string => `EXISTS (SELECT 1 FROM session_documents d
  WHERE d.project_id=${row}.project_id AND d.session_id=${row}.session_id AND d.generation=${row}.generation AND d.state='live')`;
/** A user prompt without durable coverage, excluding an optional acknowledgement from the check. */
export const documentPromptUnreadSql = (row: string, exceptAck?: string): string => `(${row}.origin IN ('user','unknown')
  AND NOT EXISTS (SELECT 1 FROM extraction_acks a WHERE a.project_id=${row}.project_id AND a.record_id=${row}.prompt_id
    AND a.kind='record'${exceptAck===undefined?'':` AND a.ack_id<>${exceptAck}`}))`;
/** The unread user prompts of the live document. */
export const sessionDocumentUnreadSql = (project: string, session: string): string => `(SELECT COUNT(*) FROM session_prompts p
  WHERE p.project_id=${project} AND p.session_id=${session} AND ${liveDocumentPromptSql('p')} AND ${documentPromptUnreadSql('p')})`;

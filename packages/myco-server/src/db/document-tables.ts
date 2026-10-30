/** Characters a catalog preview of a prompt keeps. */
export const DOCUMENT_PREVIEW_CHARS = 160;

/** Session-owned document catalog rows, each carrying `session_id`. */
export const DOCUMENT_SESSION_TABLES = [
  'session_documents', 'session_chunks', 'retired_objects', 'session_pages', 'session_prompts',
  'transcript_publication', 'publish_queue', 'session_paths', 'myco_tool_calls',
] as const;

/** The event kinds a document holds as records; a member event of one is queued for publication. */
export const DOCUMENT_EVENT_KINDS: readonly string[] = ['prompt', 'response', 'tool.use', 'tool.failure', 'plan'];

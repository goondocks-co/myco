/**
 * Session ID convention utilities.
 *
 * The runtime session ID is a bare UUID (e.g., "abc123").
 * The vault stores it with a "session-" prefix (e.g., "session-abc123").
 * These helpers convert between the two forms.
 */
const SESSION_PREFIX = 'session-';

/** Convert a bare session ID to a vault note ID: "abc123" → "session-abc123" */
export function sessionNoteId(bareId: string): string {
  if (bareId.startsWith(SESSION_PREFIX)) return bareId;
  return `${SESSION_PREFIX}${bareId}`;
}

/** Convert a vault note ID to a bare session ID: "session-abc123" → "abc123" */
export function bareSessionId(noteId: string): string {
  if (noteId.startsWith(SESSION_PREFIX)) return noteId.slice(SESSION_PREFIX.length);
  return noteId;
}

/** Build the relative vault path for a session note */
export function sessionRelativePath(bareId: string, date: string): string {
  return `sessions/${date}/${sessionNoteId(bareId)}.md`;
}


/**
 * A session's title, summary or first prompt, as a list shows it. Text a
 * capture wrapped around what the person typed (`<timestamp>…</timestamp>`,
 * `<user_query>`, `<pasted_content …>`) is taken off the front, and any of those
 * tags left inside is dropped, so a row reads as the words and never the markup.
 */

/** The envelope tags a runtime wraps a prompt in. */
const ENVELOPE_TAG = /<\/?(?:user_query|pasted_content|timestamp|user_info|attached_files|additional_data)\b[^>]*>/gi;
/** A timestamp envelope with its contents, which are never the person's words. */
const TIMESTAMP_BLOCK = /<timestamp\b[^>]*>[\s\S]*?<\/timestamp>/gi;

/** The text without its envelope, on one line; null when nothing is left. */
export function cleanSessionText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const cleaned = text.replace(TIMESTAMP_BLOCK, ' ').replace(ENVELOPE_TAG, ' ').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? null : cleaned;
}

/** How a session is headed: its title, or, untitled, the first line the person typed when there is one. */
export type SessionHeading = { titled: true; title: string } | { titled: false; firstPrompt: string | null };

/**
 * A session's heading. The server's `label` falls back from the title to the
 * first prompt, then to the agent and the id; only the first prompt is worth a
 * reader's eye, so the agent and the id never head a session.
 */
export function sessionHeading(session: { sessionId: string; title: string | null; label: string; agent: string | null }): SessionHeading {
  const title = cleanSessionText(session.title);
  if (title !== null) return { titled: true, title };
  const label = session.label.trim();
  const fallback = label === '' || label === session.sessionId || label === session.agent;
  return { titled: false, firstPrompt: fallback ? null : cleanSessionText(label) };
}

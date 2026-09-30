/**
 * A session's title, summary or first prompt, as a list shows it.
 *
 * A runtime wraps what a person typed in an envelope: a `<timestamp>` block, a
 * `<user_query>` or `<command-name>` tag, a `<pasted_content>` block. Only that
 * envelope is taken off, and only at the very start of the text, one piece at a
 * time; the same markup anywhere else is the person's own words and stays, so
 * "Fix `<user_query>` handling in capture" reads exactly as written.
 */

/** Tags a runtime opens an envelope with. Only the tag goes; the words inside it are the text. */
const ENVELOPE_TAGS = [
  'user_query', 'user-query', 'command-name', 'command-message', 'command-args', 'command-contents',
  'user_info', 'attached_files', 'additional_data', 'local-command-stdout',
] as const;
const ENVELOPE_TAG = new RegExp(`^<(${ENVELOPE_TAGS.join('|')})(?:\\s[^<>]*)?>`, 'i');

/** A leading timestamp block, whose contents are never the person's words: closed, cut off inside, or cut off in its own tag. */
const TIMESTAMP_BLOCK = /^<timestamp\b(?:[^<>]*>[\s\S]*?(?:<\/timestamp\s*>|$)|[^<>]*$)/i;
/** The timestamp tag's opening, and how much of it a cut-off text must keep to be read as that tag. */
const TIMESTAMP_OPEN = '<timestamp';
const TRUNCATED_TAG_MIN = 3;
/** A leading pasted block, closed; the paste is someone else's text, and what follows it is what the person asked. */
const PASTED_BLOCK = /^<pasted_content\b[^<>]*>[\s\S]*?<\/pasted_content\s*>/i;
/** A leading pasted block left unclosed: its tag goes, and the text after it stays, since nothing marks where the paste ends. */
const PASTED_OPEN = /^<pasted_content\b[^<>]*>/i;

/** Takes one piece of envelope off the front of `text`, or answers null when it starts with none. */
function stripOne(text: string): string | null {
  // A text cut off inside the timestamp's own tag name is only envelope.
  if (text.length >= TRUNCATED_TAG_MIN && TIMESTAMP_OPEN.startsWith(text.toLowerCase())) return '';
  for (const block of [TIMESTAMP_BLOCK, PASTED_BLOCK, PASTED_OPEN]) {
    const match = block.exec(text);
    if (match !== null) return text.slice(match[0].length);
  }
  const tag = ENVELOPE_TAG.exec(text);
  if (tag === null) return null;
  // The tag goes with its own close, and the words between them stay; a tag left unclosed goes alone. Envelope that
  // follows a closed tag straight away (a command's name, then its arguments) is the same envelope and goes too.
  const inner = text.slice(tag[0].length);
  const close = new RegExp(`</${tag[1]}\\s*>`, 'i').exec(inner);
  if (close === null) return inner;
  return `${inner.slice(0, close.index)} ${cleanSessionText(inner.slice(close.index + close[0].length)) ?? ''}`;
}

/** The text without its leading envelope, on one line; null when nothing is left. */
export function cleanSessionText(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  let rest = text.trimStart();
  for (let next = stripOne(rest); next !== null; next = stripOne(rest)) rest = next.trimStart();
  const cleaned = rest.replace(/\s+/g, ' ').trim();
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

/** A session's heading as one line of plain text, for a dialog, a label or a nested line. */
export function sessionHeadingText(session: { sessionId: string; title: string | null; label: string; agent: string | null }): string {
  const heading = sessionHeading(session);
  if (heading.titled) return heading.title;
  return heading.firstPrompt === null ? 'Untitled session' : `Untitled: ${heading.firstPrompt}`;
}

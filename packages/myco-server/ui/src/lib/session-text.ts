import { cleanSessionText, UNTITLED_SESSION_LABEL } from '@goondocks/myco-shared/prompt-text';
export { cleanSessionText, UNTITLED_SESSION_LABEL } from '@goondocks/myco-shared/prompt-text';

/** How a session is headed: its title, or, untitled, the first line the person typed when there is one. */
export type SessionHeading = { titled: true; title: string } | { titled: false; firstPrompt: string | null };

/**
 * A session's heading. The server's `label` falls back from the title to the
 * first prompt, then to the agent and the untitled label. Only prompt text
 * heads an untitled session; placeholder labels and the agent do not.
 */
export function sessionHeading(session: { sessionId: string; title: string | null; label: string; agent: string | null }): SessionHeading {
  const title = cleanSessionText(session.title, session.agent);
  if (title !== null) return { titled: true, title };
  const label = session.label.trim();
  const fallback = label === '' || label === UNTITLED_SESSION_LABEL || label === session.sessionId || label === session.agent;
  return { titled: false, firstPrompt: fallback ? null : cleanSessionText(label, session.agent) };
}

/** A session's heading as one line of plain text, for a dialog, a label or a nested line. */
export function sessionHeadingText(session: { sessionId: string; title: string | null; label: string; agent: string | null }): string {
  const heading = sessionHeading(session);
  if (heading.titled) return heading.title;
  return heading.firstPrompt === null ? UNTITLED_SESSION_LABEL : `Untitled: ${heading.firstPrompt}`;
}

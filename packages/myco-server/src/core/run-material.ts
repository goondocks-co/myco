/**
 * How a run reads a session: the bounds on one row of its session page, and
 * the preview cut every bounded text goes through.
 *
 * A run surveys sessions by previews and never by whole bodies, so the size of
 * a Project sets the cost of a pass rather than the size of its writing. The
 * bounds here are one page's; which page a task reads is `core/read-window.ts`.
 */

/** How much of one body a preview carries when the caller names no bound, cut on a word boundary. */
export const CONTENT_PREVIEW_MAX_CHARS = 360;

/** A body cut to `maxChars` on a word boundary. */
export function preview(text: string | null, maxChars: number = CONTENT_PREVIEW_MAX_CHARS): string | null {
  if (text === null || text === '') return null;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const boundary = text[maxChars] === ' ' ? maxChars : cut.lastIndexOf(' ');
  return `${(boundary > maxChars / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** The largest page of sessions any run is handed. */
export const RUN_SESSIONS_MAX_LIMIT = 50;
/** How much of a session's summary one row of that page carries. */
export const RUN_SESSION_SUMMARY_CHARS = 360;
/** How much of a session's title one row of that page carries. */
export const RUN_SESSION_TITLE_CHARS = 80;
/** How much of a session's label one row of that page carries. */
export const RUN_SESSION_LABEL_CHARS = 80;

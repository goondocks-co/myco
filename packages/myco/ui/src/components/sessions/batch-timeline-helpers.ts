/** Number of characters to show in a collapsed batch prompt preview. */
export const PROMPT_PREVIEW_CHARS = 120;

/** Diameter of the timeline node marker in pixels (Tailwind: h-7 w-7 = 28px). */
export const TIMELINE_NODE_SIZE_CLASS = 'h-7 w-7';

export function formatTimestamp(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

export function promptPreview(text: string | null): string {
  if (!text) return '(no prompt)';
  return text.length > PROMPT_PREVIEW_CHARS
    ? text.slice(0, PROMPT_PREVIEW_CHARS) + '…'
    : text;
}

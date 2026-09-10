/**
 * The managed block Myco owns inside a project's AGENTS.md.
 *
 * One block, between two markers, replaced whole. Everything outside the
 * markers is the project's own and is carried through byte for byte; a file
 * with no block gets one appended after its last line. The block is bounded,
 * so a Deployment cannot grow a repository's instructions without limit, and
 * the replacement is a pure function over the text so the same rule holds
 * wherever the bytes are written.
 */

export const AGENTS_MANAGED_START = '<!-- myco:managed:start -->';
export const AGENTS_MANAGED_END = '<!-- myco:managed:end -->';
/** The most characters the body between the markers may hold. */
export const AGENTS_BLOCK_MAX_CHARS = 500;

/** The block as it stands in the file: the markers and the body between them. */
export function renderManagedBlock(body: string): string {
  return `${AGENTS_MANAGED_START}\n${body.trim()}\n${AGENTS_MANAGED_END}\n`;
}

/** The body the file's managed block holds, or null where the file holds no block. */
export function managedBlockOf(text: string): string | null {
  const start = text.indexOf(AGENTS_MANAGED_START);
  if (start === -1) return null;
  const end = text.indexOf(AGENTS_MANAGED_END, start);
  if (end === -1) return null;
  return text.slice(start + AGENTS_MANAGED_START.length, end).trim();
}

/**
 * The file with its managed block replaced by `body`, or appended where it has
 * none. Text before the block and text after it are untouched; a file with an
 * opening marker and no closing one is treated as having no block, so nothing
 * the project wrote after a stray marker is ever cut.
 */
export function replaceManagedBlock(text: string, body: string): string {
  if (body.trim().length > AGENTS_BLOCK_MAX_CHARS) throw new RangeError(`the managed block is at most ${AGENTS_BLOCK_MAX_CHARS} characters`);
  const block = renderManagedBlock(body);
  const start = text.indexOf(AGENTS_MANAGED_START);
  const end = start === -1 ? -1 : text.indexOf(AGENTS_MANAGED_END, start);
  if (start === -1 || end === -1) {
    if (text.length === 0) return block;
    const separator = text.endsWith('\n') ? (text.endsWith('\n\n') ? '' : '\n') : '\n\n';
    return `${text}${separator}${block}`;
  }
  const afterEnd = end + AGENTS_MANAGED_END.length;
  const tail = text.slice(afterEnd).replace(/^\n/, '');
  return `${text.slice(0, start)}${block}${tail}`;
}

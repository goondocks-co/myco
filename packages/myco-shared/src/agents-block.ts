/**
 * The managed block Myco owns inside a project's AGENTS.md.
 *
 * One block, between two markers, replaced whole. Everything outside the
 * markers is the project's own and is carried through byte for byte; a file
 * with no block gets one appended after its last line. The block is bounded,
 * so a Deployment cannot grow a repository's instructions without limit, and a
 * body may not carry a marker, so nothing a run writes can escape the region
 * the markers fence. The replacement is a pure function over the text, so the
 * same rules hold wherever the bytes are written.
 *
 * The file is read as the project wrote it: a marker inside a fenced code
 * example is an example, and a file with two blocks, or a close before an open,
 * is one this refuses to guess about rather than rewrite.
 */

export const AGENTS_MANAGED_START = '<!-- myco:managed:start -->';
export const AGENTS_MANAGED_END = '<!-- myco:managed:end -->';
/** The most characters the body between the markers may hold. */
export const AGENTS_BLOCK_MAX_CHARS = 500;

/** One refusal for every body the block may not hold: empty, past the bound, or carrying a marker. */
export const AGENTS_BLOCK_BODY_REASON = `the managed block body is 1 to ${AGENTS_BLOCK_MAX_CHARS} characters and carries neither marker`;

/** Why a body may not be the managed block, or null when it may. */
export function managedBlockBodyProblem(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > AGENTS_BLOCK_MAX_CHARS) return AGENTS_BLOCK_BODY_REASON;
  if (trimmed.includes(AGENTS_MANAGED_START) || trimmed.includes(AGENTS_MANAGED_END)) return AGENTS_BLOCK_BODY_REASON;
  return null;
}

/** The block as it stands in the file: the markers and the body between them, with the file's own line ending. */
export function renderManagedBlock(body: string, eol: '\n' | '\r\n' = '\n'): string {
  return `${AGENTS_MANAGED_START}${eol}${body.trim().split(/\r?\n/).join(eol)}${eol}${AGENTS_MANAGED_END}${eol}`;
}

/** A file refused rather than rewritten: what the replacement found that it would not guess about. */
export class ManagedBlockError extends Error {
  constructor(message: string) { super(message); this.name = 'ManagedBlockError'; }
}

/** The line ending the text uses: CRLF where any line ends that way, LF otherwise. */
export function lineEndingOf(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Every index at which `marker` occurs in `text` outside a fenced code block. */
function markerIndexes(text: string, marker: string): number[] {
  const found: number[] = [];
  let fenced = false;
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced) {
      let at = line.indexOf(marker);
      while (at !== -1) { found.push(offset + at); at = line.indexOf(marker, at + marker.length); }
    }
    offset += line.length + (text.startsWith('\r\n', offset + line.length) ? 2 : 1);
  }
  return found;
}

/**
 * Where the file's managed block stands, null where it holds none, or a
 * refusal where the file holds markers this will not guess about: more than
 * one of either, or a close before the open. A marker inside a fenced code
 * example is not a marker.
 */
export function locateManagedBlock(text: string): { start: number; end: number } | null {
  const starts = markerIndexes(text, AGENTS_MANAGED_START);
  const ends = markerIndexes(text, AGENTS_MANAGED_END);
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length > 1 || ends.length > 1) throw new ManagedBlockError('the file holds more than one managed block marker pair');
  if (starts.length !== ends.length) throw new ManagedBlockError('the file holds an unmatched managed block marker');
  if (ends[0]! < starts[0]!) throw new ManagedBlockError('the file closes a managed block before opening one');
  return { start: starts[0]!, end: ends[0]! + AGENTS_MANAGED_END.length };
}

/** The body the file's managed block holds, or null where the file holds no block. */
export function managedBlockOf(text: string): string | null {
  const located = locateManagedBlock(text);
  if (located === null) return null;
  return text.slice(located.start + AGENTS_MANAGED_START.length, located.end - AGENTS_MANAGED_END.length).trim();
}

/**
 * The file with its managed block replaced by `body`, or appended where it has
 * none. Text before the block and text after it are untouched, and the file's
 * own line ending is kept.
 */
export function replaceManagedBlock(text: string, body: string): string {
  const problem = managedBlockBodyProblem(body);
  if (problem !== null) throw new RangeError(problem);
  const eol = lineEndingOf(text);
  const block = renderManagedBlock(body, eol);
  const located = locateManagedBlock(text);
  if (located === null) {
    if (text.length === 0) return block;
    const separator = text.endsWith(eol) ? (text.endsWith(eol + eol) ? '' : eol) : eol + eol;
    return `${text}${separator}${block}`;
  }
  const tail = text.slice(located.end);
  return `${text.slice(0, located.start)}${block}${tail.startsWith(eol) ? tail.slice(eol.length) : tail}`;
}

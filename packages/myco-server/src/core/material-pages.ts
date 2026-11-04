/**
 * A run's material as pages, each an answer its harness holds whole, and how far the attempt has read them.
 *
 * Entries stay in order and every character is served: an entry starts a new page rather than split, unless it is longer
 * than a page. One revision binds a run's pages to one another, and the attempt keeps one small record in the run's
 * context of how far it has read the last revision it started.
 */
import { sha256HexOf, utf8 } from '../hash.js';
import { RUN_ANSWER_BYTES } from './read-window.js';
import { RUN_MATERIAL_READ_KEY } from './runs.js';

/** The characters of a material revision. */
const REVISION_CHARS = 16;
/** The refusal of a continuation whose material has moved past the revision its pages came from: read again from page 1. */
export const MATERIAL_CHANGED = 'material_changed';
/** The refusal of a read or a write ahead of the pages served: read the page it names. */
export const MATERIAL_UNREAD = 'material_unread';

/** How far this attempt has read one revision of its material: every page up to and including `through`. */
export interface MaterialRead { tokenId: string; revision: string; pages: number; through: number }

/** What the material says now, as the token that binds its pages to one another. */
export async function materialRevision(entries: readonly unknown[]): Promise<string> {
  return (await sha256HexOf(utf8(JSON.stringify(entries)))).slice(0, REVISION_CHARS);
}

/** How far the attempt holding this credential has read its material, or null where it has read none: another attempt's reads are not its own. */
export function materialRead(runContext: string | null, tokenId: string): MaterialRead | null {
  try {
    const read = (JSON.parse(runContext ?? 'null') as Record<string, MaterialRead> | null)?.[RUN_MATERIAL_READ_KEY];
    return read?.tokenId === tokenId ? read : null;
  } catch { return null; }
}

const encoder = new TextEncoder();
/** The UTF-8 bytes of a value's JSON. */
export const answerBytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).length;

/** The room an answer leaves for its entries, after everything else it carries, as the MCP result names it. */
export function answerRoom(around: Record<string, unknown>): number {
  return RUN_ANSWER_BYTES - answerBytes({ result: { ...around, revision: '0'.repeat(REVISION_CHARS), page: 9_999, next_page: 9_999 } });
}

/**
 * The longest head of `text` whose weight is at most `room` bytes. It never ends inside a surrogate pair: JSON escapes
 * half a pair to six bytes, more than the four of the whole pair, so whichever head holds half a pair, the next one fits too.
 */
export function headThatFits(text: string, room: number, weigh: (head: string) => number): string {
  let low = 1;
  let high = Math.min(text.length, room);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (weigh(text.slice(0, middle)) <= room) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

/** How an entry's text is read and replaced. `continues` marks text that goes on under the same key on the next page. */
export interface PagedEntry<E> { textOf(entry: E): string; withText(entry: E, text: string, continues: boolean): E }

/** Entries as pages: `first` bytes of room on page 1, which may carry more around its entries, and `rest` on every other. */
export function materialPages<E>(entries: readonly E[], shape: PagedEntry<E>, room: { first: number; rest: number }): E[][] {
  const pages: E[][] = [[]];
  let left = room.first;
  const turnPage = () => { pages.push([]); left = room.rest; };
  for (const entry of entries) {
    let text = shape.textOf(entry);
    for (;;) {
      const whole = shape.withText(entry, text, false);
      const weight = answerBytes(whole) + 1;
      if (weight > left && pages.at(-1)!.length > 0) turnPage();
      if (weight <= left) { pages.at(-1)!.push(whole); left -= weight; break; }
      const head = headThatFits(text, left - 1, (candidate) => answerBytes(shape.withText(entry, candidate, true)));
      pages.at(-1)!.push(shape.withText(entry, head, true));
      text = text.slice(head.length);
      turnPage();
    }
  }
  return pages;
}

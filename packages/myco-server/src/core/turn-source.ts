/** Source pages one continuation request opens at most. */
export const TURN_SOURCE_PAGES = 1;
/** Raw source bytes a card run may read for one turn. */
export const TURN_SOURCE_MAX_BYTES = 160_000;
/** Consecutive failed full-read runs before a turn uses its excerpt. */
export const TURN_SOURCE_FAILURE_LIMIT = 3;
export const TURN_SOURCE_CURSOR_MAX_CHARS = 3 * String(Number.MAX_SAFE_INTEGER).length + 2;

/** A turn's sequential source read, credited only to the attempt that received it. */
export interface TurnSourceRead {
  tokenId: string;
  revision: string;
  cursor: string | null;
  state: 'reading' | 'complete';
  bytesRead: number;
}

export interface RequiredTurnSource { turnKey: string; revision: string }

/** The prior receipt a compare-and-set must bind, including one held by an earlier attempt. */
export function recordedTurnSource(context: string | null, turn: string): TurnSourceRead | null {
  const held = JSON.parse(context ?? '{}')?.turnSourceReads ?? {};
  return Object.hasOwn(held, turn) ? held[turn] : null;
}

export function turnSourceReads(context: string | null, tokenId: string): ReadonlyMap<string, TurnSourceRead> {
  const held = JSON.parse(context ?? '{}')?.turnSourceReads ?? {};
  return new Map(Object.entries(held).filter((entry): entry is [string, TurnSourceRead] =>
    (entry[1] as TurnSourceRead)?.tokenId === tokenId));
}

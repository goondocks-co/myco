/**
 * Turning a transcript's stored bytes back into whole lines.
 *
 * A transcript arrives as segments the member sliced at arbitrary byte
 * boundaries, so a single JSON record routinely straddles two of them, and a
 * parse pass reads only part of what the Deployment holds. Both problems have
 * one answer: **only complete lines are ever consumed**, and the cursor
 * advances to the byte just past the last newline it read.
 *
 * That is what makes the parse resumable with no carry state anywhere. Nothing
 * is remembered between passes except one integer, so a pass that dies halfway
 * costs the work and none of the correctness — the next pass starts at a byte
 * that is known to begin a line.
 *
 * Offsets are BYTES, matching what the member ships and what `transcripts.size`
 * counts. They are not string indices: a multi-byte character would put those
 * two out of step, and the cursor would drift by exactly the number of non-ASCII
 * characters seen so far.
 */
import type { ParsedLine } from './parsers/index.js';

/** What one read of a transcript's bytes yielded, and where the next read starts. */
export interface SplitResult {
  lines: ParsedLine[];
  /** The absolute byte offset just past the last complete line; the cursor's next value. */
  nextOffset: number;
  /** Bytes held back as an incomplete trailing line. */
  pending: number;
}

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

/**
 * The complete lines in `bytes`, each carrying its absolute byte offset.
 *
 * A line that does not parse as a JSON object is skipped rather than failing
 * the read: an unknown record shape is normal in every one of these formats.
 * A line that is not JSON at all is reported through `malformed` so the caller
 * can stop the transcript loudly rather than silently dropping rows.
 */
export function splitCompleteLines(bytes: Uint8Array, baseOffset: number): SplitResult & { malformed: number } {
  const lines: ParsedLine[] = [];
  let malformed = 0;
  let offset = baseOffset;
  let start = 0;

  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 0x0a) continue;
    const raw = bytes.subarray(start, i);
    const text = decoder.decode(raw).trim();
    if (text !== '') {
      try {
        const value: unknown = JSON.parse(text);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) lines.push({ value: value as Record<string, unknown>, offset });
      } catch {
        malformed += 1;
      }
    }
    offset += raw.length + 1;
    start = i + 1;
  }

  return { lines, nextOffset: offset, pending: bytes.length - start, malformed };
}

/** The byte length of a string as the transcript stores it, for a caller sizing a read against `transcripts.size`. */
export const byteLength = (text: string): number => encoder.encode(text).length;

/**
 * The stored segments covering `[from, from + budget)`, in offset order.
 *
 * A segment is admitted whole or not at all: it is the unit the bytes were
 * stored in, and half of one is not addressable. The byte budget is therefore a
 * floor on what is read rather than a ceiling — the first segment is always
 * taken, so a transcript whose first unread segment exceeds the budget still
 * makes progress instead of stalling forever. `maxSegments` bounds the reads
 * themselves, which the byte budget alone does not: many small segments sit
 * inside it while costing one read each.
 */
export function segmentsToRead<T extends { baseOffset: number; length: number }>(
  segments: readonly T[], from: number, budget: number, maxSegments = Number.MAX_SAFE_INTEGER,
): T[] {
  const ordered = [...segments].filter((s) => s.baseOffset + s.length > from).sort((a, b) => a.baseOffset - b.baseOffset);
  const taken: T[] = [];
  let end = from;
  for (const segment of ordered) {
    // A gap means the bytes between are not held; the parse stops at the hole
    // rather than reading across it and inventing a line boundary.
    if (taken.length > 0 && segment.baseOffset > end) break;
    taken.push(segment);
    end = segment.baseOffset + segment.length;
    // Bytes bound the memory a pass holds; the COUNT bounds the reads it makes.
    // Many small segments sit inside the byte bound while costing one read each.
    if (end - from >= budget || taken.length >= maxSegments) break;
  }
  return taken;
}

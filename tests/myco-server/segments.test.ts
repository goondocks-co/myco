/**
 * The byte arithmetic the parse cursor rests on.
 *
 * Everything about resuming a transcript reduces to two properties: a pass
 * consumes only complete lines, and the offset it reports is the byte just past
 * the last one. If either slips, the next pass starts mid-record and every row
 * after it is lost or duplicated — so these are asserted against multi-byte
 * text, straddled boundaries and gaps, not only against clean ASCII.
 */
import { describe, expect, it } from 'bun:test';
import { segmentsToRead, splitCompleteLines } from '@myco-server-worker/ingest/segments.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

describe('splitCompleteLines', () => {
  it('reads whole lines and reports the byte just past the last newline', () => {
    const text = line({ a: 1 }) + line({ b: 2 });
    const result = splitCompleteLines(bytes(text), 0);
    expect(result.lines.map((l) => l.value)).toEqual([{ a: 1 }, { b: 2 }]);
    expect(result.nextOffset).toBe(bytes(text).length);
    expect(result.pending).toBe(0);
  });

  it('holds back a trailing line that has no newline yet, and counts its bytes', () => {
    const complete = line({ a: 1 });
    const result = splitCompleteLines(bytes(complete + '{"b":2'), 0);
    expect(result.lines.map((l) => l.value)).toEqual([{ a: 1 }]);
    expect(result.nextOffset).toBe(bytes(complete).length);
    expect(result.pending).toBe(6);
  });

  it('gives every line the absolute offset it starts at, so an id derived from it is stable', () => {
    const first = line({ a: 1 });
    const result = splitCompleteLines(bytes(first + line({ b: 2 })), 1000);
    expect(result.lines.map((l) => l.offset)).toEqual([1000, 1000 + bytes(first).length]);
  });

  it('counts BYTES and not characters, so multi-byte text cannot drift the cursor', () => {
    const text = line({ a: 'héllo — ünïcode 🌱' });
    const result = splitCompleteLines(bytes(text), 0);
    expect(result.nextOffset).toBe(bytes(text).length);
    expect(result.nextOffset).toBeGreaterThan(text.length);
    expect(result.lines[0].value).toEqual({ a: 'héllo — ünïcode 🌱' });
  });

  it('resumes exactly where it stopped: two reads of a straddled buffer equal one read of the whole', () => {
    const whole = line({ a: 1 }) + line({ b: 2 }) + line({ c: 3 });
    const all = bytes(whole);
    const cut = bytes(line({ a: 1 })).length + 4;

    const first = splitCompleteLines(all.subarray(0, cut), 0);
    const second = splitCompleteLines(all.subarray(first.nextOffset), first.nextOffset);

    expect([...first.lines, ...second.lines].map((l) => l.value)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
    expect([...first.lines, ...second.lines].map((l) => l.offset)).toEqual(splitCompleteLines(all, 0).lines.map((l) => l.offset));
    expect(second.nextOffset).toBe(all.length);
  });

  it('skips a blank line and a JSON scalar without counting either as malformed', () => {
    const result = splitCompleteLines(bytes('\n' + line({ a: 1 }) + '3\n' + '"x"\n'), 0);
    expect(result.lines.map((l) => l.value)).toEqual([{ a: 1 }]);
    expect(result.malformed).toBe(0);
  });

  it('reports a line that is not JSON so the caller can stop the transcript loudly', () => {
    const result = splitCompleteLines(bytes(line({ a: 1 }) + 'not json at all\n' + line({ b: 2 })), 0);
    expect(result.malformed).toBe(1);
    expect(result.lines.map((l) => l.value)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('consumes nothing from a buffer holding no newline', () => {
    const result = splitCompleteLines(bytes('{"a":1'), 500);
    expect(result.lines).toEqual([]);
    expect(result.nextOffset).toBe(500);
    expect(result.pending).toBe(6);
  });
});

describe('segmentsToRead', () => {
  const seg = (baseOffset: number, length: number) => ({ baseOffset, length });

  it('takes segments in offset order from the cursor', () => {
    const segments = [seg(20, 10), seg(0, 10), seg(10, 10)];
    expect(segmentsToRead(segments, 0, 100)).toEqual([seg(0, 10), seg(10, 10), seg(20, 10)]);
  });

  it('skips segments already behind the cursor', () => {
    expect(segmentsToRead([seg(0, 10), seg(10, 10)], 10, 100)).toEqual([seg(10, 10)]);
  });

  it('stops once the budget is met, leaving the rest to the next pass', () => {
    const segments = [seg(0, 10), seg(10, 10), seg(20, 10)];
    expect(segmentsToRead(segments, 0, 15)).toEqual([seg(0, 10), seg(10, 10)]);
  });

  it('always takes the first segment, so one larger than the budget still makes progress', () => {
    expect(segmentsToRead([seg(0, 5_000)], 0, 100)).toEqual([seg(0, 5_000)]);
  });

  it('stops at a gap rather than reading across bytes it does not hold', () => {
    const segments = [seg(0, 10), seg(50, 10)];
    expect(segmentsToRead(segments, 0, 1_000)).toEqual([seg(0, 10)]);
  });

  it('answers nothing when the cursor is past everything held', () => {
    expect(segmentsToRead([seg(0, 10)], 10, 100)).toEqual([]);
  });
});

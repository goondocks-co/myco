import { describe, expect, it } from 'bun:test';
import { collectBounded } from '@myco-server-worker/bytes.js';

/** A reader over 1 KiB chunks that counts the reads made of it. */
function counting(totalBytes: number) {
  const state = { reads: 0, sent: 0 };
  const reader = {
    async read(): Promise<{ done: boolean; value?: Uint8Array }> {
      state.reads += 1;
      if (state.sent >= totalBytes) return { done: true };
      state.sent += 1024;
      return { done: false, value: new Uint8Array(1024).fill(0x61) };
    },
  };
  return { reader, state };
}

describe('bounded byte collection', () => {
  it('collects a stream exactly at its bound into one buffer of its own', async () => {
    const { reader } = counting(4 * 1024);
    const read = await collectBounded(reader, 4 * 1024);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.bytes.byteLength).toBe(4 * 1024);
    expect(read.bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(read.bytes.every((b) => b === 0x61)).toBe(true);
  });

  it('ends collection at the first chunk past its bound without reading further', async () => {
    const { reader, state } = counting(64 * 1024);
    expect(await collectBounded(reader, 8 * 1024)).toEqual({ ok: false });
    expect(state).toEqual({ reads: 9, sent: 9 * 1024 });
  });
});

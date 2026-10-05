import { collectBounded, type ChunkReader } from '../bytes.js';

export const MAX_BODY_BYTES = 327_680;

export type BoundedBody = { ok: true; text: string; bytes: number } | { ok: false; reason: string };

const decoder = new TextDecoder();

/** Reads at most `max` bytes into memory. Declared oversized bodies are refused unread; streamed overflow is drained or cancelled as the caller declares. */
export async function readBoundedBody(request: Request, max: number, overflow: 'drain' | 'cancel' = 'drain'): Promise<BoundedBody> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    return { ok: false, reason: `body exceeds ${max} bytes` };
  }
  if (!request.body) return { ok: true, text: '', bytes: 0 };

  const reader = request.body.getReader();
  const read = await collectBounded(reader, max);
  if (!read.ok) {
    if (overflow === 'cancel') await reader.cancel();
    else await drain(reader);
    return { ok: false, reason: `body exceeds ${max} bytes` };
  }
  return { ok: true, text: decoder.decode(read.bytes), bytes: read.bytes.byteLength };
}

/** Discards the rest of a stream to its end. */
async function drain(reader: ChunkReader): Promise<void> {
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

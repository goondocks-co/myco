import { collectBounded, type ChunkReader } from '../bytes.js';

export const MAX_BODY_BYTES = 327_680;

export type BoundedBody = { ok: true; text: string; bytes: number } | { ok: false; reason: string };

const decoder = new TextDecoder();

/** Reads a request body up to `max` bytes. A body whose declared content-length exceeds `max` is refused without being read. Once reading has begun, an oversized stream is read to its end and discarded — never cancelled, never released, never left partially read. */
export async function readBoundedBody(request: Request, max: number): Promise<BoundedBody> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    return { ok: false, reason: `body exceeds ${max} bytes` };
  }
  if (!request.body) return { ok: true, text: '', bytes: 0 };

  const reader = request.body.getReader();
  const read = await collectBounded(reader, max);
  if (!read.ok) {
    await drain(reader);
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

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
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await drain(reader);
      return { ok: false, reason: `body exceeds ${max} bytes` };
    }
    chunks.push(value);
  }
  return { ok: true, text: decoder.decode(concat(chunks, total)), bytes: total };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { joined.set(c, offset); offset += c.byteLength; }
  return joined;
}

/** Discards the rest of a stream to its end. */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

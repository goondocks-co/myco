import { collectBounded, type ChunkReader } from '../bytes.js';

export const MAX_BODY_BYTES = 327_680;

type BoundedBody = { ok: true; text: string; bytes: number } | { ok: false; reason: string };

const decoder = new TextDecoder();

/** The refusal for a blob over the upload ceiling: the size refused, the limit, and what to do instead. */
export const blobCapReason = (bytes: number, max: number): string =>
  `blob is ${bytes} bytes; the limit is ${max} bytes. Nothing was stored. Split the content into parts under the limit and upload each with POST /blobs/{sha256}.`;

/** The refusal for a body over `max` on any route: the size refused, the limit, and the one thing every caller can do. */
export const bodyCapReason = (bytes: number, max: number): string =>
  `body is ${bytes} bytes; the limit is ${max} bytes. Nothing was stored. Send a smaller request.`;

/** The further call open to a member capturing an event: it alone can upload content and name its key in the request it sends again. */
export const EVENT_BODY_CAP_NEXT_CALL = 'Upload large content with POST /blobs/{sha256} and send the event again naming that key.';

/** Reads a request body up to `max` bytes. A body whose declared content-length exceeds `max` is refused without being read. Once reading has begun, an oversized stream is read to its end and discarded — never cancelled, never released, never left partially read. */
export async function readBoundedBody(request: Request, max: number): Promise<BoundedBody> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    return { ok: false, reason: bodyCapReason(Number(declared), max) };
  }
  if (!request.body) return { ok: true, text: '', bytes: 0 };

  const source = request.body.getReader();
  let seen = 0;
  const reader: ChunkReader = {
    read: async () => {
      const next = await source.read();
      seen += next.value?.byteLength ?? 0;
      return next;
    },
  };
  const read = await collectBounded(reader, max);
  if (!read.ok) {
    await drain(reader);
    return { ok: false, reason: bodyCapReason(seen, max) };
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

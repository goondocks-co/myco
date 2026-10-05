// The package entry bypasses Bun's native Undici shim, whose fetch has no socket read backpressure.
import { request, Agent, interceptors } from 'undici/index.js';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Readable, Transform } from 'node:stream';
import type { CloudflareFetch } from './cloudflare.js';

const MAX_REDIRECTS = 20;
const MAX_ENCODINGS = 5;
const dispatcher = new Agent().compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }));
const decoders = new Map<string, () => Transform>([
  ['gzip', createGunzip], ['x-gzip', createGunzip], ['deflate', createInflate], ['br', createBrotliDecompress],
]);

/** Signed-URL download transport with socket read backpressure and no operator credential. */
export const fetchD1Download: CloudflareFetch = async (url, init) => {
  const response = await request(url, {
    method: 'GET', headers: Array.from(new Headers(init.headers)).flat(), signal: init.signal, dispatcher,
  });
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const encodings = (headers.get('content-encoding') ?? '').split(',').map((encoding) => encoding.trim().toLowerCase()).filter((encoding) => encoding !== '' && encoding !== 'identity');
  let input: Readable = response.body;
  try {
    if (encodings.length > MAX_ENCODINGS) throw new Error('D1 download has too many content encodings');
    for (const encoding of encodings.reverse()) {
      const decode = decoders.get(encoding);
      if (decode === undefined) throw new Error(`D1 download has unsupported content encoding: ${encoding}`);
      const decoded = decode();
      const encoded = input;
      encoded.on('error', (error) => decoded.destroy(error));
      decoded.on('error', (error) => encoded.destroy(error));
      input = encoded.pipe(decoded);
    }
  } catch (error) {
    response.body.destroy();
    throw error;
  }
  const reader = input[Symbol.asyncIterator]();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.next();
      if (chunk.done) controller.close();
      else controller.enqueue(chunk.value);
    },
    async cancel() { input.destroy(); response.body.destroy(); },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.statusCode, headers });
};

// The package entry selects Undici's request transport with its content-encoding headers intact.
import { request, Agent, interceptors } from 'undici/index.js';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Readable, Transform } from 'node:stream';
import type { CloudflareFetch } from './cloudflare.js';
import { boundedMemoryChunks } from './stream-memory.js';

export interface D1DownloadReader {
  read(): Promise<{ done: true; value?: Uint8Array } | { done: false; value: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}
export interface D1Download {
  status: number;
  ok: boolean;
  headers: Headers;
  reader: D1DownloadReader | null;
}
export type D1DownloadFetch = (...args: Parameters<CloudflareFetch>) => Promise<D1Download>;

/** Adapts an injected HTTP response to the download reader contract. */
export function injectedD1Download(fetch: CloudflareFetch): D1DownloadFetch {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, ok: response.ok, headers: response.headers, reader: response.body?.getReader() ?? null };
  };
}

const MAX_REDIRECTS = 20;
const MAX_ENCODINGS = 5;
const dispatcher = new Agent().compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }));
const decoders = new Map<string, () => Transform>([
  ['gzip', createGunzip], ['x-gzip', createGunzip], ['deflate', createInflate], ['br', createBrotliDecompress],
]);

/** Signed-URL download transport with socket read backpressure and no operator credential. */
export const fetchD1Download: D1DownloadFetch = async (url, init) => {
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
  const reader = boundedMemoryChunks<Uint8Array>(input, (chunk) => chunk.byteLength);
  return {
    status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers,
    reader: {
      async read() {
        const chunk = await reader.next();
        return chunk.done ? { done: true, value: undefined } : { done: false, value: chunk.value };
      },
      async cancel() { input.destroy(); response.body.destroy(); },
    },
  };
};

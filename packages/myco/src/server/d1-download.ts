// The package entry selects Undici's request transport with its content-encoding headers intact.
import { request, Agent, interceptors } from 'undici/index.js';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Transform } from 'node:stream';
import { boundedMemoryChunks } from './stream-memory.js';

export interface D1DownloadReader {
  read(): Promise<{ done: true; value?: Uint8Array } | { done: false; value: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
}
export interface D1Download {
  status: number;
  ok: boolean;
  headers: Headers;
  /** Undecoded bytes; Content-Length and Content-Range describe this reader. */
  reader: D1DownloadReader | null;
}
export type D1DownloadFetch = (url: string, init: RequestInit) => Promise<D1Download>;
export type D1DownloadHttpFetch = (url: string, init: RequestInit & { decompress: false }) => Promise<Response>;

/** Adapts an injected HTTP response to the download reader contract. */
export function injectedD1Download(fetch: D1DownloadHttpFetch): D1DownloadFetch {
  return async (url, init) => {
    const response = await fetch(url, { ...init, decompress: false });
    return { status: response.status, ok: response.ok, headers: response.headers, reader: response.body?.getReader() ?? null };
  };
}

const MAX_REDIRECTS = 20;
const MAX_ENCODINGS = 5;
const dispatcher = new Agent().compose(interceptors.redirect({ maxRedirections: MAX_REDIRECTS }));
const decoders = new Map<string, () => Transform>([
  ['gzip', createGunzip], ['x-gzip', createGunzip], ['deflate', createInflate], ['br', createBrotliDecompress],
]);

/** Decodes a complete encoded download; unsupported encodings and incomplete streams fail closed. */
export async function decodeD1Download(source: string, destination: string, contentEncoding: string): Promise<void> {
  const encodings = contentEncoding.split(',').map((encoding) => encoding.trim().toLowerCase())
    .filter((encoding) => encoding !== '' && encoding !== 'identity');
  if (encodings.length > MAX_ENCODINGS) throw new Error('D1 download has too many content encodings');
  const decoding = encodings.reverse().map((encoding) => {
    const decode = decoders.get(encoding);
    if (decode === undefined) throw new Error(`D1 download has unsupported content encoding: ${encoding}`);
    return decode();
  });
  await pipeline([fs.createReadStream(source), ...decoding, fs.createWriteStream(destination, { mode: 0o600 })]);
}

/** Signed-URL download transport with socket read backpressure and no operator credential. */
export const fetchD1Download: D1DownloadFetch = async (url, init) => {
  const response = await request(url, {
    method: 'GET', headers: Array.from(new Headers(init.headers)).flat(), signal: init.signal, dispatcher,
  });
  const headers = new Headers();
  for (const [key, value] of Object.entries(response.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const reader = boundedMemoryChunks<Uint8Array>(response.body, (chunk) => chunk.byteLength);
  return {
    status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, headers,
    reader: {
      async read() {
        const chunk = await reader.next();
        return chunk.done ? { done: true, value: undefined } : { done: false, value: chunk.value };
      },
      async cancel() { response.body.destroy(); },
    },
  };
};

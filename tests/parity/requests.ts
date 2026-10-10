import type { ParityTarget } from './harness.ts';

export const PARITY_REQUEST_HEADER = 'x-myco-parity-request';
export const PARITY_WORKER_HEADER = 'x-myco-parity-worker';
const CONNECTION_RETRY_DELAY_MS = 100;
const MAX_DIAGNOSTIC_BODY_BYTES = 8 * 1024;
const BODY_TRUNCATION_MARKER = '\n... response body truncated ...\n';

function diagnosticBody(body: string): string {
  const encoded = Buffer.from(body);
  if (encoded.length <= MAX_DIAGNOSTIC_BODY_BYTES) return body;
  const excerptBytes = Math.floor((MAX_DIAGNOSTIC_BODY_BYTES - Buffer.byteLength(BODY_TRUNCATION_MARKER)) / 2);
  const head = new TextDecoder().decode(encoded.subarray(0, excerptBytes), { stream: true });
  let tailStart = encoded.length - excerptBytes;
  // UTF-8 continuation bytes cannot begin the retained tail.
  while ((encoded[tailStart]! & 0xc0) === 0x80) tailStart++;
  return head + BODY_TRUNCATION_MARKER + encoded.subarray(tailStart).toString('utf8');
}

/** A refused TCP connect sent no request; a reset, HTTP error or assertion can follow a committed write. */
export async function connectRequest<T>(send: () => Promise<T>): Promise<T> {
  try { return await send(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || !['ECONNREFUSED', 'ConnectionRefused'].includes(String(error.code))) throw error;
    await Bun.sleep(CONNECTION_RETRY_DELAY_MS);
    return send();
  }
}

export interface RequestFailure {
  at: string;
  id: string;
  method: string;
  path: string;
  status?: number;
  worker?: string | null;
  body?: string;
  error?: string;
}

/** Captures failing responses without consuming the scenario's response or replaying its request. */
export async function withParityRequests(targets: ParityTarget[], run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  const byOrigin = new Map(targets.map(target => [new URL(target.url).origin, target]));
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const target = byOrigin.get(url.origin);
    if (target?.requestFailure === undefined) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [key, value] of Object.entries(target.transportHeaders ?? {})) headers.set(key, value);
    const failure: RequestFailure = {
      at: new Date().toISOString(), id: crypto.randomUUID(),
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'), path: url.pathname,
    };
    headers.set(PARITY_REQUEST_HEADER, failure.id);
    headers.set('connection', 'close');
    let response: Response;
    try {
      response = await connectRequest(() => original(input, { ...init, headers, keepalive: false }));
    } catch (error) {
      try { await target.requestFailure({ ...failure, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }); }
      catch (diagnosticError) { throw new AggregateError([error, diagnosticError], 'Parity request and diagnostic recording failed', { cause: error }); }
      throw error;
    }
    if (response.status >= 500) {
      let body: string;
      try { body = await response.clone().text(); }
      catch (error) { body = `response body failed: ${String(error)}`; }
      await target.requestFailure({ ...failure, status: response.status, worker: response.headers.get(PARITY_WORKER_HEADER), body: diagnosticBody(body) });
    }
    return response;
  }, { preconnect: original.preconnect });
  try { await run(); }
  finally { globalThis.fetch = original; }
}

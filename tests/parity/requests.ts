import type { ParityTarget } from './harness.ts';

export const PARITY_REQUEST_HEADER = 'x-myco-parity-request';
export const PARITY_WORKER_HEADER = 'x-myco-parity-worker';

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
    const failure: RequestFailure = {
      at: new Date().toISOString(), id: crypto.randomUUID(),
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'), path: url.pathname,
    };
    headers.set(PARITY_REQUEST_HEADER, failure.id);
    let response: Response;
    try {
      response = await original(input, { ...init, headers });
    } catch (error) {
      await target.requestFailure({ ...failure, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
      throw error;
    }
    if (response.status >= 500) {
      let body: string;
      try { body = await response.clone().text(); }
      catch (error) { body = `response body failed: ${String(error)}`; }
      await target.requestFailure({ ...failure, status: response.status, worker: response.headers.get(PARITY_WORKER_HEADER), body });
    }
    return response;
  }, { preconnect: original.preconnect });
  try { await run(); }
  finally { globalThis.fetch = original; }
}

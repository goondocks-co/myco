import { memberHeaders } from './member-protocol.js';

export class RunControlError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`run control ${path}: ${detail}`);
    this.name = 'RunControlError';
  }
}

/** A run-control answer must be a successful object response without a refusal. */
export function runControlResult(status: number, body: unknown, path: string): Record<string, unknown> {
  if (status !== 200 || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RunControlError(path, `status ${status}`);
  }
  const result = body as Record<string, unknown>;
  if (result.persisted === false) {
    throw new RunControlError(path, `${String(result.code ?? 'refused')}: ${String(result.reason ?? '')}`);
  }
  return result;
}

export type RunControl = (path: string, payload: unknown, signal: AbortSignal) => Promise<Record<string, unknown>>;

/** Authenticated run control stays on its selected origin and is bounded through the response body. */
export function runControlClient(
  record: { origin: string; token: string; projectId: string },
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
): RunControl {
  const origin = new URL(record.origin).origin;
  return async (path, payload, signal) => {
    let response: Response;
    let text: string;
    try {
      response = await fetcher(origin + path, { method: 'POST', redirect: 'manual', signal,
        headers: { ...memberHeaders(record), 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      text = await response.text();
    } catch (error) {
      throw new RunControlError(path, error instanceof Error ? error.message : String(error));
    }
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* The status classifier rejects a non-JSON answer. */ }
    return runControlResult(response.status, body, path);
  };
}

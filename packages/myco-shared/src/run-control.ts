import { memberHeaders } from './member-protocol.js';

/** Refusals the run control plane names, in the reader's words. */
export const RUN_CONTROL_REFUSAL_WORDS = {
  no_machine_identity: 'The machine running the task could not be identified.',
  body_cap: 'The task’s request was too large for the server.',
  parse: 'The server refused the task’s request because its format was invalid.',
  refused: 'The server refused the task’s request.',
  invalid_field: 'The server refused a value in the task’s request.',
  field_retired: 'The task sent a field this server no longer accepts.',
  route_retired: 'The task called a route this server no longer serves.',
  run_scope: 'The task is not allowed to make this request.',
  no_run: 'The server could not find the task’s run.',
  project_mismatch: 'The task’s request named a different project.',
  project_archived: 'The task’s project is archived.',
  no_project: 'The server could not find the task’s project.',
} as const;
export type RunControlRefusalCode = keyof typeof RUN_CONTROL_REFUSAL_WORDS;

/** A known run-control refusal code, or null for anything else. */
export function runControlRefusalCode(value: unknown): RunControlRefusalCode | null {
  return typeof value === 'string' && Object.hasOwn(RUN_CONTROL_REFUSAL_WORDS, value) ? value as RunControlRefusalCode : null;
}

/** A server refusal recorded without the request's text. */
export const runControlRefusedError = (code: RunControlRefusalCode): string => `the server refused run control (${code})`;

/** The refusal code carried by a stored server-refusal sentence. */
export function storedRunControlRefusal(text: string | null): RunControlRefusalCode | null {
  return runControlRefusalCode(text === null ? null : /^the server refused run control \(([a-z_]+)\)$/.exec(text)?.[1]);
}

export class RunControlError extends Error {
  constructor(readonly path: string, detail: string, readonly code: RunControlRefusalCode | null = null) {
    super(code === null ? `run control ${path}: ${detail}` : runControlRefusedError(code));
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
    throw new RunControlError(path, 'request refused', runControlRefusalCode(result.code) ?? 'refused');
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
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new RunControlError(path, 'cross-origin route refused');
    let response: Response;
    let text: string;
    try {
      response = await fetcher(url.href, { method: 'POST', redirect: 'manual', signal,
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

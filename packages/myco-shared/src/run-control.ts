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

export class RunControlError extends Error {
  constructor(readonly path: string, detail: string, readonly code: RunControlRefusalCode | null = null, readonly refusalId: string | null = null) {
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
    throw new RunControlError(path, 'request refused', runControlRefusalCode(result.code) ?? 'refused',
      typeof result.refusalId === 'string' && /^[a-f0-9-]{36}$/.test(result.refusalId) ? result.refusalId : null);
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

/** Shared failure descriptions for server answers and dashboard run details. */
export const RUN_FAILURE_WORDS: Readonly<Record<string, string>> = {
  ...RUN_CONTROL_REFUSAL_WORDS,
  machine_did_not_start: 'No machine started the task within a day.',
  machine_unresponsive: 'Myco heard nothing from it until its time limit passed, so Myco ended it. Whether its machine stopped is not known.',
  task_start_failed: 'The machine could not start the task.',
  model_not_applied: 'The agent couldn’t use the chosen model.',
  report_without_audit: 'The agent didn’t account for the steps it took, so its work couldn’t be checked.',
  agent_not_signed_in: 'The agent isn’t signed in on the machine that ran it.',
  agent_rate_limited: 'The agent’s provider limited how often it could ask, so it stopped.',
  agent_model_refused: 'The agent’s model refused to carry on with the task.',
  agent_timed_out: 'The agent ran out of time before it finished.',
  agent_crashed: 'The agent quit unexpectedly before it finished.',
  agent_failed: 'The agent reported an error and stopped.',
  agent_launch_failed: 'The agent couldn’t be started on the machine that ran it.',
  agent_protocol_error: 'The agent answered in a way the machine couldn’t read, so the task stopped.',
  agent_permission_refused: 'The agent was refused a tool the task needs.',
  agent_tools_unlisted: 'The machine couldn’t list the task’s tools for the agent.',
  agent_tools_unused: 'The agent didn’t use Myco’s tools.',
  run_cancelled: 'A member cancelled this run.',
  run_failed: 'The task stopped before it could finish.',
};

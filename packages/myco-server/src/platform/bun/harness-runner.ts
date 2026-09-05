/**
 * The self-hosted launch: a runtime started over HTTP by the supervisor that
 * shares this process's network namespace.
 *
 * The adapter owns the transport and therefore the callback address:
 * `MYCO_SERVER_URL` is the origin this process is reachable at, resolved from
 * the port it bound, never taken from the request that caused the dispatch.
 *
 * A refusal is thrown. A supervisor that is draining, restarting, or not
 * reachable is `RuntimeDraining` and the dispatcher returns the run to the
 * queue; one already running the run a launch names is `RuntimeAlreadyHolding`,
 * which the dispatcher counts as landed; every other refusal is terminal, and
 * its word rides the failed row.
 *
 * A 401 is among the terminal ones on purpose. Both services mount the same
 * secret, so a supervisor refusing this deployment's token is a stack whose two
 * halves disagree: an operator's fix, not a wait. Telling that operator
 * promptly requires the row to fail rather than sit in the queue for its day.
 * Unavailability is read from the status as well as the word: a 503 is a
 * runtime that is not serving whatever body it sent, including none.
 */
import { RuntimeAlreadyHolding, RuntimeDraining } from '../../core/harness.js';
import type { ServerEnv } from '../../core/adapters.js';

export interface HttpHarnessOptions {
  /** Where the supervisor listens, as this process reaches it. */
  url: string;
  /** The bearer token the supervisor checks; the operator mounts it into both services. */
  token: string;
  /** The origin the runtime posts its claim, status, and reports back to, read at each launch. */
  callbackOrigin: () => string;
  /** How long this launch waits for an answer; the dispatcher awaits this call, and the drain awaits the dispatcher. */
  timeoutMs?: number;
}

/** The supervisor's answer to a launch it did not accept. */
interface Refusal {
  refusal?: unknown;
  error?: unknown;
}

/** The word a supervisor answers with while it is stopping. */
const DRAINING = 'draining';

/** The word a supervisor answers when it is already running the run a launch names, and the status it rides. */
const DUPLICATE = 'duplicate';
const CONFLICT_STATUS = 409;

/** The status a runtime that is not serving answers with, whatever body it carries. */
const UNAVAILABLE_STATUS = 503;

/**
 * How long a launch waits for the supervisor's answer.
 *
 * The dispatcher awaits this call and the drain awaits the dispatcher, so the
 * tick's own progress requires this call to end. A launch is one small POST
 * against a process on this machine's own loopback; a wait past this is a
 * runtime that is not answering.
 */
export const LAUNCH_TIMEOUT_MS = 10_000;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

export function httpHarnessLaunch(options: HttpHarnessOptions): NonNullable<ServerEnv['harnessLaunch']> {
  const endpoint = `${options.url.replace(/\/+$/, '')}/launch`;
  return async (spec) => {
    const callbackOrigin = options.callbackOrigin();
    let answered: Response;
    try {
      answered = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: spec.runId,
          timeoutSeconds: spec.timeoutSeconds,
          envVars: { ...spec.envVars, MYCO_SERVER_URL: callbackOrigin },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? LAUNCH_TIMEOUT_MS),
      });
    } catch (error) {
      // A supervisor between restarts, and one that takes the call and answers
      // nothing inside the bound, are both "not now": the run waits in the queue
      // and the next drain offers it again.
      throw new RuntimeDraining(`the harness runtime at ${options.url} could not be reached: ${error instanceof Error ? error.message : String(error)}`, 'unreachable');
    }
    if (answered.ok) return;
    const body = await answered.json().catch(() => null) as Refusal | null;
    const word = text(body?.refusal) ?? `status ${answered.status}`;
    const detail = text(body?.error);
    const message = `the harness runtime refused to launch ${spec.runId}: ${word}${detail === null ? '' : ` (${detail})`}`;
    if (answered.status === UNAVAILABLE_STATUS || word === DRAINING) throw new RuntimeDraining(message, 'draining');
    if (answered.status === CONFLICT_STATUS && word === DUPLICATE) throw new RuntimeAlreadyHolding(message);
    throw new Error(message);
  };
}

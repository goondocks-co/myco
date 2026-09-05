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
 * queue; every other refusal is terminal, and its word rides the failed row.
 * Unavailability is read from the status as well as the word: a 503 is a
 * runtime that is not serving whatever body it sent, including none.
 */
import { RuntimeDraining } from '../../core/harness.js';
import type { ServerEnv } from '../../core/adapters.js';

export interface HttpHarnessOptions {
  /** Where the supervisor listens, as this process reaches it. */
  url: string;
  /** The bearer token the supervisor checks; the operator mounts it into both services. */
  token: string;
  /** The origin the runtime posts its claim, status, and reports back to, read at each launch. */
  callbackOrigin: () => string;
}

/** The supervisor's answer to a launch it did not accept. */
interface Refusal {
  refusal?: unknown;
  error?: unknown;
}

/** The word a supervisor answers with while it is stopping. */
const DRAINING = 'draining';

/** The status a runtime that is not serving answers with, whatever body it carries. */
const UNAVAILABLE_STATUS = 503;

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
      });
    } catch (error) {
      // A supervisor between restarts answers nothing, which is the same "not
      // now" as the word it answers while it stops.
      throw new RuntimeDraining(`the harness runtime at ${options.url} could not be reached: ${error instanceof Error ? error.message : String(error)}`, 'unreachable');
    }
    if (answered.ok) return;
    const body = await answered.json().catch(() => null) as Refusal | null;
    const word = text(body?.refusal) ?? `status ${answered.status}`;
    const detail = text(body?.error);
    const message = `the harness runtime refused to launch ${spec.runId}: ${word}${detail === null ? '' : ` (${detail})`}`;
    if (answered.status === UNAVAILABLE_STATUS || word === DRAINING) throw new RuntimeDraining(message, 'draining');
    throw new Error(message);
  };
}

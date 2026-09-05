/**
 * The self-hosted launch: a runtime started over HTTP by the supervisor that
 * shares this process's network namespace.
 *
 * The Cloudflare target starts one container per run through a Durable Object.
 * Here a sibling service holds the runtimes, and a launch is one POST. The
 * adapter owns the transport, so it also owns the address the runtime calls
 * back to: `MYCO_SERVER_URL` is rewritten to the origin this process is
 * actually reachable at, never taken from the request that caused the dispatch.
 *
 * A refusal is thrown, not swallowed. The dispatcher marks the run failed and
 * carries the message, so the supervisor's own word — draining, duplicate,
 * spawn — is what an operator reads on the row.
 */
import type { ServerEnv } from '../../core/adapters.js';

export interface HttpHarnessOptions {
  /** Where the supervisor listens, as this process reaches it. */
  url: string;
  /** The bearer token the supervisor checks; the operator mounts it into both services. */
  token: string;
  /** The origin the runtime posts its claim, status, and reports back to. */
  callbackOrigin: string;
}

/** The supervisor's answer to a launch it did not accept. */
interface Refusal {
  refusal?: unknown;
  error?: unknown;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

export function httpHarnessLaunch(options: HttpHarnessOptions): NonNullable<ServerEnv['harnessLaunch']> {
  const endpoint = `${options.url.replace(/\/+$/, '')}/launch`;
  return async (spec) => {
    let answered: Response;
    try {
      answered = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: spec.runId,
          timeoutSeconds: spec.timeoutSeconds,
          envVars: { ...spec.envVars, MYCO_SERVER_URL: options.callbackOrigin },
        }),
      });
    } catch (error) {
      throw new Error(`the harness runtime at ${options.url} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (answered.ok) return;
    const body = await answered.json().catch(() => null) as Refusal | null;
    const word = text(body?.refusal) ?? `status ${answered.status}`;
    const detail = text(body?.error);
    throw new Error(`the harness runtime refused to launch ${spec.runId}: ${word}${detail === null ? '' : ` (${detail})`}`);
  };
}

import type { WorkerUsage } from '@goondocks/myco-shared/worker-usage';

/**
 * One run-event model, behind every driver.
 *
 * A driver's whole obligation is to turn its harness's own stream into this
 * union. Nothing downstream of a driver knows which harness ran, which is what
 * lets a fourth one be added without touching the loop, the reporting, or the
 * gate that holds all of them to the same contract.
 *
 * The five stop reasons are the agent protocol's own. A later revision of that
 * protocol delivers them from a different place in its stream while keeping the
 * same five values, so a driver written against it changes where it reads a
 * stop reason and not what it answers.
 */

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' | 'error';

export type RunEvent =
  | { kind: 'started'; harness: string; sessionId: string | null }
  | { kind: 'message'; role: 'assistant' | 'thought'; text: string }
  /** `detail` says why a call failed where the driver itself refused it. */
  | { kind: 'tool_call'; name: string; status: 'started' | 'ok' | 'error'; detail?: string }
  | ({ kind: 'usage' } & WorkerUsage)
  | { kind: 'ended'; stop: StopReason; detail: string | null };

/** What every driver is given, and the only thing it needs to start a harness. */
export interface RunSpec {
  /** The prompt the server built, carried on the run's row. */
  prompt: string;
  /** A directory of this run's own: the MCP configuration and anything the harness writes. */
  scratchDir: string;
  /** The MCP configuration file this run's harness must read, and nothing else. */
  mcpConfigPath: string;
  /** The Deployment's harness credential, where it holds one; empty where the harness uses its own login. */
  credentialEnv: Record<string, string>;
  /** The run has prepared source for file and Git inspection, without repository writes. */
  sourceReadOnly?: boolean;
}

/**
 * A driver: a harness, started and read as one event stream.
 *
 * A driver carries no bound of its own. What releases a hung harness is the
 * Deployment: the run outruns its budget, the sweep takes the lease, the next
 * renewal is declined, and the worker aborts the signal it passed in. One clock
 * decides, and it is the one that also decides what the run's row says.
 */
export interface Driver {
  id: string;
  run(spec: RunSpec, signal: AbortSignal): AsyncIterable<RunEvent>;
}

/**
 * Whether a completed stream describes a harness that finished its turn.
 *
 * A run's outcome is not decided here and never by a driver: the server counts
 * the writes a run owed and closes it on those. This answers only whether the
 * harness itself got to the end, which is what separates a run that did nothing
 * from a run whose work the server has yet to verify.
 */
export function reachedEnd(events: readonly RunEvent[]): boolean {
  const last = events.at(-1);
  return last !== undefined && last.kind === 'ended' && last.stop === 'end_turn';
}

/** How many kinds of failed call a note names before it counts the rest. */
const NOTED_FAILURES = 5;

/**
 * What a run's record says about the calls that failed or were refused in it,
 * or null where none did.
 *
 * A harness can end its turn cleanly right after a call fails or is refused,
 * with the rest of its work never done, and the stop reason alone reads as a
 * run that finished. So the calls are named, each with why where the driver
 * knows it and how many times it failed, and the note says so when the turn
 * ended right after one: when the last thing the agent did before its turn
 * ended was a call that failed, with no message or successful call after it.
 */
export function failedCallsNote(events: readonly RunEvent[]): string | null {
  const failed = new Map<string, number>();
  let endedOnFailure = false;
  for (const event of events) {
    if (event.kind === 'tool_call' && event.status === 'error') {
      const named = event.detail === undefined ? event.name : `${event.name} (${event.detail})`;
      failed.set(named, (failed.get(named) ?? 0) + 1);
      endedOnFailure = true;
    } else if ((event.kind === 'tool_call' && event.status === 'ok') || (event.kind === 'message' && event.role === 'assistant')) {
      endedOnFailure = false;
    }
  }
  if (failed.size === 0) return null;
  const total = [...failed.values()].reduce((sum, count) => sum + count, 0);
  const named = [...failed].slice(0, NOTED_FAILURES).map(([call, count]) => (count === 1 ? call : `${call} ×${count}`));
  const rest = failed.size > NOTED_FAILURES ? `, and ${failed.size - NOTED_FAILURES} more` : '';
  const calls = total === 1 ? 'a call failed or was refused' : `${total} calls failed or were refused`;
  return `${calls}: ${named.join('; ')}${rest}${endedOnFailure ? '; the turn ended right after the last of them' : ''}`;
}

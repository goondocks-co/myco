import type { WorkerUsage, ExecutionIdentity } from '@goondocks/myco-shared/worker-usage';
import type { ExecutionProfile, ProfileRefusal } from '@goondocks/myco-shared/execution-profile';

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
  /** `detail` says why a call failed, where the driver refused it or the harness reported why. */
  | { kind: 'tool_call'; name: string; status: 'started' | 'ok' | 'error'; detail?: string }
  | { kind: 'identity'; identity: ExecutionIdentity; snapshot?: true }
  | ({ kind: 'usage' } & WorkerUsage)
  /** `refusal` is set where the driver ended the run on the harness's refusal of the claimed profile. */
  | { kind: 'ended'; stop: StopReason; detail: string | null; refusal?: ProfileRefusal };

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
  /** The model and effort this run is required to apply. */
  profile?: ExecutionProfile;
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
  /**
   * The environment the harness is started under, for a run and for a listing of its models alike: its isolation
   * (a configuration home of its own built under `scratchDir`, a run agent), the credential it signs in with, and
   * which of the worker's own variables it never inherits. A run adds only what its grant needs on top.
   */
  launch(spec: LaunchSpec): Launch;
}

/**
 * What a harness is started for: a directory of its own, and the credential the Deployment handed, empty where the
 * harness signs in with the machine's own login. A run also names its server's configuration, its profile and
 * whether it reads source; a listing of models names none of them.
 */
export type LaunchSpec = Pick<RunSpec, 'scratchDir' | 'credentialEnv'> & Partial<Pick<RunSpec, 'mcpConfigPath' | 'profile' | 'sourceReadOnly'>>;

/** The variables a harness is started with over the worker's own, and those of the worker's own it never inherits. */
export interface Launch {
  env: Record<string, string>;
  omitInherited: readonly string[];
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

/** The longest account of why one call failed that a run's record keeps. */
export const CALL_DETAIL_CHARS = 200;

/** Why a call failed as the harness reported it, as one bounded line, or undefined where it said nothing. */
export function callFailureDetail(said: string | null): string | undefined {
  const line = said?.split('\n').map((part) => part.trim()).find((part) => part.length > 0);
  if (line === undefined) return undefined;
  return line.length > CALL_DETAIL_CHARS ? `${line.slice(0, CALL_DETAIL_CHARS - 1)}…` : line;
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

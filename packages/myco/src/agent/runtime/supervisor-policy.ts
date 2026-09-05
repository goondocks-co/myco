/**
 * What the harness supervisor decides, apart from how it does it.
 *
 * `supervisor.ts` supplies the mechanism — a socket, child processes, signal
 * handlers — and every rule it applies is here, so the rules are exercised
 * without a process. This is the same split the Cloudflare hold uses
 * (`packages/myco-server/src/platform/cloudflare/run-hold.ts`).
 *
 * One rule is absent on purpose: nothing here counts a fleet. The dispatcher's
 * queue is the only bound on how much runs at once, and a second count in the
 * supervisor refuses what that queue admitted — a launch refusal is a terminal
 * `failed` row, not a wait.
 */

/** Why a launch was not accepted, and the status each word answers with. */
export const LAUNCH_REFUSAL_STATUS = {
  /** The body named no run, or named one that is not a single path segment. */
  invalid: 400,
  /** A child is already running under this run id. */
  duplicate: 409,
  /** A stop signal has arrived; this supervisor takes no new run. */
  draining: 503,
  /** The child could not be started. */
  spawn: 500,
} as const;

export type LaunchRefusal = keyof typeof LAUNCH_REFUSAL_STATUS;

/**
 * The run ids a launch may name.
 *
 * A run gets a working directory named after it, so a run id has to be one
 * path segment; the dispatcher mints `run_<uuid>`.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** What the supervisor knows about itself when a decision is asked of it. */
export interface SupervisorState {
  /** Whether a stop signal has arrived. */
  draining: boolean;
  /** The run ids whose children are alive, in launch order. */
  running: readonly string[];
}

export type LaunchDecision =
  | { admit: true }
  | { admit: false; refusal: Exclude<LaunchRefusal, 'spawn'> };

/**
 * Whether to start a child for this run.
 *
 * The drain is answered before the duplicate: a supervisor that is going away
 * takes nothing, and telling a caller which of the two reasons applied would
 * describe a run it is not going to start anyway.
 */
export function decideLaunch(state: SupervisorState, runId: unknown): LaunchDecision {
  if (state.draining) return { admit: false, refusal: 'draining' };
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return { admit: false, refusal: 'invalid' };
  if (state.running.includes(runId)) return { admit: false, refusal: 'duplicate' };
  return { admit: true };
}

/** What is left, and whether the process leaves now, once a child has gone. */
export interface ChildExitDecision {
  /** The run ids still running. */
  running: string[];
  /** Whether the drain is complete: the last child of a draining supervisor has gone. */
  exit: boolean;
}

/**
 * Answer one child's exit.
 *
 * A supervisor that is not draining outlives its children and keeps serving; a
 * draining one exists only for the runs still in flight, and leaves with the
 * last of them.
 */
export function decideChildExit(state: SupervisorState, runId: string): ChildExitDecision {
  const running = state.running.filter((id) => id !== runId);
  return { running, exit: state.draining && running.length === 0 };
}

export type SignalDecision =
  /** Leave now: nothing is running, or an operator has asked twice. */
  | { action: 'exit' }
  /** Refuse new launches, ask these children to stop, and wait for them. */
  | { action: 'drain'; stop: readonly string[] };

/**
 * Answer a stop signal.
 *
 * The first signal is a drain: the runs in flight are asked to stop, post their
 * own endings, and the supervisor leaves behind the last of them. A second
 * signal is an operator who is done waiting, so it leaves at once, and so does
 * a supervisor holding nothing.
 */
export function decideSignal(state: SupervisorState): SignalDecision {
  if (state.draining || state.running.length === 0) return { action: 'exit' };
  return { action: 'drain', stop: [...state.running] };
}

/**
 * Whether a request carries this supervisor's token.
 *
 * The scheme is compared case-insensitively, as HTTP defines it; the token
 * itself is compared exactly.
 */
export function bearerMatches(header: string | null | undefined, token: string): boolean {
  if (typeof header !== 'string' || token === '') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match !== null && match[1]!.trim() === token;
}

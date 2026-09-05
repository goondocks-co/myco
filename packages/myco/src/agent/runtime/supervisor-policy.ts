/**
 * What the harness supervisor decides, apart from how it does it.
 *
 * `supervisor.ts` supplies the mechanism — a socket, child processes, signal
 * handlers — and applies these rules to it.
 */
import { timingSafeEqual } from 'node:crypto';

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

/** The run ids a launch may name: one path segment, which is what a working directory can be named after. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** How often the kill is offered again to a child that is still there. */
export const BACKSTOP_RETRY_MS = 5_000;

/**
 * How long a child may outlive its own bound before the supervisor kills it.
 *
 * `tests/agent/supervisor-policy.test.ts` holds this equal to the margin the
 * Deployment's sweep and the hosted hold use (`RUN_OVERRUN_MARGIN_MS`).
 */
export const CHILD_OVERRUN_MARGIN_MS = 120_000;

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

/** Whether to start a child for this run. A draining supervisor takes nothing, whatever else is true of the run. */
export function decideLaunch(state: SupervisorState, runId: unknown): LaunchDecision {
  if (state.draining) return { admit: false, refusal: 'draining' };
  if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) return { admit: false, refusal: 'invalid' };
  if (state.running.includes(runId)) return { admit: false, refusal: 'duplicate' };
  return { admit: true };
}

/** When a child that started at `startedAt` is killed, whatever it is doing. */
export function childDeadline(startedAt: number, timeoutSeconds: number, marginMs: number = CHILD_OVERRUN_MARGIN_MS): number {
  const bound = Number.isFinite(timeoutSeconds) ? Math.max(0, timeoutSeconds) : 0;
  return startedAt + bound * 1000 + Math.max(0, marginMs);
}

/** What is left, and whether the process leaves now, once a child has gone. */
export interface ChildExitDecision {
  /** The run ids still running. */
  running: string[];
  /** Whether the drain is complete: the last child of a draining supervisor has gone. */
  exit: boolean;
}

/** Answer one child's exit. A draining supervisor leaves with the last run it holds; any other keeps serving. */
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
 * The first signal asks the runs in flight to stop and post their own endings;
 * the supervisor leaves behind the last of them. A second signal, or a
 * supervisor holding nothing, leaves at once.
 */
export function decideSignal(state: SupervisorState): SignalDecision {
  if (state.draining || state.running.length === 0) return { action: 'exit' };
  return { action: 'drain', stop: [...state.running] };
}

/** Whether a request carries this supervisor's token: the scheme case-insensitively, as HTTP defines it, and the token in constant time. */
export function bearerMatches(header: string | null | undefined, token: string): boolean {
  if (typeof header !== 'string' || token === '') return false;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const offered = Buffer.from(match[1]!.trim(), 'utf8');
  const held = Buffer.from(token, 'utf8');
  return offered.length === held.length && timingSafeEqual(offered, held);
}

/**
 * The unprivileged user a child runs as when this supervisor can drop privilege.
 *
 * An account of the image's own, owning nothing: the launch token is mounted in
 * the filesystem the children share, and a uid a host is unlikely to also use
 * is what keeps a mounted secret out of a run's reach.
 */
export const DEFAULT_RUNTIME_USER = 'runtime';

/** Who a child is dropped to, and where that user's home is. */
export interface RuntimeUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

/** The tools a supervisor found on its PATH; either absent, the plan says what it can still do. */
export interface LaunchTools {
  /** Starts the child in a session of its own, so a signal reaches its whole tree. */
  setsid: string | null;
  /** Drops the child to another user before it executes. */
  setpriv: string | null;
}

/** How one child is started, and what that gives the supervisor over it. */
export interface ChildLaunchPlan {
  cmd: string[];
  /** Whether the child leads a process group, so a signal to `-pid` reaches its children too. */
  groupLed: boolean;
  /** Whether the child runs as a different user from this process. */
  dropped: boolean;
}

/**
 * The command that starts one child.
 *
 * `setsid` puts the child in a session of its own so the tree it starts — the
 * agent CLI among it — is signalled with it. `setpriv` drops it to the
 * unprivileged user, so a child cannot read what the supervisor's own user can:
 * the launch token is mounted in the same filesystem.
 */
export function childLaunchPlan(options: {
  runtimeCommand: string;
  entry: string;
  tools: LaunchTools;
  /** The user to drop to, or null when this process is already unprivileged. */
  runAs: RuntimeUser | null;
}): ChildLaunchPlan {
  const { tools, runAs } = options;
  const dropped = runAs !== null && tools.setpriv !== null;
  return {
    cmd: [
      ...(tools.setsid === null ? [] : [tools.setsid]),
      ...(dropped ? [tools.setpriv!, `--reuid=${runAs!.name}`, `--regid=${runAs!.name}`, '--init-groups'] : []),
      options.runtimeCommand,
      options.entry,
    ],
    groupLed: tools.setsid !== null,
    dropped,
  };
}

/** A file's ownership and permission bits, as `statSync` reports them. */
export interface FileOwnership {
  mode: number;
  uid: number;
  gid: number;
}

/**
 * Whether `runtime` could read this file.
 *
 * The launch token is mounted in the filesystem the children run in, so
 * dropping their user protects it only while its bits actually withhold it.
 */
export function readableBy(file: FileOwnership, runtime: RuntimeUser): boolean {
  const mode = file.mode & 0o777;
  if ((mode & 0o004) !== 0) return true;
  if ((mode & 0o040) !== 0 && file.gid === runtime.gid) return true;
  if ((mode & 0o400) !== 0 && file.uid === runtime.uid) return true;
  return false;
}

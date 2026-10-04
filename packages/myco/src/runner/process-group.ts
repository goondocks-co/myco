/**
 * A harness started as a process group of its own, and stopped as one.
 *
 * A harness starts helpers of its own — a background `git fetch`, a server, a shell — and a signal sent to the
 * harness alone leaves them running after it exits. So every harness a worker starts, for a run or for a listing,
 * leads a group of its own, and stopping it signals helpers that remain in that group: SIGTERM first, SIGKILL to
 * whatever is still in the group once `STOP_GRACE_MS` has passed, then the leader's `close` is waited for, bounded
 * by the same grace.
 * Windows has no process groups, so there the harness alone is signalled.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beginRunProcess } from './run-directory.js';

/** How long a group is given to end on SIGTERM before what remains of it is killed. */
export const STOP_GRACE_MS = 2_000;
/** How often a stopping group is looked at. */
const STOP_POLL_MS = 50;

const GROUPS = process.platform !== 'win32';

/**
 * The codes a signal to a group answers where some process of it could not be signalled: ESRCH where none is left,
 * and EPERM, which macOS answers for a group holding an exited process not yet reaped, beside any it did signal.
 */
const NONE_LEFT: ReadonlySet<string | undefined> = new Set(['ESRCH', 'EPERM']);

/** Whether any process of the group `pid` leads is left; one exited and not yet reaped counts until it is. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (GROUPS) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (!NONE_LEFT.has((error as NodeJS.ErrnoException).code)) throw error;
  }
}

/** When the leader closed its standard streams and exited, recorded from the moment it was spawned. */
const CLOSED = new WeakMap<ChildProcess, Promise<void>>();

/** Start `command` as the leader of a process group of its own. */
export function spawnGroup(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, [...args], { ...options, detached: GROUPS });
  CLOSED.set(child, new Promise((resolve) => {
    child.once('close', () => resolve());
    child.once('error', () => resolve());
  }));
  return child;
}

export interface OwnedProcess {
  child: ChildProcess;
  /** The leader's status after its group and streams have been disposed. */
  exit: Promise<number>;
  /** Stop the group once and await its bounded disposal. */
  dispose(): Promise<void>;
  /** Surface a failed ownership registration inside the consumer's disposal scope. */
  assertStarted(): void;
  /** Whether disposal interrupted an open stdout pipe. */
  pipesClosed(): boolean;
}

/** Own a harness's group until disposal, including helpers holding pipes after the leader exits. */
export function spawnOwnedGroup(command: string, args: readonly string[], options: SpawnOptions, signal: AbortSignal, runDirectory?: string): OwnedProcess {
  const cwd = options.cwd === undefined || typeof options.cwd === 'string' ? options.cwd : fileURLToPath(options.cwd);
  const allocation = runDirectory ?? cwd;
  const registration = allocation === undefined ? null : beginRunProcess(allocation);
  let child: ChildProcess;
  try { child = spawnGroup(command, args, options); } catch (error) { registration?.cancelled(); throw error; }
  let disposal: Promise<void> | undefined;
  let pipesClosed = false;
  const dispose = (): Promise<void> => {
    disposal ??= stopGroup(child).finally(() => {
      pipesClosed = child.stdout !== null && !child.stdout.destroyed;
      for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe?.destroy();
      signal.removeEventListener('abort', abort);
    });
    return disposal;
  };
  let resolveExit: (code: number) => void;
  let rejectExit: (error: unknown) => void;
  const exit = new Promise<number>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  const finish = (code: number): void => { void dispose().then(() => { resolveExit(code); }, rejectExit); };
  const abort = (): void => { void dispose().catch(rejectExit); };
  child.once('exit', (code) => { finish(code ?? -1); });
  child.once('error', () => { finish(-1); });
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let failure: { error: unknown } | undefined;
  try {
    if (child.pid === undefined) registration?.cancelled();
    else registration?.started(child.pid);
  } catch (error) { failure = { error }; abort(); }
  return { child, exit, dispose, assertStarted: () => { if (failure !== undefined) throw failure.error; }, pipesClosed: () => pipesClosed };
}

/** A wait of `ms`, the one timer a stop holds. */
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Stop every process of the group `child` leads, its own helpers included, whether or not the leader has already
 * exited, and answer once the group is gone and the leader has closed, or the grace after SIGKILL has passed.
 */
export async function stopGroup(child: ChildProcess, graceMs: number = STOP_GRACE_MS): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  const closed = CLOSED.get(child) ?? Promise.resolve();
  const gone = (): boolean => (GROUPS ? !groupAlive(pid) : child.exitCode !== null || child.signalCode !== null);
  if (!gone()) {
    signalGroup(child, 'SIGTERM');
    const deadline = Date.now() + graceMs;
    while (!gone() && Date.now() < deadline) await pause(STOP_POLL_MS);
    if (!gone()) signalGroup(child, 'SIGKILL');
  }
  await Promise.race([closed, pause(graceMs)]);
}

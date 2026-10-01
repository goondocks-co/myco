/**
 * The member helper (#1561): the one process that does a project's network work, so no hook has to.
 *
 * A hook appends what it captured and kicks the helper (`kickHelper`). The helper is started detached, takes the
 * project's helper lock, and runs passes (`runHelper`) until nothing is left: each pass ships the project's spool. It
 * is not resident: when a pass finds nothing new for a short linger it releases the lock and exits, and it never runs
 * past its deadline.
 *
 * Two files under the project's spool coordinate it:
 * - `helper.lock`, held through `LifecycleLock` for as long as a helper runs: the operating system releases it when the
 *   helper dies, so a crashed helper never blocks the next.
 * - `helper.dirty`, written by every kick: work arrived. The helper deletes it before each pass, and checks it again
 *   after it releases the lock, so a kick that lands while the helper is on its way out is never lost: either this
 *   helper sees the mark and takes the lock again, or the kick found the lock free and started the next one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LifecycleLock, type LockHandle } from '../utils/lifecycle-lock.js';
import { selfExec } from '../runtime/self-exec.js';
import { spawnDetached, type DetachedSpawn, type DetachedStart } from '../runtime/spawn-detached.js';
import { ensureMemberDir } from './store.js';
import { spoolDirFor } from './spool.js';

export const HELPER_LOCK_FILE = 'helper.lock';
export const HELPER_DIRTY_FILE = 'helper.dirty';
/** The longest a helper runs, whatever is left: the next kick starts another. */
export const HELPER_DEADLINE_MS = 120_000;
/** How long a helper with nothing new waits for more before it exits, so a burst of hooks starts one helper, not many. */
export const HELPER_LINGER_MS = 3_000;
/** How often a lingering helper looks for new work. */
export const HELPER_POLL_MS = 200;
/** The helper's log, rotated past this size to `helper.log.1`. */
export const HELPER_LOG_MAX_BYTES = 1_000_000;

export interface HelperPaths {
  lock: string;
  dirty: string;
}

export function helperPaths(projectId: string, mycoHome: string): HelperPaths {
  const dir = spoolDirFor(projectId, mycoHome);
  return { lock: path.join(dir, HELPER_LOCK_FILE), dirty: path.join(dir, HELPER_DIRTY_FILE) };
}

/** What a kick did: a helper already holds the lock and will see the mark, one was started, or none could be. */
export type KickOutcome = { kind: 'running' } | ({ kind: 'started' } & DetachedStart) | { kind: 'failed' };

/**
 * Tell the project's helper there is work, starting one if none runs. Never waits on anything but two local files.
 *
 * The mark is written first, then the lock is probed without blocking. A held lock is a running helper, which reads
 * the mark before it exits. A free lock starts a helper; when two kicks race to start one, the second helper finds the
 * lock taken and exits at once.
 */
export function kickHelper(opts: { projectId: string; mycoHome: string; spawn?: DetachedSpawn }): KickOutcome {
  const paths = helperPaths(opts.projectId, opts.mycoHome);
  ensureMemberDir(path.dirname(paths.dirty), opts.mycoHome);
  fs.writeFileSync(paths.dirty, '', { mode: 0o600 });
  const probe = LifecycleLock.acquire(paths.lock, { command: 'myco member helper (probe)' });
  if (!probe.acquired) return { kind: 'running' };
  probe.lock.release();
  const self = selfExec();
  const start = (opts.spawn ?? spawnDetached)(self.path, [...self.args, 'member', 'helper', '--project', opts.projectId, '--home', opts.mycoHome], {
    cwd: opts.mycoHome,
  });
  return start.started ? { kind: 'started', ...start } : { kind: 'failed' };
}

export interface HelperRunOptions {
  projectId: string;
  mycoHome: string;
  /** One pass: ship what the project's spool holds, within `deadline`. */
  pass: (deadline: number) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  lingerMs?: number;
  pollMs?: number;
  /** Called each time the lock is let go, before the last look for new work: where a late kick lands. */
  onReleased?: () => void;
}

export interface HelperRunResult {
  /** `busy`: another helper holds the lock, and this one did nothing. */
  endedBy: 'idle' | 'deadline' | 'busy';
  passes: number;
}

/** Run passes under the project's helper lock until no work is left, the linger runs out, or the deadline passes. */
export async function runHelper(opts: HelperRunOptions): Promise<HelperRunResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now() + (opts.deadlineMs ?? HELPER_DEADLINE_MS);
  const linger = opts.lingerMs ?? HELPER_LINGER_MS;
  const poll = opts.pollMs ?? HELPER_POLL_MS;
  const paths = helperPaths(opts.projectId, opts.mycoHome);
  ensureMemberDir(path.dirname(paths.lock), opts.mycoHome);
  const dirty = (): boolean => fs.existsSync(paths.dirty);
  const clearDirty = (): void => { try { fs.unlinkSync(paths.dirty); } catch { /* not marked */ } };

  let passes = 0;
  let held: LockHandle | null = take(paths.lock);
  if (held === null) return { endedBy: 'busy', passes };
  try {
    for (;;) {
      // Work until a pass leaves nothing new behind it for the length of the linger.
      for (;;) {
        clearDirty();
        await opts.pass(deadline);
        passes += 1;
        if (now() >= deadline) return { endedBy: 'deadline', passes };
        const until = Math.min(deadline, now() + linger);
        while (!dirty() && now() < until) await sleep(poll);
        if (!dirty()) break;
      }
      held.release();
      held = null;
      opts.onReleased?.();
      // A kick between the last look and the release found the lock held and left only its mark: take it up again.
      if (!dirty() || now() >= deadline) return { endedBy: now() >= deadline ? 'deadline' : 'idle', passes };
      held = take(paths.lock);
      if (held === null) return { endedBy: 'idle', passes };
    }
  } finally {
    held?.release();
  }
}

function take(lockPath: string): LockHandle | null {
  const acquired = LifecycleLock.acquire(lockPath, { command: 'myco member helper' });
  return acquired.acquired ? acquired.lock : null;
}

/** `<MYCO_HOME>/logs/helper.log`. */
export function helperLogPath(mycoHome: string): string {
  return path.join(mycoHome, 'logs', 'helper.log');
}

/**
 * Send this process's stderr to the helper's log: a helper is started with no stdio, and every line a pass writes
 * there is a line someone reading `myco member status` or a bug report needs. The log is rotated once past
 * `HELPER_LOG_MAX_BYTES`, keeping one older file. Answers the call that puts stderr back.
 */
export function routeStderrToHelperLog(mycoHome: string, projectId: string): () => void {
  const file = helperLogPath(mycoHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > HELPER_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* no log yet */ }
  const write = (chunk: unknown): boolean => {
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${projectId} ${String(chunk)}${String(chunk).endsWith('\n') ? '' : '\n'}`);
    } catch { /* a log that cannot be written costs the line, never the pass */ }
    return true;
  };
  const stream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const original = stream.write;
  stream.write = write;
  return () => { stream.write = original; };
}

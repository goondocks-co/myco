/**
 * The member helper (#1561): the one process that does a project's network work, so no hook has to.
 *
 * A hook appends what it captured and kicks the helper (`kickHelper`). The helper is started detached, takes the
 * project's helper lock, and runs passes (`runHelper`) until nothing is left: each pass ships the project's spool. It
 * is not resident: when a pass finds nothing new for a short linger it releases the lock and exits, and it never runs
 * past its deadline.
 *
 * Files under the project's spool coordinate it:
 * - `helper.lock`, held through `LifecycleLock` for as long as a helper runs: the operating system releases it when the
 *   helper dies, so a crashed helper never blocks the next.
 * - `helper.dirty`, written by every kick: work arrived. The helper removes it before each pass, and checks it again
 *   after it releases the lock, so a kick that lands while the helper is on its way out is never lost: either this
 *   helper sees the mark and takes the lock again (or, at its deadline, starts its successor), or the kick found the
 *   lock free and started the next one.
 * - `helper.probe`, written by a turn's or a session's end: the pass that removes it dials past the offline latch.
 * - `helper.starting`, claimed by the kick that starts a helper, until that helper takes the lock: every other kick in
 *   between leaves its mark and starts nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LifecycleLock, type LockHandle } from '../utils/lifecycle-lock.js';
import { selfExec } from '../runtime/self-exec.js';
import { spawnDetached, startedContained, type DetachedSpawn, type DetachedStart } from '../runtime/spawn-detached.js';
import { ensureMemberDir } from './store.js';
import { MemberSpool, spoolDirFor } from './spool.js';
import { deploymentUrl } from './registry.js';
import { autoJoinDir, JOIN_BUCKET } from './auto-join.js';

export const HELPER_LOCK_FILE = 'helper.lock';
export const HELPER_DIRTY_FILE = 'helper.dirty';
export const HELPER_PROBE_FILE = 'helper.probe';
export const HELPER_STARTING_FILE = 'helper.starting';
/** The longest a helper runs; when work is still waiting then, it starts its successor. */
export const HELPER_DEADLINE_MS = 120_000;
/** How long a helper with nothing new waits for more before it exits, so a burst of hooks starts one helper, not many. */
export const HELPER_LINGER_MS = 3_000;
/** How often a lingering helper looks for new work. */
export const HELPER_POLL_MS = 200;
/** The helper's log, rotated past this size to `helper.log.1`. */
export const HELPER_LOG_MAX_BYTES = 1_000_000;
/** How long a started helper that has not yet taken the lock keeps other kicks from starting another. */
export const HELPER_START_GRACE_MS = 30_000;
/** How long a start claimed and not yet given a process counts as under way. */
const HELPER_CLAIM_GRACE_MS = 5_000;

export interface HelperPaths {
  lock: string;
  /** Work arrived: any kick. */
  dirty: string;
  /** Work arrived that must reach the Deployment past the offline latch: a turn's or a session's end. */
  probe: string;
  /** A helper was started and has not taken the lock yet. */
  starting: string;
}

/**
 * The files a bucket's helper coordinates through: a project's in its spool, and the join bucket's (`JOIN_BUCKET`, the
 * repositories joining a project) in the auto-join folder.
 */
export function helperPaths(projectId: string, mycoHome: string, serverUrl?: string): HelperPaths {
  const dir = projectId === JOIN_BUCKET ? autoJoinDir(mycoHome) : spoolDirFor({ projectId, serverUrl: serverUrl ?? '' }, mycoHome);
  return {
    lock: path.join(dir, HELPER_LOCK_FILE),
    dirty: path.join(dir, HELPER_DIRTY_FILE),
    probe: path.join(dir, HELPER_PROBE_FILE),
    starting: path.join(dir, HELPER_STARTING_FILE),
  };
}

function initializedHelperPaths(opts: { projectId: string; serverUrl?: string; mycoHome: string }): HelperPaths {
  if (opts.projectId !== JOIN_BUCKET) new MemberSpool({ projectId: opts.projectId, serverUrl: opts.serverUrl ?? '' }, { mycoHome: opts.mycoHome });
  const paths = helperPaths(opts.projectId, opts.mycoHome, opts.serverUrl);
  ensureMemberDir(path.dirname(paths.dirty), opts.mycoHome);
  return paths;
}

/**
 * Why a hook kicks: it captured something, or a turn or the session ended. An end is worth a dial past the offline
 * latch (`force`); anything else waits for the latch's next probe.
 */
export type KickReason = 'capture' | 'turn-end' | 'session-end';

/**
 * What a kick did: a helper holds the lock and will see the mark (`running`); one was started and is on its way
 * (`starting`); this kick started one (`started`); or none could be started (`failed`). `contained` (Windows) says the
 * helper that will see the mark runs inside a Job Object that ends it with the process that started it: the kicking
 * hook's job, or an earlier hook's of the same harness.
 */
export type KickOutcome =
  | { kind: 'running'; contained: boolean }
  | { kind: 'starting'; contained: boolean }
  | { kind: 'started'; contained: boolean }
  | { kind: 'failed' };

/**
 * Whether the caller must deliver its own work now, in its own process: no helper will outlive it to do so. A
 * helper that could not be started, or one that ends with the harness, however it came to hold the work: started by
 * this kick, on its way from an earlier one, or already holding the lock.
 */
export function shipsInline(outcome: KickOutcome): boolean {
  return outcome.kind === 'failed' || outcome.contained;
}

/**
 * Tell the project's helper there is work, starting one if none runs or is on its way. Never waits on anything but
 * local files.
 *
 * The marks are written first, then the lock is probed without blocking. A held lock is a running helper, which
 * reads the marks before it exits. A free lock with a start under way is a helper about to take it, which reads them
 * once it does. Otherwise this kick starts one. A start it could not make, or one that cannot outlive the caller, is
 * logged to `helper.log` and answered so the caller can ship inline (`shipsInline`).
 */
export function kickHelper(opts: { projectId: string; serverUrl?: string; mycoHome: string; reason?: KickReason; spawn?: DetachedSpawn; now?: () => number }): KickOutcome {
  markWork(opts);
  // A join's caller ships nothing itself: its request stays, and the next hook in the repository kicks again.
  const fallback = opts.projectId === JOIN_BUCKET ? 'the join waits for the next hook' : 'the caller ships inline';
  return startHelper({ ...opts, why: `kick (${opts.reason ?? 'capture'})`, fallback });
}

/**
 * Mark the project's work, as a kick does, without starting a helper: for a caller that runs the helper's pass
 * itself. A running helper still sees the marks; one started later reads them.
 */
export function markWork(opts: { projectId: string; serverUrl?: string; mycoHome: string; reason?: KickReason }): void {
  const paths = initializedHelperPaths(opts);
  ensureMemberDir(path.dirname(paths.dirty), opts.mycoHome);
  fs.writeFileSync(paths.dirty, '', { mode: 0o600 });
  if (opts.reason === 'turn-end' || opts.reason === 'session-end') fs.writeFileSync(paths.probe, '', { mode: 0o600 });
}

/**
 * Start the project's helper unless one holds the lock or is on its way. The start is claimed first
 * (`helper.starting`, created exclusively), so of many kicks landing while a start is under way, one starts a helper.
 */
function startHelper(opts: {
  projectId: string; serverUrl?: string; mycoHome: string; spawn?: DetachedSpawn; now?: () => number; afterFailure?: boolean;
  /** Who asked, and what becomes of the work when no helper can carry it: both go in the log line. */
  why: string; fallback: string;
}): KickOutcome {
  const now = opts.now ?? Date.now;
  const paths = initializedHelperPaths(opts);
  const probe = LifecycleLock.acquire(paths.lock, { command: 'myco member helper (probe)' });
  if (!probe.acquired) return { kind: 'running', contained: probe.holder?.contained === true };
  probe.lock.release();
  if (!claimStart(paths.starting, now())) return { kind: 'starting', contained: readStartClaim(paths.starting)?.contained === true };
  const self = selfExec();
  const bucket = opts.projectId === JOIN_BUCKET ? ['--join'] : ['--project', opts.projectId, '--server', opts.serverUrl!];
  const args = [...self.args, 'member', 'helper', ...bucket, '--home', opts.mycoHome, ...(opts.afterFailure ? ['--after-failure'] : [])];
  let start: DetachedStart;
  try {
    start = (opts.spawn ?? spawnDetached)(self.path, args, { cwd: opts.mycoHome });
  } catch {
    // A start that threw started nothing: its claim must not hold the next kick off.
    start = { started: false };
  }
  if (!start.started) {
    try { fs.unlinkSync(paths.starting); } catch { /* not claimed */ }
    appendHelperLog(opts.mycoHome, opts.projectId, `[myco] helper: ${opts.why} could not start a helper; ${opts.fallback}`, opts.serverUrl);
    return { kind: 'failed' };
  }
  writeStart(paths.starting, { at: now(), pid: start.pid, ...(start.contained ? { contained: true } : {}) });
  if (start.contained) {
    appendHelperLog(opts.mycoHome, opts.projectId, `[myco] helper: ${opts.why} started a helper inside the caller's Job Object, which ends it with the caller; ${opts.fallback}`, opts.serverUrl);
    return { kind: 'started', contained: true };
  }
  return { kind: 'started', contained: false };
}

interface StartClaim {
  at: number;
  pid?: number;
  /** The helper was started inside the starter's Job Object, which ends it with the starter. */
  contained?: boolean;
}

/** The start claimed in `file`, as far as it can be read; null for none, or one not yet written. */
function readStartClaim(file: string): Partial<StartClaim> | null {
  try {
    const claim = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    return claim !== null && typeof claim === 'object' ? claim as Partial<StartClaim> : null;
  } catch {
    return null;
  }
}

/**
 * Give the claim its process, only while the claim is still there: a helper that already took the lock removed it,
 * and a claim made again here would hold off the next kick's start for a helper that has come and gone.
 */
function writeStart(file: string, claim: StartClaim): void {
  let fd: number;
  try { fd = fs.openSync(file, 'r+'); } catch { return; }
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, JSON.stringify(claim), 0);
  } catch { /* the claim only spares a second start */ } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether a claimed start is still under way: claimed moments ago, or given a process that is alive and young. A
 * claim dated after now (a clock set back) is spent: its age says nothing.
 */
function startUnderWay(file: string, now: number): boolean {
  const young = (at: number, grace: number): boolean => now - at >= 0 && now - at < grace;
  let claim: Partial<StartClaim>;
  try {
    claim = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<StartClaim>;
  } catch {
    // Created and not yet written: a claim this moment old, or a file nothing can read, which is no claim.
    try { return young(fs.statSync(file).mtimeMs, HELPER_CLAIM_GRACE_MS); } catch { return false; }
  }
  if (typeof claim.at !== 'number') return false;
  if (claim.pid === undefined) return young(claim.at, HELPER_CLAIM_GRACE_MS);
  // Past the grace a live pid is no proof: the helper hung on its way to the lock, or the pid was reused.
  if (!young(claim.at, HELPER_START_GRACE_MS)) return false;
  try {
    process.kill(claim.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Claim the start of a helper: true when this caller is to start one, false when a start is already under way. */
function claimStart(file: string, now: number): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ at: now }), { mode: 0o600, flag: 'wx' });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return true;
      if (startUnderWay(file, now)) return false;
      // A start whose helper never took the lock: its claim is spent.
      try { fs.unlinkSync(file); } catch { /* another caller cleared it */ }
    }
  }
  // Two spent claims in a row: start one regardless. A second helper finds the lock taken and exits.
  return true;
}

/** One pass: ship what the project's spool holds, within `deadline`; `force` dials past the offline latch. */
export type HelperPass = (deadline: number, opts: { force: boolean }) => Promise<HelperPassResult | void>;

export interface HelperPassResult {
  /** The pass stopped with work left for lack of time: the helper's successor carries on. */
  more?: boolean;
}

export interface HelperRunOptions {
  projectId: string;
  serverUrl?: string;
  mycoHome: string;
  pass: HelperPass;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  lingerMs?: number;
  pollMs?: number;
  /** How a successor is started: at the deadline with work left, or after a pass that failed. */
  spawn?: DetachedSpawn;
  /** This helper was started after a pass failed: a failure of its own leaves the marks for the next kick. */
  afterFailure?: boolean;
  /**
   * Start no successor, at the deadline or after a failure: the marks stay for the next kick. For a pass run inside
   * a hook, whose successor would be started inside the same job the hook could not leave.
   */
  noSuccessor?: boolean;
  /** Called each time the lock is let go, before the last look for new work: where a late kick lands. */
  onReleased?: () => void;
  /** Called when the lock was held at start, before the start claim is removed: where a racing kick lands. */
  onBusy?: () => void;
  /**
   * This helper ends with the process that started it (a Job Object it cannot leave): recorded on the lock, so a kick
   * that finds it holding the work delivers its own instead. Defaults to what this process read of the job it began
   * in; a start claim that says so counts as well.
   */
  contained?: boolean;
}

export interface HelperRunResult {
  /** `busy`: another helper holds the lock, and this one did nothing. */
  endedBy: 'idle' | 'deadline' | 'busy';
  passes: number;
  /** A successor was started, at the deadline with work left. */
  successor?: KickOutcome['kind'];
}

/**
 * Run passes under the project's helper lock until no work is left, the linger runs out, or the deadline passes.
 *
 * No kick is lost on the way out. A kick that lands while the helper still holds the lock leaves its mark, which the
 * helper reads once more after it lets go; at the deadline, a mark left or a pass cut short by time starts the
 * helper's successor. A pass that throws puts its marks back and starts a successor before the error goes on, unless
 * this helper is itself the successor of a failure, whose marks wait for the next kick.
 */
export async function runHelper(opts: HelperRunOptions): Promise<HelperRunResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now() + (opts.deadlineMs ?? HELPER_DEADLINE_MS);
  const linger = opts.lingerMs ?? HELPER_LINGER_MS;
  const poll = opts.pollMs ?? HELPER_POLL_MS;
  const paths = initializedHelperPaths(opts);
  ensureMemberDir(path.dirname(paths.lock), opts.mycoHome);
  const dirty = (): boolean => fs.existsSync(paths.dirty);
  /** Remove a mark, answering whether it was there: a kick after the removal writes it again, for the next look. */
  const take1 = (file: string): boolean => { try { fs.unlinkSync(file); return true; } catch { return false; } };
  const successor = (afterFailure: boolean): KickOutcome => startHelper({
    projectId: opts.projectId, serverUrl: opts.serverUrl, mycoHome: opts.mycoHome, spawn: opts.spawn, now, afterFailure,
    why: afterFailure ? 'a failed pass' : 'the deadline', fallback: 'the work waits for the next kick',
  });

  let passes = 0;
  // A helper this one's start claim names as contained is contained, whatever it read of its job itself.
  const claimed = readStartClaim(paths.starting);
  const contained = (opts.contained ?? startedContained()) || (claimed?.contained === true && claimed.pid === process.pid);
  const take = (lockPath: string): LockHandle | null => {
    const lock = takeLock(lockPath);
    if (lock !== null && contained) {
      try { lock.update({ contained: true }); } catch { /* the record only steers a later kick */ }
    }
    return lock;
  };
  let held: LockHandle | null = take(paths.lock);
  if (held === null) opts.onBusy?.();
  // Whichever helper holds the lock, a start under way has arrived.
  try { fs.unlinkSync(paths.starting); } catch { /* none claimed */ }
  // The lock was held when this helper tried it, and a kick in between may have found this helper's claim and left
  // only its mark: with the claim gone, take the lock again for that mark. A holder still there will read it.
  if (held === null && dirty()) held = take(paths.lock);
  if (held === null) return { endedBy: 'busy', passes };
  let more = false;
  try {
    for (;;) {
      // Work until a pass leaves nothing new behind it for the length of the linger.
      for (;;) {
        take1(paths.dirty);
        const force = take1(paths.probe);
        try {
          more = (await opts.pass(deadline, { force }))?.more === true;
          // A forced pass cut short by time leaves its probe for the pass, or the successor, that carries on.
          if (force && more) fs.writeFileSync(paths.probe, '', { mode: 0o600 });
        } catch (err) {
          // The pass's work is undone: its marks go back, so neither the work nor the end that asked for a probe is lost.
          fs.writeFileSync(paths.dirty, '', { mode: 0o600 });
          if (force) fs.writeFileSync(paths.probe, '', { mode: 0o600 });
          held.release();
          held = null;
          if (!opts.afterFailure && !opts.noSuccessor) successor(true);
          throw err;
        }
        passes += 1;
        if (now() >= deadline) break;
        const until = Math.min(deadline, now() + linger);
        while (!dirty() && now() < until) await sleep(poll);
        if (!dirty()) break;
      }
      held.release();
      held = null;
      opts.onReleased?.();
      if (now() >= deadline) {
        // Kicks during the last pass found the lock held and started nothing: the successor is theirs.
        if ((!dirty() && !more) || opts.noSuccessor) {
          // A pass cut short with no successor to carry it on leaves its mark for the next kick.
          if (more) fs.writeFileSync(paths.dirty, '', { mode: 0o600 });
          return { endedBy: 'deadline', passes };
        }
        return { endedBy: 'deadline', passes, successor: successor(false).kind };
      }
      // A kick between the last look and the release found the lock held and left only its mark: take it up again.
      if (!dirty()) return { endedBy: 'idle', passes };
      held = take(paths.lock);
      if (held === null) return { endedBy: 'idle', passes };
    }
  } finally {
    held?.release();
  }
}

function takeLock(lockPath: string): LockHandle | null {
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
export function routeStderrToHelperLog(mycoHome: string, projectId: string, serverUrl?: string): () => void {
  const file = helperLogPath(mycoHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > HELPER_LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* no log yet */ }
  const write = (chunk: unknown): boolean => {
    appendHelperLog(mycoHome, projectId, String(chunk), serverUrl);
    return true;
  };
  const stream = process.stderr as unknown as { write: (chunk: unknown) => boolean };
  const original = stream.write;
  stream.write = write;
  return () => { stream.write = original; };
}

/** One line in the helper's log, stamped with the time and buffered destination. A log that cannot be written costs the line. */
export function appendHelperLog(mycoHome: string, projectId: string, line: string, serverUrl?: string): void {
  const file = helperLogPath(mycoHome);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${serverUrl === undefined ? projectId : `${deploymentUrl(serverUrl)} ${projectId}`} ${line}${line.endsWith('\n') ? '' : '\n'}`);
  } catch { /* a log that cannot be written costs the line, never the work */ }
}

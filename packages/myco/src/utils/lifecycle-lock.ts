/**
 * Single-instance enforcement via OS file locking.
 *
 * The process holding the lock IS the authoritative owner of the
 * resource it gates (Myco daemon, capture buffer writer, etc.).
 * `daemon.json`, HTTP probes, and SQLite write locks are all downstream
 * of this primitive — none of them are consulted as a source of truth
 * for "who owns this."
 *
 * Implementation: `flock(2)` via Bun FFI on macOS and Linux. The lock
 * is released by the kernel on process death (crash, signal, exit) so
 * orphans cannot retain ownership.
 *
 * NFS caveat: `flock(2)` semantics on NFS are historically unreliable
 * across kernel + NFS-server versions. `~/.myco/` is local-disk in the
 * normal install so this is a non-issue for the target deployment.
 * Anyone repurposing the primitive for a path that may live on NFS
 * needs to design for that — a stale silent acquisition would defeat
 * the single-instance guarantee.
 *
 * Windows: `LockFileEx` is the equivalent primitive. Not yet wired —
 * `acquire` throws with a clear error on Windows so the caller can
 * choose to refuse-to-start rather than race.
 */

import fs from 'node:fs';
import path from 'node:path';
import { dlopen, FFIType, suffix } from 'bun:ffi';

// `flock(2)` operation flags. Linux and macOS agree on these values.
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/**
 * Candidate library names per platform. The plain `libc.${suffix}`
 * form works on macOS (where `libc.dylib` resolves to libSystem) but
 * NOT on Linux: `libc.so` is a GNU ld linker script, not a runtime-
 * loadable shared object. The actual runtime library is `libc.so.6`.
 * Try the versioned name first, fall back to the suffix-only name
 * for unusual distros that expose a generic libc.
 */
function libcCandidates(): readonly string[] {
  if (process.platform === 'linux') return ['libc.so.6', `libc.${suffix}`];
  if (process.platform === 'darwin') return [`libc.${suffix}`, 'libSystem.dylib'];
  return [`libc.${suffix}`];
}

let flockBinding: { flock: (fd: number, op: number) => number } | null = null;
let flockBindingError: Error | null = null;

function loadFlock(): { flock: (fd: number, op: number) => number } {
  if (flockBinding) return flockBinding;
  if (flockBindingError) throw flockBindingError;
  if (process.platform === 'win32') {
    flockBindingError = new Error(
      'LifecycleLock: Windows (LockFileEx) is not yet supported; refusing to start.',
    );
    throw flockBindingError;
  }
  const errors: string[] = [];
  for (const name of libcCandidates()) {
    try {
      const lib = dlopen(name, {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      flockBinding = lib.symbols as never;
      return flockBinding!;
    } catch (err) {
      errors.push(`${name}: ${(err as Error).message}`);
    }
  }
  flockBindingError = new Error(
    `LifecycleLock: failed to bind libc.flock — refusing to start. Tried: ${errors.join('; ')}`,
  );
  throw flockBindingError;
}

export interface LockHolder {
  pid: number;
  startedAt: number;
  command?: string;
  /** Port the lock holder is serving on. Written after `acquire()`
   *  once the HTTP listener has bound, via `LockHandle.update()`. The
   *  daemon-client discovery path reads this when `daemon.json` is
   *  absent — making the canonical `~/.myco/service/daemon.json` a
   *  cache rather than a hard requirement for capture to reach the
   *  daemon. */
  port?: number;
  /** Daemon-issued bearer token (G4). Recorded so out-of-band
   *  callers that discover via the lock can attach `x-myco-auth` to
   *  context-switching requests without needing `daemon.json`. */
  authToken?: string;
}

export interface LockHandle {
  release(): void;
  /** Merge `metadata` into the on-disk holder record. Used by the
   *  daemon to publish its port and auth-token after `start()` binds.
   *  Writes through the same fd that holds the flock, so updates are
   *  atomic with respect to ownership: only the lock holder can
   *  rewrite the file. */
  update(metadata: Partial<LockHolder>): void;
  readonly path: string;
  readonly pid: number;
}

export interface AcquireSuccess {
  acquired: true;
  lock: LockHandle;
}

export interface AcquireRefused {
  acquired: false;
  holder: LockHolder | null;
  holderPid: number | null;
}

export type AcquireResult = AcquireSuccess | AcquireRefused;

export interface AcquireOptions {
  /** Override the command string written to the lock file. Defaults to
   *  `process.argv.join(' ')`. Informational only. */
  command?: string;
}

export const LifecycleLock = {
  acquire(lockPath: string, opts: AcquireOptions = {}): AcquireResult {
    const flockApi = loadFlock();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
    const rc = flockApi.flock(fd, LOCK_EX | LOCK_NB);
    if (rc !== 0) {
      const holder = readHolderMetadata(fd);
      fs.closeSync(fd);
      return {
        acquired: false,
        holder,
        holderPid: holder?.pid ?? null,
      };
    }

    const command = opts.command ?? process.argv.join(' ');
    const current: LockHolder = {
      pid: process.pid,
      startedAt: Math.floor(Date.now() / 1000),
      command,
    };
    writeHolderMetadata(fd, current);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      // Truncate the lockfile in-place before releasing the flock so the
      // hook-discovery lock-tier fallback (readLockHolder) doesn't return
      // a dead holder's PID + port to a fresh hook process. The next
      // acquirer's writeHolderMetadata starts from an empty file. The
      // truncate happens while we still hold the lock — readers using
      // readLockHolder are racing with us regardless, and they handle a
      // zero-length file as "no holder" (returns null and falls through
      // to /health discovery).
      try { fs.ftruncateSync(fd, 0); } catch { /* fd may already be closed */ }
      try { flockApi.flock(fd, LOCK_UN); } catch { /* fd may already be closed */ }
      try { fs.closeSync(fd); } catch { /* idem */ }
    };
    process.on('exit', release);

    const update = (metadata: Partial<LockHolder>): void => {
      if (released) return;
      Object.assign(current, metadata);
      writeHolderMetadata(fd, current);
    };

    return {
      acquired: true,
      lock: { release, update, path: lockPath, pid: process.pid },
    };
  },

  /** Test-only seam: clears the cached FFI binding so a subsequent
   *  `acquire` re-runs `dlopen`. Used in unit tests that exercise the
   *  refuse-to-start path. */
  __resetForTests(): void {
    flockBinding = null;
    flockBindingError = null;
  },
};

/**
 * Run `fn` while holding an exclusive blocking flock on `lockPath`.
 *
 * Distinct primitive from `LifecycleLock.acquire`: this one BLOCKS
 * waiting for the lock (no LOCK_NB) and releases as soon as `fn`
 * returns. Used for short-lived critical sections — typically
 * sub-millisecond — where contention is rare and the caller wants
 * to serialize without writing its own retry loop.
 *
 * The libc flock call returns in microseconds when uncontended; for
 * the daemon's buffer-append usage this is acceptable on the hot
 * path.
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T): T {
  const flockApi = loadFlock();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT, 0o644);
  try {
    if (flockApi.flock(fd, LOCK_EX) !== 0) {
      throw new Error(`withFileLockSync: flock(LOCK_EX) failed on ${lockPath}`);
    }
    return fn();
  } finally {
    try { flockApi.flock(fd, LOCK_UN); } catch { /* fd may already be closed */ }
    try { fs.closeSync(fd); } catch { /* idem */ }
  }
}

function writeHolderMetadata(fd: number, info: LockHolder): void {
  const json = JSON.stringify(info, null, 2) + '\n';
  fs.ftruncateSync(fd, 0);
  fs.writeSync(fd, json, 0);
}

function readHolderMetadata(fd: number): LockHolder | null {
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size === 0) return null;
    const buf = Buffer.allocUnsafe(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);
    const parsed = JSON.parse(buf.toString('utf-8')) as Partial<LockHolder>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      command: typeof parsed.command === 'string' ? parsed.command : undefined,
      port: typeof parsed.port === 'number' ? parsed.port : undefined,
      authToken: typeof parsed.authToken === 'string' ? parsed.authToken : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Read the lock-holder record from a lockfile path without holding the
 * lock — the fallback source of truth for daemon-client discovery when
 * `daemon.json` is absent. The owner's flock is unaffected: this is a
 * pure read, no flock call.
 */
export function readLockHolder(lockPath: string): LockHolder | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf-8');
  } catch {
    return null;
  }
  if (raw.length === 0) return null;
  let parsed: Partial<LockHolder>;
  try {
    parsed = JSON.parse(raw) as Partial<LockHolder>;
  } catch {
    return null;
  }
  if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return null;
  return {
    pid: parsed.pid,
    startedAt: parsed.startedAt,
    command: typeof parsed.command === 'string' ? parsed.command : undefined,
    port: typeof parsed.port === 'number' ? parsed.port : undefined,
    authToken: typeof parsed.authToken === 'string' ? parsed.authToken : undefined,
  };
}

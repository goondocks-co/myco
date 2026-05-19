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
  try {
    const lib = dlopen(`libc.${suffix}`, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    flockBinding = lib.symbols as never;
    return flockBinding!;
  } catch (err) {
    flockBindingError = new Error(
      `LifecycleLock: failed to bind libc.flock — refusing to start. Cause: ${(err as Error).message}`,
    );
    throw flockBindingError;
  }
}

export interface LockHolder {
  pid: number;
  startedAt: number;
  command?: string;
}

export interface LockHandle {
  release(): void;
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
    writeHolderMetadata(fd, {
      pid: process.pid,
      startedAt: Math.floor(Date.now() / 1000),
      command,
    });

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      try { flockApi.flock(fd, LOCK_UN); } catch { /* fd may already be closed */ }
      try { fs.closeSync(fd); } catch { /* idem */ }
    };
    process.on('exit', release);

    return {
      acquired: true,
      lock: { release, path: lockPath, pid: process.pid },
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
    };
  } catch {
    return null;
  }
}

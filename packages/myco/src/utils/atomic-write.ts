import fs from 'node:fs';
import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { moveFileReplaceWriteThrough } from '@myco/utils/windows-atomic-replace.js';

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  /**
   * Make the publication survive a power loss, not only a process crash.
   * POSIX requires the renamed file and its containing directory to be
   * flushed. Windows publication already uses MOVEFILE_WRITE_THROUGH.
   */
  durable?: boolean;
  /**
   * POSIX file mode (e.g. 0o600) to apply to the tempfile at create time.
   * The tempfile is opened with `O_CREAT | O_EXCL | O_WRONLY` so the mode
   * lands on the open() syscall rather than after a separate
   * writeFileSync (which would have its mode masked by the process
   * umask). On non-POSIX filesystems (Windows) the mode is advisory and
   * the call still succeeds.
   */
  mode?: number;
}

/**
 * Write a file via temp+rename so readers either see the prior valid
 * contents or the new contents — never a torn write. Required for any
 * file that backs a recoverable on-disk state machine (registry,
 * markers, manifests).
 *
 * Tempfile path is `<filePath>.tmp-<pid>-<12 hex bytes of randomness>`.
 * The randomness defeats two attacks a predictable `.tmp-<pid>-<ts>`
 * path enabled:
 *   1. Same-user pre-creation of the tempfile to capture our write
 *      (mitigated structurally by `O_EXCL`, which fails the open if the
 *      path exists). The random suffix keeps collision-by-prediction
 *      out of the failure modes legitimate callers see.
 *   2. Brief read window between writeFileSync (umask-masked default
 *      0o644 on POSIX) and a follow-up chmodSync — the previous shape
 *      let a same-user attacker read tempfile bytes during that window.
 *      The new path opens with the requested mode atomically.
 *
 * The third argument is either a `BufferEncoding` string (legacy form,
 * equivalent to `{ encoding }`) or an options object. Mode preservation
 * (`{ mode }`) is opt-in because most callers don't need owner-only
 * permissions and would pay a redundant strict-create syscall.
 */
export function atomicWriteFileSync(
  filePath: string,
  contents: string | Buffer,
  encodingOrOptions: BufferEncoding | AtomicWriteOptions = 'utf-8',
): void {
  const publish = process.platform === 'win32'
    ? moveFileReplaceWriteThrough
    : fs.renameSync;
  atomicWriteFileSyncWithPublisher(filePath, contents, encodingOrOptions, publish);
}

function atomicWriteFileSyncWithPublisher(
  filePath: string,
  contents: string | Buffer,
  encodingOrOptions: BufferEncoding | AtomicWriteOptions,
  publish: (temporaryPath: string, targetPath: string) => void,
): void {
  const options: AtomicWriteOptions = typeof encodingOrOptions === 'string'
    ? { encoding: encodingOrOptions }
    : encodingOrOptions;
  const encoding: BufferEncoding = options.encoding ?? 'utf-8';
  const { mode } = options;

  // pid is still included so a forensic `ls .tmp-*` shows which process
  // is responsible; randomness is what actually defeats prediction.
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(12).toString('hex')}`;

  // O_CREAT | O_EXCL | O_WRONLY: create-only, fail (EEXIST) if a file
  // already lives at the path. With the random suffix this should never
  // collide in practice, so an EEXIST here is a real signal (something
  // else is shadowing the tempfile namespace) — propagate the throw.
  // Default mode 0o666 mirrors writeFileSync's default; specifying
  // `mode` honors it at create time without umask interference (the
  // open call applies `mode & ~umask`, same as writeFileSync, but we
  // also chmod below to force the requested bits on POSIX systems).
  // Bun's `fs` default-export shape doesn't populate `fs.constants`
  // reliably across versions; the named import does.
  const fd = fs.openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
    mode ?? 0o666,
  );
  try {
    if (mode !== undefined) {
      try {
        // Defeat umask: open()'s mode is masked the same way writeFileSync's
        // is. An explicit chmod on the freshly-created fd (before any bytes
        // land) guarantees the mode is exactly what was requested before
        // rename exposes the final path.
        fs.fchmodSync(fd, mode);
      } catch {
        // Best-effort; non-POSIX filesystems (Windows) ignore POSIX modes.
      }
    }
    const buf = typeof contents === 'string' ? Buffer.from(contents, encoding) : contents;
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  try {
    publish(tmp, filePath);
  } catch (err) {
    // Publication failed (cross-device, EBUSY, ENOSPC, etc.).
    // Clean up the tempfile rather than leaving stale — possibly
    // secret-bearing — data at a `.tmp-<pid>-<rand>` path for a future
    // read by the same user to harvest.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort; a Windows EBUSY on rename may also block unlink.
    }
    throw err;
  }

  if (options.durable && process.platform !== 'win32') {
    syncFileForDurability(filePath);
    syncDirectoryForDurability(path.dirname(filePath));
  }
}

const DURABLE_REMOVAL_TOMBSTONE_PREFIX = '.myco-remove-';

function syncFileForDurability(filePath: string): void {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(filePath, fsConstants.O_RDONLY | noFollow);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Flush a directory entry update on POSIX. Windows has no portable directory handle. */
export function syncDirectoryForDurability(directory: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, fsConstants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Durably publish absence for one exact path.
 *
 * Renaming to a private sibling tombstone makes disappearance atomic and, on
 * Windows, uses the same write-through primitive as file publication. The
 * tombstone is then removed and the parent is flushed on POSIX. A crash between
 * those steps leaves only a namespaced tombstone that the owning capability can
 * reconcile without making the original path visible again.
 */
export function durableRemovePathSync(targetPath: string): void {
  const parent = path.dirname(targetPath);
  const tombstone = path.join(
    parent,
    `${DURABLE_REMOVAL_TOMBSTONE_PREFIX}${path.basename(targetPath)}-${process.pid}-${randomBytes(12).toString('hex')}`,
  );
  try {
    if (process.platform === 'win32') {
      moveFileReplaceWriteThrough(targetPath, tombstone);
    } else {
      fs.renameSync(targetPath, tombstone);
      syncDirectoryForDurability(parent);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  fs.rmSync(tombstone, { recursive: true, force: true });
  syncDirectoryForDurability(parent);
}

/**
 * Remove only tombstones created by {@link durableRemovePathSync}.
 * Callers choose the exact directory whose state they own.
 */
export function reconcileDurableRemovalTombstonesSync(directory: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.startsWith(DURABLE_REMOVAL_TOMBSTONE_PREFIX)) continue;
    fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
  syncDirectoryForDurability(directory);
}

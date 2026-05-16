import fs from 'node:fs';

export interface AtomicWriteOptions {
  encoding?: BufferEncoding;
  /**
   * POSIX file mode (e.g. 0o600) to apply to the tempfile before it is
   * renamed into place. Without this, the tempfile is briefly visible at
   * the default umask (typically 0o644) — a leak window for files that
   * carry secrets (daemon bearer token, API keys). When set, the
   * tempfile is created with the mode AND chmod'd before rename to
   * defeat umask masking on the create call.
   */
  mode?: number;
}

/**
 * Write a file via temp+rename so readers either see the prior valid
 * contents or the new contents — never a torn write. Required for any
 * file that backs a recoverable on-disk state machine (registry,
 * markers, manifests).
 *
 * The third argument is either a `BufferEncoding` string (legacy form,
 * equivalent to `{ encoding }`) or an options object. Mode preservation
 * (`{ mode }`) is opt-in because most callers don't need owner-only
 * permissions and would pay a redundant chmodSync syscall.
 */
export function atomicWriteFileSync(
  filePath: string,
  contents: string | Buffer,
  encodingOrOptions: BufferEncoding | AtomicWriteOptions = 'utf-8',
): void {
  const options: AtomicWriteOptions = typeof encodingOrOptions === 'string'
    ? { encoding: encodingOrOptions }
    : encodingOrOptions;
  const encoding: BufferEncoding = options.encoding ?? 'utf-8';
  const { mode } = options;

  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  if (typeof contents === 'string') {
    fs.writeFileSync(tmp, contents, mode !== undefined ? { encoding, mode } : encoding);
  } else {
    fs.writeFileSync(tmp, contents, mode !== undefined ? { mode } : undefined);
  }
  if (mode !== undefined) {
    try {
      // Defeat umask: writeFileSync's `mode` is masked by the process
      // umask on create. An explicit chmod on the tempfile guarantees
      // the mode lands before rename exposes the final path.
      fs.chmodSync(tmp, mode);
    } catch {
      // Best-effort; non-POSIX filesystems (Windows) ignore POSIX modes.
    }
  }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    // Rename failed (cross-device, EBUSY on Windows, ENOSPC, etc.).
    // Clean up the tempfile rather than leaving stale — possibly
    // secret-bearing — data at a predictable `.tmp-<pid>-<ts>` path
    // for a future read by the same user to harvest.
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort; a Windows EBUSY on rename may also block unlink.
    }
    throw err;
  }
}

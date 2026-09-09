/**
 * Runtime pin trust — the G7 check a pin file passes before anything obeys it.
 *
 * A `runtime.command` pin names a binary to exec and a `runtime.home` pin names
 * the home a credential is read from, so a pin owned by another user or
 * writable by group/other is refused with a named reason rather than followed.
 *
 * A leaf: Node built-ins only, so the home resolver (`paths/home.ts`) and the
 * binary resolver (`runtime/binary-resolution.ts`) share ONE implementation of
 * the rule instead of each carrying a copy. `bin/binary-resolution.cjs` mirrors
 * it for the npm shims, which cannot import TypeScript; that mirror is gated by
 * tests/runtime/binary-resolution-cjs-agreement.test.ts.
 */
import fs from 'node:fs';

/** Permission bits that make a pin writable by someone other than its owner. */
export const PIN_INSECURE_MODE_MASK = 0o022;

/** The refusal reason for a pin file that simply is not there — the normal, silent state. */
export const PIN_MISSING_REASON = 'pin file missing';

export type PinTrust = { ok: true } | { ok: false; reason: string };

/** Injectable host facts so the whole trust matrix is testable without a real pin file. */
export interface PinTrustOptions {
  platform?: NodeJS.Platform;
  getuid?: (() => number) | undefined;
}

/**
 * Refuse a pin owned by another uid, writable by group/other, or reached
 * through a symlink. `0o644` is trusted. Win32 has no POSIX modes — always
 * trusted.
 *
 * The stat is an `lstat`: following the link would report the TARGET's owner
 * and mode, so a link planted in a world-writable ancestor (`/tmp/.myco/`) and
 * pointed at any file this user happens to own would read as a trusted pin.
 */
export function checkPinTrust(filePath: string, options: PinTrustOptions = {}): PinTrust {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return { ok: true };
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: PIN_MISSING_REASON };
    return { ok: false, reason: `stat failed: ${(err as Error).message ?? 'unknown'}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'pin file is a symlink' };
  const getuid = options.getuid ?? (typeof process.getuid === 'function' ? process.getuid : undefined);
  const myUid = getuid ? getuid() : null;
  if (myUid !== null && stat.uid !== myUid) {
    return { ok: false, reason: `pin file owned by uid ${stat.uid}, expected ${myUid}` };
  }
  const mode = stat.mode & 0o777;
  if (mode & PIN_INSECURE_MODE_MASK) {
    return { ok: false, reason: `pin file mode 0${mode.toString(8)} is writable by group/other` };
  }
  return { ok: true };
}

/** Where a refusal is reported. The default writes one stderr line. */
export type PinRefusalReporter = (pinPath: string, reason: string) => void;

/**
 * Read a pin's trimmed value: null when absent, untrusted, or empty.
 *
 * A real refusal (foreign owner, group/other-writable) is reported, because a
 * silently ignored pin is indistinguishable from no pin at all; a missing file
 * is the normal no-pin state and stays silent.
 */
export function readTrustedPin(
  filePath: string,
  options: PinTrustOptions = {},
  report: PinRefusalReporter = reportPinRefusal,
): string | null {
  const trust = checkPinTrust(filePath, options);
  if (!trust.ok) {
    if (trust.reason !== PIN_MISSING_REASON) report(filePath, trust.reason);
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function reportPinRefusal(pinPath: string, reason: string): void {
  try {
    process.stderr.write(`[myco] ignoring runtime pin (${reason}): ${pinPath}\n`);
  } catch {
    // stderr unavailable
  }
}

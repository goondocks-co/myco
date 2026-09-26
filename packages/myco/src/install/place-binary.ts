/**
 * Putting a Myco executable where something will run it.
 *
 * Two ways a placed binary fails, each silent until something runs it:
 *
 *   - **A signature the kernel refuses.** Bun's ad hoc signature on a Darwin
 *     build can fail `codesign --verify` on newer macOS, and the kernel then
 *     kills the program at exec (`Code Signature Invalid`). A capture hook that
 *     runs it captures nothing. {@link readyExecutable} judges a file by running
 *     it, and signs it ad hoc again (keeping its entitlements, as the build
 *     does) only when its own signature does not verify.
 *   - **Bytes that are not all there.** A copy written over the running path,
 *     or renamed before it reached the disk, is a different program from the
 *     one verified. {@link placeExecutable} writes a temporary file beside the
 *     destination, syncs it, then renames it over the destination.
 *
 * A LaunchAgent's restart of a replaced program is a third failure, and is not
 * the file's: see `reloadServiceDetached` in `server/service.ts`.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Longest a program is given to answer `--version`. */
const PROGRAM_PROBE_TIMEOUT_MS = 30_000;

/** Whether a program runs, or why it does not. */
export type ProgramProbe = { runs: true } | { runs: false; detail: string };

/** Runs one command to completion; the default is the real platform, a test passes its own. */
export type CommandRun = (command: string, args: readonly string[]) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error };

const platformRun: CommandRun = (command, args) => {
  const result = spawnSync(command, [...args], { stdio: 'ignore', timeout: PROGRAM_PROBE_TIMEOUT_MS });
  return { status: result.status, signal: result.signal, ...(result.error === undefined ? {} : { error: result.error }) };
};

const failed = (result: ReturnType<CommandRun>): string | null => {
  if (result.error !== undefined) return result.error.message;
  if (result.status === 0) return null;
  return result.signal !== null && result.signal !== undefined ? `ended by ${result.signal}` : `exited ${result.status}`;
};

/**
 * Whether the program at `file` runs: the kernel accepts its signature and it
 * answers `--version`.
 */
export function programRuns(file: string, run: CommandRun = platformRun): ProgramProbe {
  const why = failed(run(file, ['--version']));
  return why === null ? { runs: true } : { runs: false, detail: why };
}

/**
 * Make `file` a program this machine runs, or say why it is not.
 *
 * On macOS the signature must pass `codesign --verify --strict`; one that does
 * not is signed ad hoc again, keeping its entitlements and identifier, and verified again. A
 * signature that verifies is never replaced. Every platform but Windows must
 * then run the file.
 */
export function readyExecutable(file: string, platform: NodeJS.Platform = process.platform, run: CommandRun = platformRun): ProgramProbe {
  if (platform === 'win32') return { runs: true };
  if (platform === 'darwin' && failed(run('codesign', ['--verify', '--strict', file])) !== null) {
    const signing = failed(run('codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements,identifier', file]))
      ?? failed(run('codesign', ['--verify', '--strict', file]));
    if (signing !== null) return { runs: false, detail: `its signature does not verify and could not be signed again (${signing})` };
  }
  return programRuns(file, run);
}

/** Flush a file, or a directory's entries, to disk. A directory that cannot be opened for it is left as it is. */
function syncPath(p: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    if (!fs.statSync(p).isDirectory()) throw err;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/**
 * Put the executable at `src` at `dest`, which may be running.
 *
 * The bytes go to a temporary file beside `dest`, are synced to disk and
 * made executable, and replace `dest` by one rename, so `dest` is always either
 * the program it held or the whole new one. `move` renames `src` there rather than
 * copying it. `ready`, when given, must pass on the temporary file first; a
 * refusal leaves `dest` untouched. Throws on any failure, with the temporary
 * file removed; with `move`, `src` is gone either way.
 */
export function placeExecutable(
  src: string,
  dest: string,
  options: { platform?: NodeJS.Platform; move?: boolean; ready?: (file: string) => ProgramProbe } = {},
): void {
  const platform = options.platform ?? process.platform;
  const dir = path.dirname(dest);
  // The temporary file keeps the destination's name, in a directory of its own
  // beside it: an ad hoc signature made on it takes its identifier from the name.
  const staging = path.join(dir, `.myco-place-${process.pid}-${Date.now()}`);
  const tmp = path.join(staging, path.basename(dest));
  fs.mkdirSync(staging, { recursive: true });
  try {
    if (options.move === true) fs.renameSync(src, tmp); else fs.copyFileSync(src, tmp);
    syncPath(tmp);
    if (platform !== 'win32') fs.chmodSync(tmp, 0o755);
    const probe = options.ready?.(tmp);
    if (probe !== undefined && !probe.runs) throw new Error(`${src} does not run on this machine: ${probe.detail}`);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  if (platform !== 'win32') syncPath(dir);
}

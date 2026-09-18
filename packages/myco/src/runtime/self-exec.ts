/**
 * The running code as a command it can re-exec itself with.
 *
 * A compiled binary is its own executable and takes no entry script. A checkout run is the runtime it is under
 * plus the entry it was started with; a compiled binary reports that entry from its own virtual filesystem, where
 * it names no file anything can run, and it is answered as no entry.
 */

/** The argv a compiled binary reports for an entry inside itself, which names no file on disk. */
const BUNDLED_ENTRY = ['/$bunfs/', 'B:\\~BUN\\'];

export interface SelfExec {
  /** The executable to run: this binary, or the runtime a checkout is running under. */
  path: string;
  /** What must precede the caller's own arguments: a checkout's entry script, or nothing. */
  args: string[];
}

/**
 * The code an executable and entry name, as a command.
 *
 * Both are given: an absent entry is an answer here — a compiled binary has none — and a caller that means this
 * process says so with `selfExec()`.
 */
export function selfExecOf(execPath: string, argv1: string | undefined): SelfExec {
  const entry = argv1 === undefined || argv1 === '' || BUNDLED_ENTRY.some((prefix) => argv1.startsWith(prefix))
    ? null
    : argv1;
  return { path: execPath, args: entry === null ? [] : [entry] };
}

/** The running code as a command, from this process's own executable and entry. */
export const selfExec = (): SelfExec => selfExecOf(process.execPath, process.argv[1]);

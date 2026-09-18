/**
 * How the running code re-execs itself.
 *
 * A compiled binary is its own executable and takes no entry script; a checkout run is the runtime plus the entry
 * it was started with, whose path a compiled binary reports from its own virtual filesystem and which is not a
 * file anything can run. Answering both is what keeps a re-exec on the same code as its caller.
 *
 * Its own module, so a caller that only re-execs itself takes none of the install-time resolution — a pin, a
 * managed copy or the machine's own layout — that the other policies consult.
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

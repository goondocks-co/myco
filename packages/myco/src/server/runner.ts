/**
 * The seam every Deployment operation runs its commands through.
 *
 * Compose is driven by a subprocess, and a subprocess in a test is either a
 * real container or a mock. Real containers make the suite depend on a Docker
 * daemon and a registry; mocking `child_process` globally leaks across files.
 * A named port keeps the orchestration under test and the container out of it,
 * and it is the same shape the harness ports already use.
 *
 * The real implementation is the only place in the Deployment path that spawns
 * anything, so `tests/server/deployment-*.test.ts` can assert the exact argv a
 * command produces rather than its effect on a machine.
 */
import { existsSync } from 'node:fs';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How a command is run: where, with what environment, what it reads on stdin, and how long it may take. A secret travels on stdin, never in argv. */
export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /**
   * Past this the command and the processes it started are ended and the call rejects with `CommandTimedOut`.
   * A request one of them already sent to a remote service may still land, so the outcome is unknown rather than
   * undone. Absent, the command may take as long as it takes.
   */
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

/**
 * Raised when a command is pointed at a working directory that is not on disk.
 *
 * The platform reports a spawn into an absent directory as `ENOENT` against the
 * COMMAND, which sends whoever reads it hunting for a program that is on the
 * PATH. The directory is named here instead, so the message points at the thing
 * that is missing.
 */
export class WorkingDirectoryMissing extends Error {
  constructor(readonly directory: string, readonly command: string) {
    super(`${command} cannot run in ${directory}: that directory does not exist`);
    this.name = 'WorkingDirectoryMissing';
  }
}

/**
 * What became of the processes a command left behind.
 *
 * `ended` and `absent` are settled: nothing of that tree is running. `failed` and `unknown` are not, and they
 * are not interchangeable with each other or with success — a caller told the tree was ended when it was not
 * goes on to treat a live process as gone.
 */
export type ProcessTreeEnd = 'ended' | 'absent' | 'failed' | 'unknown';

/** How long the platform's own tree-killer may take before its result is unknown. */
export const TREE_END_TIMEOUT_MS = 10_000;

/**
 * What a signal to a process group says about it.
 *
 * `ESRCH` is the group already being gone, which is settled. Anything else — `EPERM` against a group this
 * process may not signal, a platform refusal — is a failure to end it, and saying "already gone" for those is
 * how a live tree gets reported as ended.
 */
export function processTreeEndOfSignal(error: unknown): ProcessTreeEnd {
  return (error as { code?: string } | null)?.code === 'ESRCH' ? 'absent' : 'failed';
}

/**
 * What a `taskkill /T /F` run says about the tree it was pointed at.
 *
 * Exit 0 ended it. Any other exit is a failure — `taskkill` exits 1 on an access denial, which leaves the tree
 * running. Exit 128 is its own "process not found", and that is about the PID it was given: the wrapper may
 * simply have exited already while a descendant it started still runs and still holds the pipes. Nothing here
 * proves those descendants ended, so it answers `unknown` rather than calling the tree gone. A run that could
 * not be started, or that did not finish inside its own window, says nothing about the tree either.
 */
export function processTreeEndOfTaskkill(outcome: { code?: number | null; error?: unknown; timedOut?: boolean }): ProcessTreeEnd {
  if (outcome.timedOut === true || outcome.error !== undefined) return 'unknown';
  if (outcome.code === 0) return 'ended';
  if (outcome.code === 128) return 'unknown';
  return 'failed';
}

/** Whether a process is still there, for a caller that has to tell an empty group from an ungrouped process. */
function processPresent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Anything but "no such process" means it exists and this process may not signal it.
    return (error as { code?: string } | null)?.code !== 'ESRCH';
  }
}

/**
 * Ends a command that outran its deadline, and everything it started, and answers what it managed.
 *
 * Signalling the command alone leaves the processes it spawned running: `npx` runs its tool as a child of its
 * own, so the tool survives its launcher. Those descendants also inherit the pipes, and `close` waits for the
 * last writer to let go — so waiting for it waits for exactly the processes the deadline was supposed to end.
 * A command given a deadline is therefore started in a process group of its own, and the deadline ends the
 * group. Windows has no group to signal, so the tree is ended by pid, and that run is waited for inside its
 * own window: a fire-and-forget `taskkill` whose access is denied reports nothing while the tree keeps
 * running.
 *
 * What no kill can do is take back a request a remote service already accepted. This ends the waiting, not the
 * mutation: the caller reads its own token back to learn what landed.
 */
async function endProcessTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): Promise<ProcessTreeEnd> {
  const pid = child.pid;
  if (pid === undefined) return 'absent';
  if (process.platform === 'win32') {
    const { spawn } = await import('node:child_process');
    return await new Promise<ProcessTreeEnd>((resolve) => {
      let settled = false;
      const answer = (outcome: { code?: number | null; error?: unknown; timedOut?: boolean }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(processTreeEndOfTaskkill(outcome));
      };
      const timer = setTimeout(() => {
        try { killer.kill('SIGKILL'); } catch { /* it is the thing that would not answer */ }
        answer({ timedOut: true });
      }, TREE_END_TIMEOUT_MS);
      let killer: import('node:child_process').ChildProcess;
      try {
        killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch (error) { answer({ error }); return; }
      // A spawn failure arrives as an event, not as a throw, and an unhandled one would take the process down.
      killer.on('error', (error) => { answer({ error }); });
      killer.on('close', (code) => { answer({ code }); });
    });
  }
  // The group, by the leader's own pid, which `detached` made it. The group signal is the whole cleanup: a
  // command given a deadline owns a group, so ending the leader alone would end the leader and leave what it
  // started running. A refused group signal therefore stays a failed tree cleanup, and nothing may upgrade it.
  // A descendant that left the group outlives this too, and so does a request already in flight; neither is
  // something a caller may treat as settled.
  try {
    process.kill(-pid, 'SIGKILL');
    return 'ended';
  } catch (groupError) {
    const group = processTreeEndOfSignal(groupError);
    // "No such group" is the tree being gone only if the leader is gone with it. A process that never became a
    // group leader answers the same way while it and its children are still running, so the leader decides.
    if (group === 'absent') return processPresent(pid) ? 'failed' : 'absent';
    return group;
  }
}

/** Spawns for real. */
export function systemRunner(): CommandRunner {
  return {
    async run(command, args, options) {
      if (options?.cwd !== undefined && !existsSync(options.cwd)) throw new WorkingDirectoryMissing(options.cwd, command);
      const { spawn } = await import('node:child_process');
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd: options?.cwd,
          env: options?.env ?? process.env,
          stdio: [options?.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          // Only a bounded command leads its own group: an unbounded one keeps sharing this process's group, so it
          // still goes when the terminal ends this one.
          detached: options?.timeoutMs !== undefined && process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        // A command that answers nothing holds its caller forever, and the
        // callers here are operator verbs with a person waiting on them. The
        // kill is SIGKILL: the window has already passed, and a child that
        // ignores SIGTERM would extend it.
        let done = false;
        const timer = options?.timeoutMs === undefined ? null : setTimeout(() => {
          if (done) return;
          done = true;
          // The answer is the deadline and what ending the tree managed, not whatever that tree does next:
          // waiting for `close` here would wait on the inherited pipes of the processes being killed.
          child.stdout?.destroy();
          child.stderr?.destroy();
          void endProcessTree(child).then((treeEnd) => {
            child.unref();
            reject(new CommandTimedOut(command, args, options.timeoutMs!, treeEnd));
          });
        }, options.timeoutMs);
        const settled = (): boolean => {
          if (done) return false;
          done = true;
          if (timer !== null) clearTimeout(timer);
          return true;
        };
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', (err) => { if (settled()) reject(err); });
        child.on('close', (code) => { if (settled()) resolve({ code: code ?? -1, stdout, stderr }); });
        if (options?.input !== undefined && child.stdin) {
          child.stdin.on('error', () => undefined);
          child.stdin.end(options.input);
        }
      });
    },
  };
}

/** Where a JSON document opening at `start` ends, or -1 when it never closes. A bracket inside a string is text. */
function documentEnd(text: string, start: number): number {
  const open = text[start]!;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
  }
  return -1;
}

/**
 * The JSON value inside a command's output.
 *
 * A command prints its own preamble and trailer around the document — npm's
 * notices, a tool's configuration warnings, a log-file line — and a
 * colour-coded warning opens with a bracket of its own, so every line that
 * could open a document is tried and each is read only as far as its matching
 * close. Output carrying no readable document answers null rather than
 * throwing: the caller decides what that means.
 */
export function jsonDocument<T>(text: string): T | null {
  let offset = 0;
  for (const line of text.split('\n')) {
    const opens = line.length - line.trimStart().length;
    const char = line[opens];
    if (char === '[' || char === '{') {
      const end = documentEnd(text, offset + opens);
      if (end > 0) {
        try {
          return JSON.parse(text.slice(offset + opens, end)) as T;
        } catch { /* a line that only looked like an opening bracket; keep looking */ }
      }
    }
    offset += line.length + 1;
  }
  return null;
}

/** How many lines of a failed command's own output a message carries. */
const FAILURE_LINES = 6;
/** How many characters of those lines a message carries. */
const FAILURE_CHARS = 1000;

/** The error document a `--json` command prints when the API refuses it. */
interface ErrorDocument {
  error?: { text?: unknown; notes?: unknown };
}

/** The error a JSON answer names, with each note it carries, or null when the output holds no such document. */
function jsonFailure(stdout: string): string | null {
  const document = jsonDocument<ErrorDocument>(stdout);
  const text = document?.error?.text;
  if (typeof text !== 'string' || text.trim() === '') return null;
  const lines = [text.trim()];
  for (const note of Array.isArray(document?.error?.notes) ? document.error.notes : []) {
    const noteText = (note as { text?: unknown } | null)?.text;
    if (typeof noteText === 'string' && noteText.trim() !== '') lines.push(noteText.trim());
  }
  return lines.join('\n');
}

/** Colour codes, which a warning wears in the middle of its own name. */
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * The tail of a command's own output, with the noise a wrapper prints around
 * it dropped: npm's notices, and the `[WARNING]` block a tool opens with its
 * indented continuation. Colour codes come off first, because a coloured
 * warning carries them inside the word the filter matches. What is left is
 * bounded, because an operator reading a failure needs the last thing the
 * command said, not its whole session.
 */
export function commandOutputTail(text: string): string {
  const kept: string[] = [];
  let inWarning = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(ANSI, '');
    if (line.includes('[WARNING]')) { inWarning = true; continue; }
    if (inWarning) {
      if (line.trim() === '' || /^\s/.test(line)) continue;
      inWarning = false;
    }
    if (line.trim() === '' || /^\s*npm notice/.test(line)) continue;
    kept.push(line.trimEnd());
  }
  const tail = kept.slice(-FAILURE_LINES).join('\n');
  return tail.length > FAILURE_CHARS ? tail.slice(tail.length - FAILURE_CHARS) : tail;
}

/**
 * What a failed command actually said.
 *
 * A `--json` command writes its error document to stdout and its
 * configuration warnings to stderr, so a message built from stderr alone names
 * the warning and not the failure. The JSON document answers first, then both
 * streams with the wrapper noise dropped. Nothing survives the filters only
 * when the whole output was noise, and then the raw output is better than
 * silence.
 */
export function commandFailureDetail(result: CommandResult): string {
  const named = jsonFailure(result.stdout);
  if (named !== null) return named;
  const spoken = [commandOutputTail(result.stdout), commandOutputTail(result.stderr)].filter((part) => part !== '');
  if (spoken.length > 0) return spoken.join('\n');
  return result.stderr.trim() || result.stdout.trim();
}

/** What went wrong, in the words the thing that failed used. */
export function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the message says about a tree, which is only ever what ending it actually answered. */
const TREE_END_SAID: Record<ProcessTreeEnd, string> = {
  ended: 'it and the processes it started were ended',
  absent: 'it and the processes it started were already gone',
  failed: 'the processes it started could NOT be ended and may still be running',
  unknown: 'whether the processes it started were ended is unknown',
};

/**
 * Raised when a command answered nothing inside the window its caller gave it.
 *
 * `treeEnd` is what ending the command and its descendants managed, and it is not always success: a tree-killer
 * can be refused or answer nothing itself. A caller that must know whether anything is still running reads it
 * rather than the fact of the timeout. Either way a request one of those processes already sent may still land,
 * so the remote outcome is unknown, not undone.
 */
export class CommandTimedOut extends Error {
  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly timeoutMs: number,
    readonly treeEnd: ProcessTreeEnd = 'unknown',
  ) {
    super(`${command} ${args.join(' ')} answered nothing in ${timeoutMs < 1000 ? `${timeoutMs} ms` : `${Math.round(timeoutMs / 1000)} s`}; ${TREE_END_SAID[treeEnd]}`);
    this.name = 'CommandTimedOut';
  }
}

/** Raised with what the command itself said, which is what an operator needs to see. */
export class CommandFailed extends Error {
  constructor(readonly command: string, readonly args: readonly string[], readonly result: CommandResult) {
    super(`${command} ${args.join(' ')} exited ${result.code}: ${commandFailureDetail(result)}`);
    this.name = 'CommandFailed';
  }

  get stdout(): string { return this.result.stdout; }

  get stderr(): string { return this.result.stderr; }
}

/** Whether an error is the command's own answer — a refusal or a silence — rather than a fault in the caller. */
export function isCommandFailure(err: unknown): err is CommandFailed | CommandTimedOut {
  return err instanceof CommandFailed || err instanceof CommandTimedOut;
}

export async function runOrThrow(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): Promise<CommandResult> {
  const result = await runner.run(command, args, options);
  if (result.code !== 0) throw new CommandFailed(command, args, result);
  return result;
}

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
  /** Past this the child is killed and the call rejects. Absent, the command may take as long as it takes. */
  timeoutMs?: number;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: RunOptions): Promise<CommandResult>;
}

/** Spawns for real. */
export function systemRunner(): CommandRunner {
  return {
    async run(command, args, options) {
      const { spawn } = await import('node:child_process');
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command, [...args], {
          cwd: options?.cwd,
          env: options?.env ?? process.env,
          stdio: [options?.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        // A command that answers nothing holds its caller forever, and the
        // callers here are operator verbs with a person waiting on them. The
        // kill is SIGKILL: the window has already passed, and a child that
        // ignores SIGTERM would extend it.
        let timedOut = false;
        const timer = options?.timeoutMs === undefined ? null : setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, options.timeoutMs);
        const settled = (): void => { if (timer !== null) clearTimeout(timer); };
        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        child.on('error', (err) => { settled(); reject(err); });
        child.on('close', (code) => {
          settled();
          if (timedOut) reject(new CommandTimedOut(command, args, options!.timeoutMs!));
          else resolve({ code: code ?? -1, stdout, stderr });
        });
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

/** Raised when a command answered nothing inside the window its caller gave it; the child is killed first. */
export class CommandTimedOut extends Error {
  constructor(readonly command: string, readonly args: readonly string[], readonly timeoutMs: number) {
    super(`${command} ${args.join(' ')} answered nothing in ${Math.round(timeoutMs / 1000)} s and was killed`);
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

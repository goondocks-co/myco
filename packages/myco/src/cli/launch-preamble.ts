import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRuntimePinForCwd } from '../daemon/update-checker.js';
import { setBufferedStdin } from '../hooks/read-stdin.js';

export type LaunchCommand = 'hook' | 'mcp' | 'tool';

/**
 * Side-effecting seams, injected so tests can observe exit/exec/chdir without
 * terminating, spawning, or mutating cwd. Defaults bind the real process I/O.
 */
export interface LaunchPreambleDeps {
  execPath: string;
  cwd: () => string;
  chdir: (dir: string) => void;
  exit: (code: number) => void;
  /** Resolve the layered runtime pin for the anchored cwd; null when unpinned. */
  resolveRuntimePin: (cwd: string) => string | null;
  realpathSync: (p: string) => string;
  readFd0: () => Buffer;
  execFileSync: (file: string, args: string[], options: ExecOptions) => Buffer;
}

interface ExecOptions {
  input?: Buffer;
  stdio?: 'inherit' | Array<'pipe' | 'inherit'>;
  env?: NodeJS.ProcessEnv;
}

const PROJECT_DIR_ENV_VARS = [
  'CURSOR_PROJECT_DIR',
  'CLAUDE_PROJECT_DIR',
  'WINDSURF_PROJECT_DIR',
  'MYCO_PROJECT_ROOT',
];

function defaultDeps(): LaunchPreambleDeps {
  return {
    execPath: process.execPath,
    cwd: () => process.cwd(),
    chdir: (dir: string) => process.chdir(dir),
    exit: (code: number) => process.exit(code),
    resolveRuntimePin: (cwd: string) => resolveRuntimePinForCwd(cwd),
    realpathSync: (p: string) => fs.realpathSync(p),
    readFd0: () => fs.readFileSync(0),
    execFileSync: (file, args, options) =>
      execFileSync(file, args, options) as unknown as Buffer,
  };
}

/**
 * Pre-processing that lets the binary be a hook/MCP/tool entry point directly.
 *
 * For `hook` it guards against recursion, anchors cwd to the spawning agent's
 * project dir, and buffers Antigravity's stdin (the workspace lives in the
 * stdin JSON, so it must be read here and re-fed in-process). These guards are
 * hook-only: an agent firing a hook may run from its own dir and provides the
 * project via env or stdin, whereas MCP/tool are invoked by the harness from a
 * known cwd.
 *
 * All three commands then honor the runtime pin: if a pin names a different
 * binary than this one, re-exec it and propagate its exit; otherwise return so
 * the normal handler runs. Re-running is idempotent — when cwd is already
 * anchored and the pin already names this binary, the preamble finds nothing
 * to do and returns.
 */
export function runLaunchPreamble(
  command: LaunchCommand,
  argv: string[],
  deps: LaunchPreambleDeps = defaultDeps(),
): void {
  let bufferedAntigravityStdin: Buffer | null = null;

  if (command === 'hook') {
    // Hook-only on purpose: MCP/tool under a Myco agent session must still
    // reach the binary because the harness itself invokes `myco tool call`
    // and opens MCP with MYCO_AGENT_SESSION set.
    if (process.env.MYCO_AGENT_SESSION) {
      deps.exit(0);
      return;
    }

    for (const name of PROJECT_DIR_ENV_VARS) {
      const value = process.env[name];
      if (value && value !== '.') {
        try { deps.chdir(value); break; } catch { /* try next */ }
      }
    }

    if (argv.includes('--symbiont') && argv[argv.indexOf('--symbiont') + 1] === 'antigravity') {
      try {
        bufferedAntigravityStdin = deps.readFd0();
        if (bufferedAntigravityStdin.length > 0) {
          const payload = JSON.parse(bufferedAntigravityStdin.toString('utf-8')) as { workspacePaths?: unknown };
          const workspace = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths[0] : null;
          if (typeof workspace === 'string' && workspace.length > 0) {
            try { deps.chdir(workspace); } catch { /* fall through with original cwd */ }
          }
        }
      } catch { /* unreadable stdin or non-JSON; fall through */ }
    }
  }

  const pin = deps.resolveRuntimePin(deps.cwd());
  if (pin && !process.env.MYCO_TRAMPOLINED && pinPointsElsewhere(pin, deps)) {
    reExec(command, argv, pin, bufferedAntigravityStdin, deps);
    return;
  }

  // Fall-through: the handler runs in-process. Re-feed Antigravity's stdin so
  // its readStdin() sees the buffered payload, not a drained fd 0. On the
  // re-exec path above the buffer is forwarded to the child via `input:`.
  if (bufferedAntigravityStdin !== null) setBufferedStdin(bufferedAntigravityStdin);
}

/**
 * True when `pin` resolves to a different binary than `process.execPath`.
 * A bare/relative pin (e.g. `myco`) with no path separator can't name a
 * distinct absolute target, so it's treated as self → no re-exec.
 */
function pinPointsElsewhere(pin: string, deps: LaunchPreambleDeps): boolean {
  if (!pin.includes('/') && !pin.includes('\\')) return false;
  const pinAbs = path.resolve(pin);
  const pinReal = realpathOr(pinAbs, deps.realpathSync);
  const selfReal = realpathOr(deps.execPath, deps.realpathSync);
  return pinReal !== selfReal;
}

function realpathOr(p: string, realpathSync: (p: string) => string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function reExec(
  command: LaunchCommand,
  argv: string[],
  pin: string,
  bufferedStdin: Buffer | null,
  deps: LaunchPreambleDeps,
): void {
  const options: ExecOptions = {
    env: { ...process.env, MYCO_TRAMPOLINED: '1' },
    ...(bufferedStdin !== null
      ? { input: bufferedStdin, stdio: ['pipe', 'inherit', 'inherit'] }
      : { stdio: 'inherit' }),
  };

  let failure: { code?: string; status?: number } | null = null;
  try {
    deps.execFileSync(pin, [command, ...argv], options);
  } catch (err) {
    failure = (err && typeof err === 'object') ? err as { code?: string; status?: number } : {};
  }

  if (failure === null) {
    deps.exit(0);
    return;
  }
  if (failure.code === 'ENOENT') {
    deps.exit(command === 'hook' ? 0 : 1);
    return;
  }
  if (typeof failure.status === 'number') {
    deps.exit(failure.status);
    return;
  }
  deps.exit(command === 'hook' ? 0 : 1);
}

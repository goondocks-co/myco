import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRuntimePinForCwd } from '../runtime/runtime-pin.js';
import { setBufferedStdin } from '../hooks/read-stdin.js';
import { startingJobEnv } from '../runtime/spawn-detached.js';
import { PROJECT_DIR_ENV_VARS, STDIN_WORKSPACE_FIELDS } from './launch-preamble.generated.js';

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
  /** Host platform. Defaulted to `process.platform`; tests inject `'win32'`. */
  platform: NodeJS.Platform;
  /** True when a path exists on disk. Used by the Windows pin resolver. */
  existsSync: (p: string) => boolean;
  /** PATH search dirs (process.env.PATH split on the platform delimiter). */
  pathDirs: () => string[];
  /** Executable extensions to try, lowercased (PATHEXT on Windows). */
  pathExts: () => string[];
}

interface ExecOptions {
  input?: Buffer;
  stdio?: 'inherit' | Array<'pipe' | 'inherit'>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Where a hook starts: the project directory its harness names (its manifest's `projectDirEnvVar`), then any other
 * harness's, then `MYCO_PROJECT_ROOT`. The first that is set and can be entered wins.
 */
function projectDirEnvVars(harness: string | undefined): string[] {
  const own = harness === undefined ? undefined : PROJECT_DIR_ENV_VARS[harness];
  return [...new Set([...(own === undefined ? [] : [own]), ...Object.values(PROJECT_DIR_ENV_VARS), 'MYCO_PROJECT_ROOT'])];
}

/** The harness a hook command names (`--symbiont <name>` or `--symbiont=<name>`). */
function harnessNamed(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--symbiont') return argv[i + 1];
    if (argv[i]!.startsWith('--symbiont=')) return argv[i]!.slice('--symbiont='.length);
  }
  return undefined;
}

/**
 * PATHEXT fallback when the env var is unset. Mirrors the Windows default
 * search order and the extensions the rest of the codebase resolves (a
 * runtime.command alias is typically installed as a `.cmd` shim).
 */
const DEFAULT_PATHEXT = ['.com', '.exe', '.bat', '.cmd'];

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
    platform: process.platform,
    existsSync: (p: string) => fs.existsSync(p),
    pathDirs: () => (process.env.PATH ?? '').split(path.delimiter).filter(Boolean),
    pathExts: () =>
      ((process.env.PATHEXT ?? DEFAULT_PATHEXT.join(path.delimiter))
        .split(path.delimiter)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)),
  };
}

/**
 * Pre-processing that lets the binary be a hook/MCP/tool entry point directly.
 *
 * For `hook` it guards against recursion, anchors cwd to the spawning agent's
 * project dir, and buffers the stdin of a harness that names its workspace only
 * there (its manifest's `hookInput.workspaceFromStdin`), so it must be read here
 * and re-fed in-process. These guards are
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
  let bufferedStdin: Buffer | null = null;

  if (command === 'hook') {
    // Hook-only on purpose: MCP/tool under a Myco agent session must still
    // reach the binary because the harness itself invokes `myco tool call`
    // and opens MCP with MYCO_AGENT_SESSION set.
    if (process.env.MYCO_AGENT_SESSION) {
      deps.exit(0);
      return;
    }

    const harness = harnessNamed(argv);
    for (const name of projectDirEnvVars(harness)) {
      const value = process.env[name];
      if (value && value !== '.') {
        try { deps.chdir(value); break; } catch { /* try next */ }
      }
    }

    const workspaceField = harness === undefined ? undefined : STDIN_WORKSPACE_FIELDS[harness];
    if (workspaceField !== undefined) {
      try {
        bufferedStdin = deps.readFd0();
        if (bufferedStdin.length > 0) {
          const payload = JSON.parse(bufferedStdin.toString('utf-8')) as Record<string, unknown> | null;
          const named = payload?.[workspaceField];
          const workspace = Array.isArray(named) ? named[0] : named;
          if (typeof workspace === 'string' && workspace.length > 0) {
            try { deps.chdir(workspace); } catch { /* fall through with original cwd */ }
          }
        }
      } catch { /* unreadable stdin or non-JSON; fall through */ }
    }
  }

  const pin = deps.resolveRuntimePin(deps.cwd());
  if (pin && !process.env.MYCO_TRAMPOLINED && pinPointsElsewhere(pin, deps)) {
    reExec(command, argv, pin, bufferedStdin, deps);
    return;
  }

  // Fall-through: the handler runs in-process. Re-feed the stdin read above so
  // its readStdin() sees the buffered payload, not a drained fd 0. On the
  // re-exec path above the buffer is forwarded to the child via `input:`.
  if (bufferedStdin !== null) setBufferedStdin(bufferedStdin);
}

/**
 * True when `pin` should be exec'd rather than handled in-process.
 *
 * A bare pin with no path separator (e.g. `myco-dev`) is a PATH-resolved alias
 * — the documented `runtime.command` alias contract (hook-guard alias tests).
 * We can't cheaply prove whether it resolves to this same binary, so we exec it
 * and let the `MYCO_TRAMPOLINED` loop guard stop a self-alias from recursing.
 * This faithfully matches the retired launcher, which always exec'd the pin
 * value; the only cost is one extra exec when a bare alias happens to resolve to
 * self, and only for deliberately-pinned setups (an unpinned cwd never reaches
 * here). A path-bearing pin is compared by realpath so a self-pin stays
 * in-process.
 */
function pinPointsElsewhere(pin: string, deps: LaunchPreambleDeps): boolean {
  if (!pin.includes('/') && !pin.includes('\\')) return true;
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

/**
 * Resolve a pin to a runnable executable on Windows.
 *
 * `execFileSync` with `shell: false` does NOT apply PATHEXT, so a bare alias
 * (`myco-dev`) or an extensionless absolute path that only exists as
 * `myco-dev.cmd` ENOENTs — which, for a hook, is swallowed as exit(0) and the
 * pinned project's capture goes dark. We replicate the shell's PATHEXT search
 * here so the pin reaches its real `.cmd`/`.exe` shim.
 *
 * Returns the original pin unchanged when:
 *   - not on Windows (POSIX behavior is byte-identical),
 *   - the pin already exists as-given (already runnable / has an extension),
 *   - nothing resolves (so the existing ENOENT-handled exec path still applies).
 */
function resolveExecutableForExec(pin: string, deps: LaunchPreambleDeps): string {
  if (deps.platform !== 'win32') return pin;

  // An explicit, already-existing file (e.g. an absolute `.exe`) is runnable.
  const hasExt = path.extname(pin) !== '';
  if (hasExt && deps.existsSync(pin)) return pin;

  const exts = deps.pathExts();
  const tryExtensions = (base: string): string | null => {
    if (deps.existsSync(base) && hasExt) return base;
    for (const ext of exts) {
      const candidate = base + ext;
      if (deps.existsSync(candidate)) return candidate;
    }
    return null;
  };

  // Path-bearing pin: probe the pin itself (and `pin + ext`) in place.
  if (pin.includes('/') || pin.includes('\\') || path.isAbsolute(pin)) {
    return tryExtensions(pin) ?? pin;
  }

  // Bare alias: walk PATH dirs applying PATHEXT, first match wins.
  for (const dir of deps.pathDirs()) {
    const resolved = tryExtensions(path.join(dir, pin));
    if (resolved) return resolved;
  }
  return pin;
}

function reExec(
  command: LaunchCommand,
  argv: string[],
  pin: string,
  bufferedStdin: Buffer | null,
  deps: LaunchPreambleDeps,
): void {
  const options: ExecOptions = {
    // The pinned binary starts inside this process's job: it is told the job this process began in, which it can no
    // longer read for itself.
    env: { ...process.env, MYCO_TRAMPOLINED: '1', ...startingJobEnv() },
    ...(bufferedStdin !== null
      ? { input: bufferedStdin, stdio: ['pipe', 'inherit', 'inherit'] }
      : { stdio: 'inherit' }),
  };

  const target = resolveExecutableForExec(pin, deps);

  let failure: { code?: string; status?: number } | null = null;
  try {
    deps.execFileSync(target, [command, ...argv], options);
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

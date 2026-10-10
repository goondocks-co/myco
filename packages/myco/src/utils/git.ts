/**
 * Resilient `git` invocation.
 *
 * Hooks fire from GUI-launched agents (Cursor, Claude Code desktop, …) that
 * inherit a STRIPPED PATH — the same reason this release pins `runtime.command`
 * to an absolute binary. A bare `execFileSync('git', …)` then ENOENTs, and the
 * callers swallow it: vault resolution falls back to the wrong dir and the hook
 * silently DROPS the captured event. Capture loss with no error.
 *
 * `resolveGitBinary()` finds a real `git` even when PATH is stripped: PATH first
 * (the normal case), then the platform's well-known install locations. The
 * result is cached for the process. Cross-platform: Windows looks for `git.exe`
 * under the standard "Git for Windows" install dirs; POSIX checks the usual
 * Homebrew / system paths. Falls back to the bare name so a non-standard install
 * still works through whatever PATH does survive.
 */
import { normalizeRemote } from '@goondocks/myco-shared/member-protocol';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

let cachedGitBinary: string | undefined;

/** Injectable seams so the platform-specific resolution order is unit-testable
 *  on any host without mocking the global fs/env. */
export interface GitResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  existsFile: (p: string) => boolean;
}

function defaultGitDeps(): GitResolveDeps {
  return {
    platform: process.platform,
    env: process.env,
    existsFile: (p: string) => {
      try {
        return p.length > 0 && fs.existsSync(p) && fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
  };
}

/** Resolution logic — exported for tests; production uses the cached wrapper. */
export function findGitBinary(deps: GitResolveDeps = defaultGitDeps()): string {
  const isWin = deps.platform === 'win32';
  const exeName = isWin ? 'git.exe' : 'git';
  // Use the TARGET platform's path semantics (separator + delimiter) so the
  // resolution is correct in production AND testable from any host.
  const p = isWin ? path.win32 : path.posix;

  // 1. PATH search — the common case (intact PATH). On Windows execFile would
  //    not reliably append `.exe` for a bare name, so resolve it ourselves.
  for (const dir of (deps.env.PATH ?? '').split(p.delimiter).filter(Boolean)) {
    const candidate = p.join(dir, exeName);
    if (deps.existsFile(candidate)) return candidate;
  }

  // 2. Well-known install locations — covers the stripped-PATH GUI-agent case.
  const programFiles = deps.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = deps.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = deps.env.LOCALAPPDATA ?? '';
  const common = isWin
    ? [
        p.join(programFiles, 'Git', 'cmd', 'git.exe'),
        p.join(programFiles, 'Git', 'bin', 'git.exe'),
        p.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
        localAppData ? p.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe') : '',
      ]
    : ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/local/git/bin/git'];
  for (const candidate of common) {
    if (deps.existsFile(candidate)) return candidate;
  }

  // 3. Last resort: the bare name (execFile PATH-resolves it where it can).
  return exeName;
}

/** Absolute path to a usable `git`, or the bare name if none is found. Cached. */
export function resolveGitBinary(): string {
  if (cachedGitBinary === undefined) cachedGitBinary = findGitBinary();
  return cachedGitBinary;
}

/** Reset the cache. Tests only. */
export function __resetGitBinaryCacheForTest(): void {
  cachedGitBinary = undefined;
}

export interface GitQueryBudget {
  /** The absolute deadline shared by a group of Git queries. */
  deadline?: number;
}

const gitTimeout = (budget: GitQueryBudget): number | undefined =>
  budget.deadline === undefined ? undefined : Math.max(0, budget.deadline - Date.now());

/** Run Git and return trimmed stdout; an explicit expired budget throws. */
export function runGit(args: string[], cwd: string, budget: GitQueryBudget = {}): string {
  const timeout = gitTimeout(budget);
  if (timeout !== undefined && timeout <= 0) throw new Error('Git query budget exhausted');
  return execFileSync(resolveGitBinary(), args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout,
    killSignal: 'SIGKILL',
  }).trim();
}

/** How many times a git query that always answers something is asked before an empty answer counts as a failure. */
export const GIT_ANSWER_ATTEMPTS = 3;

/**
 * Run a git query whose success always prints something — a path, a ref, a
 * commit, a URL — and return its trimmed answer.
 *
 * Bun's `execFileSync` drops a child's stdout under heavy load: git prints its
 * answer and exits 0, and the call returns an empty string without throwing
 * (oven-sh/bun#34069, a pipe-reader race on macOS). The loss is all or
 * nothing — the whole answer, never part of one — so an empty answer to a
 * query that always prints is a lost one. Taken as data, an empty
 * `--git-common-dir` resolves a repository root to the checkout's parent,
 * which holds no membership. Here the query is asked again, and throws once
 * every attempt came back empty, which callers already treat as git unable to
 * say.
 */
export function runGitAnswer(args: string[], cwd: string, run: (args: string[], cwd: string) => string = runGit): string {
  for (let attempt = 1; attempt <= GIT_ANSWER_ATTEMPTS; attempt++) {
    const answer = run(args, cwd);
    if (answer.length > 0) return answer;
  }
  throw new Error(`git ${args.join(' ')} answered nothing in ${cwd} after ${GIT_ANSWER_ATTEMPTS} attempts`);
}

/**
 * Run `git <args>` in `cwd` for its exit status alone, with no output read:
 * the status survives what drops a child's stdout (see `runGitAnswer`). Null
 * when git could not be run or ended on a signal.
 */
export function gitExitStatus(args: string[], cwd: string, budget: GitQueryBudget = {}): number | null {
  const timeout = gitTimeout(budget);
  if (timeout !== undefined && timeout <= 0) return null;
  const result = spawnSync(resolveGitBinary(), args, { cwd, stdio: 'ignore', timeout, killSignal: 'SIGKILL' });
  return result.error === undefined ? result.status : null;
}

/** `gitExitStatus` without blocking: several can be asked at once. */
export function gitExitStatusAsync(args: string[], cwd: string, budget: GitQueryBudget = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const timeout = gitTimeout(budget);
    if (timeout !== undefined && timeout <= 0) { resolve(null); return; }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(resolveGitBinary(), args, { cwd, stdio: 'ignore' });
    } catch {
      resolve(null);
      return;
    }
    const timer = timeout === undefined ? undefined : setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeout);
    child.on('error', () => { if (timer !== undefined) clearTimeout(timer); resolve(null); });
    child.on('close', (code, signal) => { if (timer !== undefined) clearTimeout(timer); resolve(signal !== null ? null : code); });
  });
}

function gitAnswer(root: string, args: string[], budget: GitQueryBudget): string | null {
  try { return runGitAnswer(args, root, (args, cwd) => runGit(args, cwd, budget)); } catch { return null; }
}

/** The normalized origin, or first remote, when Git can read one. */
export function repositoryRemote(root: string, budget: GitQueryBudget = {}): string | null {
  let remote = gitAnswer(root, ['remote', 'get-url', 'origin'], budget);
  if (remote === null) {
    const first = gitAnswer(root, ['remote'], budget)?.split('\n').find((name) => name.trim().length > 0);
    if (first !== undefined) remote = gitAnswer(root, ['remote', 'get-url', first.trim()], budget);
  }
  return remote === null ? null : normalizeRemote(remote);
}

/** A repository's main checkout folder, then its remote name, then the supplied root's folder. */
export function repositoryName(root: string, options: GitQueryBudget & { remote?: string | null; commonDir?: string | null } = {}): string {
  const resolved = path.resolve(root);
  const common = options.commonDir === undefined
    ? gitAnswer(resolved, ['rev-parse', '--path-format=absolute', '--git-common-dir'], options)
    : options.commonDir;
  if (common !== null && path.basename(common) === '.git') return path.basename(path.dirname(common));
  const repository = options.remote === undefined ? repositoryRemote(resolved, options) : options.remote;
  return repository?.split('/').at(-1) || path.basename(resolved);
}

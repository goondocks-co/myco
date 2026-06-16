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
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

/**
 * Run `git <args>` in `cwd` and return trimmed stdout. Throws on non-zero exit
 * or a missing git (callers already wrap in try/catch and fall back). Uses the
 * resolved binary so a stripped PATH doesn't ENOENT.
 */
export function runGit(args: string[], cwd: string): string {
  return execFileSync(resolveGitBinary(), args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

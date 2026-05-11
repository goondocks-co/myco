import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Resolve the vault directory.
 *
 * Always `.myco/` in the project root. The vault is a SQLite database
 * that lives with the project — there is no escape hatch.
 *
 * Uses git to find the repo root so this works correctly in
 * git worktrees — worktree agents resolve to the same vault
 * as the main working tree.
 */
export function resolveVaultDir(cwd: string = process.cwd()): string {
  return path.join(resolveRepoRoot(cwd), '.myco');
}

/**
 * Canonical project root from a vault directory.
 *
 * Always derive `projectRoot` from `vaultDir` via this helper. `vaultDir`
 * already runs through the worktree-aware walk in `resolveVaultDir`, so
 * daemon callers share one project-root identity regardless of launch cwd.
 */
export function resolveProjectRoot(vaultDir: string): string {
  return path.dirname(vaultDir);
}

/**
 * Refuse to treat dangerously-broad paths as a project root.
 *
 * A project root is meant to be a single repo or workspace directory. When
 * `myco init` (or any other registration site) is handed `$HOME`, `/`, or
 * a direct child of `/Users` / `/home` / `/root`, the user almost certainly
 * ran the command from the wrong cwd. Letting it through registers a
 * "project" that owns the entire home directory — which then poisons
 * downstream tools like the canopy scanner, which try to walk every file
 * under the project root.
 *
 * Throws `UnsafeProjectRootError` with a message that explains both what
 * was rejected and the likely fix. Call from every project-creation entry
 * point: `myco init`, MCP register tools, and `registerProjectInGrove`
 * (defense in depth).
 */
export class UnsafeProjectRootError extends Error {
  constructor(public readonly projectRoot: string, public readonly reason: string) {
    super(
      `Refusing to use ${projectRoot} as a project root: ${reason}. ` +
      `Run \`myco init\` from inside a specific project directory ` +
      `(e.g., a checked-out git repo), not from your home directory or filesystem root.`,
    );
    this.name = 'UnsafeProjectRootError';
  }
}

// Paths that are themselves well-known user home directories, even when
// they don't match the calling user's $HOME. Caught by an exact match.
const KNOWN_HOME_DIRS = new Set(['/root', '/var/root']);
// Parent dirs whose direct children are conventionally a user's home
// (e.g., `/Users/anyone` on macOS, `/home/anyone` on Linux). A path one
// segment below any of these is rejected.
const HOME_PARENT_DIRS = new Set(['/Users', '/home', '/root', '/var/root']);

export function assertSafeProjectRoot(projectRoot: string): void {
  const resolved = path.resolve(projectRoot);

  if (resolved === os.homedir()) {
    throw new UnsafeProjectRootError(resolved, "this is the user's home directory ($HOME)");
  }

  if (resolved === path.parse(resolved).root) {
    throw new UnsafeProjectRootError(resolved, 'this is the filesystem root');
  }

  if (KNOWN_HOME_DIRS.has(resolved)) {
    throw new UnsafeProjectRootError(resolved, 'this is a well-known user home directory');
  }

  const parent = path.dirname(resolved);
  if (HOME_PARENT_DIRS.has(parent)) {
    throw new UnsafeProjectRootError(
      resolved,
      `this looks like a user home directory (direct child of ${parent})`,
    );
  }
}

/**
 * Find the main repo root, even from a git worktree.
 *
 * `git rev-parse --git-common-dir` returns the shared .git directory:
 * - In a normal repo: ".git" (relative)
 * - In a worktree: "/abs/path/to/main-repo/.git" (absolute)
 *
 * The repo root is the parent of that path.
 * Falls back to cwd if not in a git repo.
 */
function resolveRepoRoot(cwd: string): string {
  try {
    const gitCommon = execFileSync(
      'git', ['rev-parse', '--git-common-dir'],
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return path.resolve(cwd, gitCommon, '..');
  } catch {
    return cwd;
  }
}

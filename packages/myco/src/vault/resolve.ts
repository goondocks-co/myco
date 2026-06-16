import path from 'node:path';
import os from 'node:os';
import { runGit } from '../utils/git.js';

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
 * any registration site is handed `$HOME`, `/`, or a direct child of
 * `/Users` / `/home` / `/root`, an agent hook almost certainly fired from
 * the wrong cwd. Letting it through registers a "project" that owns the
 * entire home directory — which then poisons downstream tools like the
 * canopy scanner, which try to walk every file under the project root.
 *
 * Throws `UnsafeProjectRootError` with a message that explains both what
 * was rejected and the likely fix. Call from every project-creation entry
 * point: auto-registration on hook, MCP register tools, and
 * `registerProjectInGrove` (defense in depth).
 */
export class UnsafeProjectRootError extends Error {
  constructor(public readonly projectRoot: string, public readonly reason: string) {
    super(
      `Refusing to use ${projectRoot} as a project root: ${reason}. ` +
      `Open Myco-aware agents from inside a specific project directory ` +
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

/**
 * Boolean variant of `assertSafeProjectRoot` for the hook hot path,
 * combined with the "real project signal" check from the global-install
 * plan (Decision 2). A project root is safe AND has a real signal when:
 *
 *   1. The basic safety predicate passes (not `$HOME`, not `/`, not a
 *      well-known home dir or direct child thereof).
 *   2. Either `.git/` resolves successfully from this path (the
 *      `resolveRepoRoot` walk), OR one of `MYCO_PROJECT_ROOT` /
 *      `MYCO_VAULT_DIR` env vars was explicitly set by the symbiont's
 *      launch config — even an absent `.git` is fine when the agent
 *      promises the root is correct.
 *
 * Returns `false` for cwd-fallback paths so the hook layer no-ops
 * cleanly: no project gets auto-registered, no buffer is created in an
 * unexpected location, no Canopy scan kicks off scanning `~`.
 */
export function isSafeProjectRoot(projectRoot: string): boolean {
  try {
    assertSafeProjectRoot(projectRoot);
  } catch {
    return false;
  }
  if (process.env.MYCO_PROJECT_ROOT || process.env.MYCO_VAULT_DIR) return true;
  const resolved = path.resolve(projectRoot);
  try {
    const gitCommon = runGit(['rev-parse', '--git-common-dir'], resolved);
    return gitCommon.length > 0;
  } catch {
    return false;
  }
}

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
    const gitCommon = runGit(['rev-parse', '--git-common-dir'], cwd);
    return path.resolve(cwd, gitCommon, '..');
  } catch {
    return cwd;
  }
}

/**
 * Resolve the current git worktree's top-level directory (not the main
 * repo root). In a worktree this is the worktree path; in the main repo
 * it equals the main repo root. Returns null when cwd isn't in a git
 * repo at all.
 */
export function resolveWorktreeRoot(cwd: string = process.cwd()): string | null {
  try {
    return runGit(['rev-parse', '--show-toplevel'], cwd);
  } catch {
    return null;
  }
}

/**
 * Resolve the main repo root from anywhere — worktree or not. Returns
 * the same answer as `resolveVaultDir(..).parent`, exposed directly so
 * callers can compare against `resolveWorktreeRoot` to detect worktrees.
 */
export function resolveMainRepoRoot(cwd: string = process.cwd()): string {
  return resolveRepoRoot(cwd);
}

/**
 * True when `cwd` is inside a git worktree that is NOT the main repo
 * checkout. Myco resolves a worktree's capture to the main checkout's
 * `.myco` vault so sessions from every worktree of a repo land in one
 * place; this helper detects the worktree case so callers can redirect.
 */
export function isInsideWorktree(cwd: string = process.cwd()): boolean {
  const worktreeRoot = resolveWorktreeRoot(cwd);
  if (!worktreeRoot) return false;
  const mainRepoRoot = resolveMainRepoRoot(cwd);
  return path.resolve(worktreeRoot) !== path.resolve(mainRepoRoot);
}

import path from 'node:path';
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
 * Always derive `projectRoot` from `vaultDir` via this helper; sourcing
 * from `process.cwd()` is the divergence pattern that caused the Canopy
 * mass-tombstone bug. `vaultDir` already runs through the worktree-aware
 * walk in `resolveVaultDir`, so it survives any cwd the daemon inherits
 * from its launch context (hub-spawned children, monorepo subdirs).
 */
export function resolveProjectRoot(vaultDir: string): string {
  return path.dirname(vaultDir);
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

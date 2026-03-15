import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Resolve the vault directory.
 * Priority: MYCO_VAULT_DIR env var > .myco/ in repo root.
 *
 * Uses git to find the repo root so this works correctly in
 * git worktrees — worktree agents resolve to the same vault
 * as the main working tree.
 */
export function resolveVaultDir(cwd = process.cwd()): string {
  if (process.env.MYCO_VAULT_DIR) {
    const dir = process.env.MYCO_VAULT_DIR;
    // Expand ~ to home directory (env vars don't get shell expansion)
    if (dir.startsWith('~/')) {
      return path.join(os.homedir(), dir.slice(2));
    }
    return dir;
  }
  return path.join(resolveRepoRoot(cwd), '.myco');
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

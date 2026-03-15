import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Resolve the vault directory.
 *
 * Priority:
 * 1. MYCO_VAULT_DIR env var (override for public repos or shared vaults)
 * 2. .myco/ in the repo root (default — vault lives with the project)
 *
 * The default is project-local: the vault is committed to git alongside
 * the code, so the team's institutional memory travels with the repo.
 * For public repos or cases where the vault should be separate, set
 * MYCO_VAULT_DIR to an external path.
 *
 * Uses git to find the repo root so this works correctly in
 * git worktrees — worktree agents resolve to the same vault
 * as the main working tree.
 */
export function resolveVaultDir(cwd = process.cwd()): string {
  // Override: external vault location
  if (process.env.MYCO_VAULT_DIR) {
    const dir = process.env.MYCO_VAULT_DIR;
    if (dir.startsWith('~/')) {
      return path.join(os.homedir(), dir.slice(2));
    }
    return dir;
  }

  // Default: .myco/ in the project root
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

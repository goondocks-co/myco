import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MYCO_PROJECT_ROOT_ENV = 'MYCO_PROJECT_ROOT';
export const MYCO_VAULT_DIR_ENV = 'MYCO_VAULT_DIR';

/**
 * Resolve the vault directory.
 *
 * Always `.myco/` in the project root. The vault is a SQLite database
 * that lives with the project — no external overrides needed.
 *
 * Uses git to find the repo root so this works correctly in
 * git worktrees — worktree agents resolve to the same vault
 * as the main working tree. Some symbionts launch their MCP child with
 * cwd=/, so explicit env anchors win before any cwd-based fallback.
 */
export function resolveVaultDir(
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitVaultDir = readAbsoluteEnv(env, MYCO_VAULT_DIR_ENV);
  if (explicitVaultDir) return explicitVaultDir;

  const explicitProjectRoot = readAbsoluteEnv(env, MYCO_PROJECT_ROOT_ENV);
  if (explicitProjectRoot) return path.join(explicitProjectRoot, '.myco');

  return path.join(resolveRepoRoot(cwd), '.myco');
}

function readAbsoluteEnv(
  env: NodeJS.ProcessEnv,
  key: string,
): string | null {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return path.isAbsolute(raw) ? raw : null;
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

import path from 'node:path';
import os from 'node:os';

/**
 * Resolve the vault directory.
 * Priority: MYCO_VAULT_DIR env var > .myco/ in project root.
 *
 * This allows users (especially OSS projects) to keep
 * the Myco vault outside the project repo.
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
  return path.join(cwd, '.myco');
}

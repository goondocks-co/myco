import path from 'node:path';

/**
 * The canonical project_id used throughout Canopy. Every writer (scanner)
 * and reader (inject endpoint, blob replay, aggregation join) must derive
 * the value the same way or rows silently fail to join. The vault's parent
 * directory wins because `vaultDir` already runs through the worktree-aware
 * walk in `resolveVaultDir()`, so it survives weird cwds the daemon may
 * inherit from its launch context.
 */
export function resolveCanopyProjectId(vaultDir: string): string {
  return path.dirname(vaultDir);
}

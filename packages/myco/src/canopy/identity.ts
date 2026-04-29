import { resolveProjectRoot } from '../vault/resolve.js';

/**
 * The canonical project_id used throughout Canopy. Every writer (scanner)
 * and reader (inject endpoint, blob replay, aggregation join) must derive
 * the value the same way or rows silently fail to join.
 *
 * Identical to `resolveProjectRoot(vaultDir)` — Canopy's project_id
 * column is the project root path. Aliased here so canopy call sites
 * read in domain terms ("project_id") while the underlying derivation
 * stays in one place.
 */
export function resolveCanopyProjectId(vaultDir: string): string {
  return resolveProjectRoot(vaultDir);
}

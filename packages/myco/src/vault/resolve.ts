import fs from 'node:fs';
import { resolveProjectRoot } from '../project-root.js';

export {
  UnsafeProjectRootError,
  assertSafeProjectRoot,
  isInsideWorktree,
  isSafeProjectRoot,
  resolveMainRepoRoot,
  resolveProjectRoot,
  resolveVaultDir,
  resolveWorktreeRoot,
} from '../project-root.js';

/**
 * Whether the project's working tree exists on this machine. False for a
 * Team Host serving a member's registered project — the Grove row (and all
 * DB-resident content) is local, but the checkout lives on the member's
 * machine. Callers pass `projectTierOptional: !projectTreeAvailable(vaultDir)`
 * to `loadMergedConfig` so machine+grove tiers still merge (empty project
 * tier) instead of throwing "myco.yaml not found", and skip tree reads/writes.
 * Same signal as `scope-iteration.ts`'s `treeAvailable`.
 */
export function projectTreeAvailable(vaultDir: string): boolean {
  return fs.existsSync(resolveProjectRoot(vaultDir));
}

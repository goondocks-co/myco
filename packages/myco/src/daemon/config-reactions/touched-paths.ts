import { enumerateLeafPaths } from '../../config/leaf-paths.js';

export { enumerateLeafPaths } from '../../config/leaf-paths.js';

/**
 * Compute the union of paths touched by a patch object and a list of
 * explicit clear-key strings, deduplicated. This is the input to
 * `ConfigReactionRegistry.fire()`.
 */
export function computeTouchedPaths(patch: unknown, clear: string[] | undefined): string[] {
  const patchLeaves = patch && typeof patch === 'object' ? enumerateLeafPaths(patch) : [];
  const clearList = Array.isArray(clear) ? clear : [];
  return [...new Set([...patchLeaves, ...clearList])];
}

/**
 * Enumerate leaf paths in a plain-object patch. A "leaf" is any value that
 * isn't a non-array plain object — primitives, arrays, and `null` all count.
 * Used to determine which config paths a patch touches so reactions can
 * decide whether to fire.
 */
export function enumerateLeafPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${key}` : key;
    out.push(...enumerateLeafPaths(value, next));
  }
  return out;
}

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

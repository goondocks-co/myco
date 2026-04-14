export interface DeepMergeOptions {
  /** How to reconcile arrays found at the same key in both target and source. */
  arrayStrategy: 'replace' | 'union';
}

export function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

/**
 * Deep-merge source into target at the leaf.
 *
 * - `arrayStrategy: 'replace'` — arrays in source overwrite arrays in target (config overlay semantics).
 * - `arrayStrategy: 'union'` — arrays are concatenated and deduplicated (symbiont settings merge semantics).
 *
 * Non-object, non-array leaves: source overwrites target.
 * `undefined` values in source are skipped (target value preserved).
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
  options: DeepMergeOptions,
): T {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const existing = result[key];
    if (Array.isArray(value) && Array.isArray(existing)) {
      result[key] = options.arrayStrategy === 'union'
        ? [...new Set([...existing, ...value])]
        : value;
    } else if (isPlainObject(value) && isPlainObject(existing)) {
      result[key] = deepMerge(
        existing,
        value,
        options,
      );
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

import { deepMerge, isPlainObject } from '../utils/deep-merge.js';

/** Symbiont settings merge uses union semantics: arrays are concatenated and deduped. */
export function deepMergeSettings(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return deepMerge(target, source, { arrayStrategy: 'union' });
}

export { isPlainObject };

/**
 * Remove values from target that match the template structure.
 * Arrays: filter out values present in the template array.
 * Objects: delete keys present in the template object, recurse into nested objects.
 * Returns true if anything was removed.
 */
export function deepRemoveSettings(
  target: Record<string, unknown>,
  template: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [key, templateVal] of Object.entries(template)) {
    const targetVal = target[key];
    if (targetVal === undefined) continue;

    if (Array.isArray(templateVal) && Array.isArray(targetVal)) {
      // Filter out values that appear in the template array
      const templateSet = new Set(templateVal.map(String));
      const filtered = targetVal.filter((v) => !templateSet.has(String(v)));
      if (filtered.length !== targetVal.length) {
        if (filtered.length > 0) {
          target[key] = filtered;
        } else {
          delete target[key];
        }
        changed = true;
      }
    } else if (isPlainObject(templateVal) && isPlainObject(targetVal)) {
      // Recurse into nested objects, then prune if empty
      if (deepRemoveSettings(targetVal, templateVal)) {
        if (Object.keys(targetVal).length === 0) {
          delete target[key];
        }
        changed = true;
      }
    } else {
      // Scalar: delete if value matches
      if (String(targetVal) === String(templateVal)) {
        delete target[key];
        changed = true;
      }
    }
  }
  return changed;
}

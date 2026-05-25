import { deepMerge, isPlainObject } from '../utils/deep-merge.js';
import { getAtPath, setAtPath, unsetAtPath } from '../utils/dot-path.js';

/** Symbiont settings merge uses union semantics: arrays are concatenated and deduped. */
export function deepMergeSettings(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return deepMerge(target, source, { arrayStrategy: 'union' });
}

export { isPlainObject };

// =====================================================================
// Audit-tracked merge for JSON settings (parity with TOML audit-track)
//
// The plain `deepMergeSettings` / `deepRemoveSettings` pair is value-
// match: it removes a key on uninstall only if the on-disk value still
// equals the template value. That misses the data-loss case where a
// user-pre-existing value happens to MATCH Myco's template (e.g. user
// already had `features.hooks = true` and Myco's template sets the
// same thing — uninstall would happily strip the user's value).
//
// These auditing variants record only the (path, value) tuples Myco
// actually mutated, so uninstall can remove exactly what Myco wrote
// and nothing else.
// =====================================================================

/**
 * Per-symbiont JSON settings audit. Persists alongside the TOML audit
 * but under a distinct schema version so readers can distinguish the
 * two formats.
 *
 * Paths are stored as segment ARRAYS (not dot-joined strings) because
 * VS Code / Cursor settings legitimately use keys with literal dots
 * in them (`"chat.tools.terminal.autoApprove": { ... }`). Joining
 * segments with a dot would corrupt the path lookup.
 *
 * `scalars` — leaf values Myco wrote at the given path.
 * `arrayEntries` — specific values Myco appended to the array at the
 *   given path. Union-merge semantics: an entry already present
 *   pre-install is NOT recorded here (Myco didn't add it).
 */
export interface JsonSettingsAudit {
  schema: 2;
  format: 'json';
  scalars: Array<{ path: string[]; value: unknown }>;
  arrayEntries: Array<{ path: string[]; values: unknown[] }>;
}

export function emptyJsonAudit(): JsonSettingsAudit {
  return { schema: 2, format: 'json', scalars: [], arrayEntries: [] };
}

/**
 * Like `deepMergeSettings`, but records exactly which leaves Myco
 * actually changed on disk. `audit` is mutated in place; the merged
 * object is returned.
 */
export function deepMergeSettingsWithAudit(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  audit: JsonSettingsAudit,
): Record<string, unknown> {
  return mergeWithAuditAt(target, source, [], audit) as Record<string, unknown>;
}

function mergeWithAuditAt(
  target: unknown,
  source: unknown,
  pathStack: string[],
  audit: JsonSettingsAudit,
): unknown {
  if (Array.isArray(source) && Array.isArray(target)) {
    const existingKeys = new Set(target.map(stableKey));
    const addedValues: unknown[] = [];
    const merged = [...target];
    for (const v of source) {
      if (existingKeys.has(stableKey(v))) continue;
      merged.push(v);
      addedValues.push(v);
    }
    if (addedValues.length > 0) {
      audit.arrayEntries.push({ path: [...pathStack], values: addedValues });
    }
    return merged;
  }
  if (isPlainObject(source) && isPlainObject(target)) {
    const result: Record<string, unknown> = { ...target };
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue;
      const childPath = [...pathStack, key];
      const existing = result[key];
      result[key] = mergeWithAuditAt(existing, value, childPath, audit);
    }
    return result;
  }
  // Scalar leaf, new key, or shape mismatch — record only if the value
  // is actually changing on disk.
  if (source === undefined) return target;
  if (target !== undefined && stableKey(target) === stableKey(source)) {
    return target;
  }
  audit.scalars.push({ path: [...pathStack], value: source });
  return source;
}

/**
 * Strip every leaf the audit claims, IFF the on-disk value still
 * matches what Myco recorded. Returns true when anything was removed.
 * Mutates `target` in place. Prunes parent objects that become empty.
 */
export function removeAuditedSettings(
  target: Record<string, unknown>,
  audit: JsonSettingsAudit,
): boolean {
  let changed = false;
  for (const entry of audit.scalars) {
    const current = getAtPath(target, entry.path);
    if (current === undefined) continue;
    if (stableKey(current) !== stableKey(entry.value)) continue;
    if (unsetAtPath(target, entry.path, { pruneEmptyParents: true })) {
      changed = true;
    }
  }
  for (const entry of audit.arrayEntries) {
    const current = getAtPath(target, entry.path);
    if (!Array.isArray(current)) continue;
    const drop = new Set(entry.values.map(stableKey));
    const remaining = current.filter((v) => !drop.has(stableKey(v)));
    if (remaining.length === current.length) continue;
    if (remaining.length === 0) {
      if (unsetAtPath(target, entry.path, { pruneEmptyParents: true })) {
        changed = true;
      }
    } else {
      setAtPath(target, entry.path, remaining);
      changed = true;
    }
  }
  return changed;
}

/**
 * Stable comparison key for primitives and shallow structures. JSON
 * canonicalization keeps audit comparisons deterministic across
 * Node-version object-iteration order quirks.
 */
function stableKey(v: unknown): string {
  return JSON.stringify(v ?? null);
}

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

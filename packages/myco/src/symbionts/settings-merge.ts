import { isPlainObject } from '../utils/deep-merge.js';
import { getAtPath, setAtPath, unsetAtPath } from '../utils/dot-path.js';

export { isPlainObject };

/** File existence and empty-file formatting retained across installation. */
export interface SettingsFileAudit {
  existed: boolean;
  emptyText?: string;
  trailingWhitespace?: string;
}

export interface JsonSettingsAudit {
  schema: 2;
  format: 'json';
  scalars: Array<{ path: string[]; value: unknown; previous?: { value: unknown } }>;
  arrayEntries: Array<{ path: string[]; values: unknown[]; previous?: { value: unknown[] } }>;
  file?: SettingsFileAudit;
}

export function emptyJsonAudit(): JsonSettingsAudit {
  return { schema: 2, format: 'json', scalars: [], arrayEntries: [] };
}

/**
 * Records exactly which leaves Myco
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
      audit.arrayEntries.push({ path: [...pathStack], values: addedValues, previous: { value: target } });
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
  audit.scalars.push({ path: [...pathStack], value: source, ...(target === undefined ? {} : { previous: { value: target } }) });
  return source;
}

/**
 * Strip every leaf the audit claims, IFF the on-disk value still
 * matches what Myco recorded. Returns true when anything was deleted.
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
    if (entry.previous) {
      setAtPath(target, entry.path, entry.previous.value);
      changed = true;
    } else if (unsetAtPath(target, entry.path, { pruneEmptyParents: true })) {
      changed = true;
    }
  }
  for (const entry of audit.arrayEntries) {
    const current = getAtPath(target, entry.path);
    if (!Array.isArray(current)) continue;
    const drop = new Set(entry.values.map(stableKey));
    const remaining = current.filter((v) => !drop.has(stableKey(v)));
    if (remaining.length === current.length) continue;
    if (remaining.length === 0 && entry.previous) {
      setAtPath(target, entry.path, remaining);
      changed = true;
    } else if (remaining.length === 0) {
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

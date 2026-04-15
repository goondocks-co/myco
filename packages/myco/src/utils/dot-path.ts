/**
 * Shared dotted-path navigation helpers for objects that represent configs,
 * hook inputs, or settings. All functions accept a path like `'appearance.theme'`
 * or `'tool_info.command_line'`.
 */

/** Walk a dot-separated path and return the value, or `undefined` if any segment is missing. */
export function getAtPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a value at a dot-separated path, creating intermediate objects as needed.
 * Mutates the input object. Callers that need immutability should clone first.
 */
export function setAtPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  const leaf = parts[parts.length - 1];
  if (leaf === undefined) return;
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const segment = parts[i];
    if (segment === undefined) return;
    const existing = current[segment];
    if (existing === undefined || existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[leaf] = value;
}

/**
 * Delete the leaf at a dot-separated path. Returns `true` if the leaf existed and was removed.
 * Intermediate missing segments are a no-op and return `false`.
 */
export function unsetAtPath(obj: Record<string, unknown>, dotPath: string): boolean {
  const parts = dotPath.split('.');
  const leaf = parts[parts.length - 1];
  if (leaf === undefined) return false;
  let cursor: Record<string, unknown> | undefined = obj;
  for (let i = 0; i < parts.length - 1 && cursor; i += 1) {
    const segment = parts[i];
    if (segment === undefined) { cursor = undefined; break; }
    const next: unknown = cursor[segment];
    cursor = (next !== null && typeof next === 'object' && !Array.isArray(next))
      ? next as Record<string, unknown>
      : undefined;
  }
  if (!cursor) return false;
  if (!(leaf in cursor)) return false;
  delete cursor[leaf];
  return true;
}

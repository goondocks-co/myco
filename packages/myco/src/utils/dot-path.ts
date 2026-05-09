/**
 * Shared dotted-path navigation helpers for objects that represent configs,
 * hook inputs, or settings. Paths may be a dot-string (`'appearance.theme'`,
 * with bracketed numeric indices `foo[0].bar`) or pre-split segment array
 * (`['daemon', 'port']`). The segment-array form skips parsing and is
 * preferred when call-sites already have segments in hand (loader, etc).
 */

export type DotPath = string | readonly string[];

function toSegments(path: DotPath): string[] {
  if (Array.isArray(path)) return path as string[];
  if (!path) return [];
  return (path as string)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((s) => s.length > 0);
}

/**
 * Walk a path and return the value, or `undefined` if any segment is missing.
 * Numeric segments traverse arrays; non-numeric segments on an array yield
 * `undefined`.
 */
export function getAtPath(obj: unknown, path: DotPath): unknown {
  const segments = toSegments(path);
  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Set a value at a path, creating intermediate objects as needed. Mutates
 * the input. Callers needing immutability should clone first.
 */
export function setAtPath(obj: Record<string, unknown>, path: DotPath, value: unknown): void {
  const segments = toSegments(path);
  if (segments.length === 0) return;
  let cursor = obj;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    const existing = cursor[seg];
    if (existing === undefined || existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/**
 * Delete the leaf at a path. Returns `true` if the leaf existed and was
 * removed. Pass `pruneEmptyParents: true` to also walk up the parent chain
 * removing now-empty objects (used by config writers to keep YAML clean).
 */
export function unsetAtPath(
  obj: Record<string, unknown>,
  path: DotPath,
  options: { pruneEmptyParents?: boolean } = {},
): boolean {
  const segments = toSegments(path);
  if (segments.length === 0) return false;
  let cursor: Record<string, unknown> | undefined = obj;
  for (let i = 0; i < segments.length - 1 && cursor; i += 1) {
    const next: unknown = cursor[segments[i]!];
    cursor = (next !== null && typeof next === 'object' && !Array.isArray(next))
      ? next as Record<string, unknown>
      : undefined;
  }
  if (!cursor) return false;
  const leaf = segments[segments.length - 1]!;
  if (!(leaf in cursor)) return false;
  delete cursor[leaf];
  if (options.pruneEmptyParents) {
    for (let i = segments.length - 2; i >= 0; i -= 1) {
      const parentSegments = segments.slice(0, i + 1);
      const parent = getAtPath(obj, parentSegments) as Record<string, unknown> | undefined;
      if (!parent || Object.keys(parent).length > 0) break;
      unsetAtPath(obj, parentSegments);
    }
  }
  return true;
}

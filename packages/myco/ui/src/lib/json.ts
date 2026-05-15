/**
 * Pure JSON-parsing helper for the UI bundle. Browser-safe — no Node
 * imports — so `vite dev` can resolve it without falling back to the
 * Node-only `@myco/utils/json` re-export (which transitively pulls in
 * `fs` via `@goondocks/myco-shared`).
 *
 * See issue #294 and the follow-up issue for the broader UI/daemon
 * boundary work; this fix targets just the one cross-boundary import
 * that breaks `vite dev` today.
 */

export function tryParseJson<T>(raw: unknown, validator: (value: unknown) => value is T): T | null;
export function tryParseJson(raw: unknown): unknown;
export function tryParseJson<T>(raw: unknown, validator?: (value: unknown) => value is T): T | unknown | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!validator) return parsed;
  return validator(parsed) ? parsed : null;
}

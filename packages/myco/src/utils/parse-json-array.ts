/**
 * Tolerant JSON-array helper used by canopy code paths and the canopy UI.
 *
 * The canopy_entries table stores `exports_json` and `imports_json` as
 * JSON-encoded string arrays. Rows can be NULL, can be the empty string,
 * and (in practice — corrupted writes or pre-migration data) can hold
 * non-array JSON. Every consumer wants the same "give me an array of
 * strings, or empty" behaviour, so the parsing logic lives here.
 */

export function parseJsonStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

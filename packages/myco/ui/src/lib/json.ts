/**
 * Browser-safe JSON parsing helper. Returns null for empty/non-string
 * inputs and for malformed JSON; with an optional validator, returns
 * the validated `T` on match or null otherwise.
 */

export function tryParseJson<T>(
  raw: string | null | undefined,
  validator: (value: unknown) => value is T,
): T | null;
export function tryParseJson(raw: string | null | undefined): unknown;
export function tryParseJson<T>(
  raw: string | null | undefined,
  validator?: (value: unknown) => value is T,
): T | unknown | null {
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

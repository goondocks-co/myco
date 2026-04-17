/**
 * Tolerant JSON helpers shared across modules that parse stored JSON
 * columns (usage_data, checkpoints, execution_overrides, write-intent
 * tool_input/synthetic_output, ...).
 *
 * The common contract: corrupt / non-string / empty inputs degrade to
 * `null` rather than throwing, so a single poison row cannot take down
 * list endpoints or audit views.
 */

/**
 * Parse a JSON string tolerantly. Returns `null` for non-strings, empty
 * strings, or any `JSON.parse` failure.
 */
export function tryParseJson<T = unknown>(raw: unknown): T | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

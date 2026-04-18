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
 * strings, or any `JSON.parse` failure. Callers that pass a validator get
 * the narrowed type; callers that omit a validator receive `unknown` and
 * must narrow at the call site.
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

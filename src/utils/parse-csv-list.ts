/**
 * Parse a comma-separated query-string value into a trimmed,
 * non-empty list of tokens. Used by REST handlers that accept
 * `?field=a,b,c` style multi-value parameters.
 *
 * Returns an empty array when the input is undefined, empty, or
 * contains only whitespace — callers can treat an empty result as
 * "no filter" without a branch.
 */
export function parseCsvList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

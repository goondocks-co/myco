/**
 * The wire shape of a tool result.
 *
 * The member-side tools answer rows with snake_case field names, the vault's
 * own column names, and every skill and agent that reads them keys on those.
 * The server's read layer answers camelCase records. This is the one place the
 * two meet: a record from the read layer goes out under the names the tools
 * have always used.
 */

const snakeOf = (key: string): string => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** A plain record with every key in snake_case, recursing into nested records and the records of arrays; values are untouched. */
export function snake<T = Record<string, unknown>>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => snake(v)) as unknown as T;
  if (value === null || typeof value !== 'object') return value as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[snakeOf(k)] = snake(v);
  return out as T;
}

export const MAX_BIND_SLOTS = 100;
export const MAX_SQL_BYTES = 100_000;
export const MAX_LIKE_BYTES = 50;

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** SQLite allocates anonymous parameters after the highest slot already encountered. */
export function bindSlots(sql: string): number {
  const tokens = /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\?(\d*)|[:@$][A-Za-z_][A-Za-z_0-9]*/g;
  let slots = 0;
  for (const token of sql.matchAll(tokens)) {
    if (token[1] !== undefined) {
      const slot = token[1] === '' ? slots + 1 : Number(token[1]);
      if (!Number.isSafeInteger(slot) || slot < 1) throw new Error('bind slots must be positive safe integers');
      slots = Math.max(slots, slot);
    } else if (/^[:@$]/.test(token[0])) {
      throw new Error('statements use positional ? or ?N bind slots');
    }
  }
  return slots;
}

export function checkStatement(sql: string): number {
  const size = bytes(sql);
  if (size > MAX_SQL_BYTES) throw new Error(`statement has ${size} UTF-8 bytes; maximum is ${MAX_SQL_BYTES}`);
  const slots = bindSlots(sql);
  if (slots > MAX_BIND_SLOTS) throw new Error(`statement uses slot ${slots}; maximum is ${MAX_BIND_SLOTS}`);
  return slots;
}

/** Receives the final escaped, wildcard-wrapped pattern, never the search text. */
export function checkLikePattern(value: unknown, slot: number): void {
  if (typeof value !== 'string') throw new Error(`LIKE slot ${slot} requires a string pattern`);
  const size = bytes(value);
  if (size > MAX_LIKE_BYTES) throw new Error(`LIKE slot ${slot} has ${size} UTF-8 bytes; maximum is ${MAX_LIKE_BYTES}; bind a shorter escaped pattern`);
}

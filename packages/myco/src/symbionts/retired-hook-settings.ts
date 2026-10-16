import { isMap, isScalar, parseDocument } from 'yaml';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

export interface RetiredSettingsConflict { key: string; hash: string }

export class RetiredHookSettingsParseError extends Error { }

function hasRetiredRootKey(raw: string, keys: string[]): boolean {
  let depth = 0;
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)) {
    const token = match[0];
    if (token === '{' || token === '[') depth++;
    else if (token === '}' || token === ']') depth--;
    else if (depth === 1 && /^\s*:/.test(raw.slice(match.index + token.length))) {
      const decoded = token.slice(1, -1).replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      if (keys.some(key => decoded === key || token === JSON.stringify(key))) return true;
    }
  }
  return false;
}

/** Hash JSON values with object keys in sorted order. */
function valueHash(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)])) : item;
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

/** Remove exact root values, retaining bytes outside removed entries, separators and complete entry lines. */
export function retiredHookSettings(raw: string, retired: Record<string, unknown>): { text: string; conflicts: RetiredSettingsConflict[] } {
  const keys = Object.keys(retired);
  if (!hasRetiredRootKey(raw, keys)) return { text: raw, conflicts: [] };
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw) as Record<string, unknown>; }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new RetiredHookSettingsParseError(error.message, { cause: error });
  }
  const document = parseDocument(raw);
  if (document.errors.length > 0) throw new RetiredHookSettingsParseError(document.errors[0].message, { cause: document.errors[0] });
  if (!isMap(document.contents)) throw new RetiredHookSettingsParseError('Hooks file must be a JSON object');
  const pairs = document.contents.items.map(pair => {
    if (!isScalar(pair.key) || !pair.key.range || !pair.value?.range) throw new RetiredHookSettingsParseError('Cannot locate hooks entry');
    return { key: String(pair.key.value), start: pair.key.range[0], end: pair.value.range[1] };
  });
  const conflicts: RetiredSettingsConflict[] = [];
  const removed = new Set<number>();
  for (const [key, value] of Object.entries(retired)) {
    if (!Object.hasOwn(data, key)) continue;
    if (!isDeepStrictEqual(data[key], value)) { conflicts.push({ key, hash: valueHash(data[key]) }); continue; }
    removed.add(pairs.findIndex(pair => pair.key === key));
  }
  const cuts: Array<[number, number]> = [];
  for (let index = 0; index < pairs.length; index++) {
    if (!removed.has(index)) continue;
    let last = index;
    while (removed.has(last + 1)) last++;
    let start = pairs[index].start;
    let end = pairs[last].end;
    if (last < pairs.length - 1) end = raw.indexOf(',', end) + 1;
    else if (index > 0) {
      const comma = raw.indexOf(',', pairs[index - 1].end);
      cuts.push([comma, comma + 1]);
    }
    const lineStart = raw.lastIndexOf('\n', start - 1) + 1;
    const newline = raw.indexOf('\n', end);
    if (/^[\t ]*$/.test(raw.slice(lineStart, start)) && newline >= 0 && /^[\t \r]*$/.test(raw.slice(end, newline))) {
      start = lineStart;
      end = newline + 1;
    }
    cuts.push([start, end]);
    index = last;
  }
  let text = raw;
  for (const [start, end] of cuts.sort(([a], [b]) => b - a)) text = text.slice(0, start) + text.slice(end);
  JSON.parse(text);
  return { text, conflicts };
}

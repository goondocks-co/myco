import { isMap, isScalar, parseDocument } from 'yaml';
import { isDeepStrictEqual } from 'node:util';

/** Remove exact root values, retaining every byte outside their entries and comma separators. */
export function retiredHookSettings(raw: string, retired: Record<string, unknown>): { text: string; conflicts: string[] } {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const document = parseDocument(raw);
  if (document.errors.length > 0) throw document.errors[0];
  if (!isMap(document.contents)) throw new Error('Hooks file must be a JSON object');
  const pairs = document.contents.items;
  const cuts: Array<[number, number]> = [];
  const conflicts: string[] = [];
  for (const [key, value] of Object.entries(retired)) {
    if (!Object.hasOwn(data, key)) continue;
    if (!isDeepStrictEqual(data[key], value)) { conflicts.push(key); continue; }
    const index = pairs.findIndex(pair => isScalar(pair.key) && pair.key.value === key);
    const pair = pairs[index];
    if (!isScalar(pair?.key) || !pair.key.range || !pair.value?.range) throw new Error(`Cannot locate hooks setting ${key}`);
    const start = pair.key.range[0];
    const end = pair.value.range[1];
    cuts.push([start, end]);
    if (index < pairs.length - 1) {
      const comma = raw.indexOf(',', end);
      cuts.push([comma, comma + 1]);
    } else if (index > 0) {
      const comma = raw.lastIndexOf(',', start);
      cuts.push([comma, comma + 1]);
    }
  }
  const removed = new Set<number>();
  for (const [start, end] of cuts) for (let i = start; i < end; i++) removed.add(i);
  const text = raw.split('').filter((_, index) => !removed.has(index)).join('');
  JSON.parse(text);
  return { text, conflicts };
}

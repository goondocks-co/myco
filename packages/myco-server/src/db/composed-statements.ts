/**
 * Statements whose SQL is composed from fragments other modules own (a stage's due predicate, a restored row's columns).
 * Each distinct text is one statement, defined the first time it is asked for and named by its family and a digest of
 * the text, so the same composition always runs under the same name.
 */
import type { BindValue, Statement } from './index.js';

/** FNV-1a over the UTF-8 text, 64 bits in base 36: short enough for a statement name, wide enough that distinct texts do not meet. */
export function textDigest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(36);
}

/** One definition per composed text of `family`; `define` receives the name and the text it was asked for. */
export function composedStatements<Row, Kind extends 'read' | 'write'>(family: string): (
  text: string, define: (name: string) => Statement<BindValue[], Row, Kind>,
) => Statement<BindValue[], Row, Kind> {
  const held = new Map<string, Statement<BindValue[], Row, Kind>>();
  return (text, define) => {
    const known = held.get(text);
    if (known !== undefined) return known;
    const made = define(`${family}K${textDigest(text)}`);
    held.set(text, made);
    return made;
  };
}

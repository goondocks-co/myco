/** An own registry entry; inherited properties are not declarations. */
export function declared<T>(table: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

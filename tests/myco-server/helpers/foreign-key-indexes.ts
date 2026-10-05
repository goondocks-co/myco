import type { Database } from 'bun:sqlite';

const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function foreignKeyChildren(sqlite: Database, table: string): string[][] {
  const keys = sqlite.query(`PRAGMA foreign_key_list(${quoted(table)})`).all() as { id: number; seq: number; from: string }[];
  return [...new Set(keys.map(key => key.id))].map(id => keys.filter(key => key.id === id)
    .sort((a, b) => a.seq - b.seq).map(key => key.from));
}

export function indexFields(sqlite: Database, index: string): string[] {
  return (sqlite.query(`PRAGMA index_info(${quoted(index)})`).all() as { name: string }[]).map(column => column.name);
}

export function leadsWith(fields: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((field, offset) => fields[offset] === field);
}

export function isForeignKeyChildIndex(sqlite: Database, table: string, index: string): boolean {
  return foreignKeyChildren(sqlite, table).some(child => leadsWith(indexFields(sqlite, index), child));
}

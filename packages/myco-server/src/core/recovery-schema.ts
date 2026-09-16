/**
 * The schema facts recovery reads from a Deployment: which objects it holds, which of them an ordinary-table export
 * carries, and which virtual tables can be rebuilt. One owner for both targets; the reader that parses a captured
 * schema keeps its own validation.
 */
import type { RelationalStore } from './adapters.js';

export interface RecoverySchemaObject {
  type: 'table' | 'index' | 'view' | 'trigger';
  name: string;
  sql: string;
  storage: 'table' | 'virtual' | 'view' | null;
}

export const SCHEMA_QUERY = `SELECT m.type, m.name, m.sql, t.type AS storage FROM sqlite_master m
  LEFT JOIN pragma_table_list t ON t.schema = 'main' AND t.name = m.name
  WHERE m.sql IS NOT NULL AND m.name NOT GLOB 'sqlite_*' AND m.name NOT GLOB '_cf_*'
    AND m.name NOT GLOB 'd1_*' AND COALESCE(t.type, '') != 'shadow'
  ORDER BY m.type, m.name`;

/** The schema objects a Deployment holds, as one read of its own catalogue. This module issues that read. */
export async function captureSchema(db: RelationalStore): Promise<RecoverySchemaObject[]> {
  const { results } = await db.prepare(SCHEMA_QUERY).all<RecoverySchemaObject>();
  return results.map((row) => ({ type: row.type, name: row.name, sql: row.sql, storage: row.storage }));
}

export const quoteIdentifier = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

/** The virtual tables a recovery can rebuild, or a refusal naming the one it cannot. */
export function recoverableVirtualTables(schema: readonly RecoverySchemaObject[]): RecoverySchemaObject[] {
  const virtual = schema.filter((row) => row.storage === 'virtual');
  for (const row of virtual) {
    if (!/\bUSING\s+fts5\s*\(/i.test(row.sql) || !/\bcontent\s*=\s*'[^']+'/i.test(row.sql)) {
      throw new Error(`recovery cannot reconstruct virtual table ${row.name}`);
    }
  }
  return virtual;
}

/** The ordinary tables an export of `schema` must carry, with `sqlite_sequence` where a table declares AUTOINCREMENT. */
export function exportedTables(schema: readonly RecoverySchemaObject[]): string[] {
  const tables = schema.filter((row) => row.storage === 'table').map((row) => row.name);
  if (schema.some((row) => row.storage === 'table' && /\bAUTOINCREMENT\b/i.test(row.sql))) tables.push('sqlite_sequence');
  return tables;
}

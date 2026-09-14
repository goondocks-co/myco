import { z } from 'zod';

const schemaObject = z.object({
  type: z.enum(['table', 'index', 'view', 'trigger']), name: z.string().min(1), sql: z.string().min(1),
  storage: z.enum(['table', 'virtual', 'view']).nullable(),
});
export const schemaObjects = z.array(schemaObject);
export const SCHEMA_QUERY = `SELECT m.type, m.name, m.sql, t.type AS storage FROM sqlite_master m
  LEFT JOIN pragma_table_list t ON t.schema = 'main' AND t.name = m.name
  WHERE m.sql IS NOT NULL AND m.name NOT GLOB 'sqlite_*' AND m.name NOT GLOB '_cf_*'
    AND m.name NOT GLOB 'd1_*' AND COALESCE(t.type, '') != 'shadow'
  ORDER BY m.type, m.name`;
export const quoteIdentifier = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

export function recoverableVirtualTables(schema: ReturnType<typeof schemaObjects.parse>) {
  const virtual = schema.filter((row) => row.storage === 'virtual');
  for (const row of virtual) {
    if (!/\bUSING\s+fts5\s*\(/i.test(row.sql) || !/\bcontent\s*=\s*'[^']+'/i.test(row.sql)) {
      throw new Error(`recovery cannot reconstruct virtual table ${row.name}`);
    }
  }
  return virtual;
}

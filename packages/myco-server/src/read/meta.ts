import type { RelationalStore } from '../core/adapters.js';

/** The schema version the bound database carries, or null when it carries none. */
export async function schemaVersion(db: RelationalStore): Promise<number | null> {
  const row = await db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>();
  return row === null ? null : Number(row.value);
}

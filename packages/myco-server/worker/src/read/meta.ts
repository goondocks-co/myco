import type { D1Like } from '../env.js';

/** The schema version the bound database carries, or null when it carries none. */
export async function schemaVersion(db: D1Like): Promise<number | null> {
  const row = await db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>();
  return row === null ? null : Number(row.value);
}

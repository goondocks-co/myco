import type { RelationalStore } from '../core/adapters.js';
import { VIEW_READ_REFUSAL_KEY } from '../core/attention-state.js';

export interface StatusMetadata { version: number | null; viewReadRefusal: string | null }

/** Schema health and the optional bounded refusal record, each by its exact key. */
export async function statusMetadata(db: RelationalStore): Promise<StatusMetadata> {
  const row = await db.prepare(`SELECT value,
    (SELECT value FROM schema_meta WHERE key = '${VIEW_READ_REFUSAL_KEY}') AS __myco_status_refusal
    FROM schema_meta WHERE key = 'version'`)
    .first<{ value: string; __myco_status_refusal: string | null }>();
  return { version: row === null ? null : Number(row.value), viewReadRefusal: row?.__myco_status_refusal ?? null };
}

/** The schema version the bound database carries, or null when it carries none. */
export async function schemaVersion(db: RelationalStore): Promise<number | null> {
  const row = await db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>();
  return row === null ? null : Number(row.value);
}

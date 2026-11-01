import type { RelationalStore } from '../core/adapters.js';
import { DOCUMENT_PUBLISH_FAILURE_KEY } from '../core/attention-state.js';

export interface StatusMetadata { version: number | null; documentPublishFailure: string | null }

/** Schema health and the optional bounded refusal and publish failure records, each by its exact key. */
export async function statusMetadata(db: RelationalStore): Promise<StatusMetadata> {
  const row = await db.prepare(`SELECT value,
    (SELECT value FROM schema_meta WHERE key = '${DOCUMENT_PUBLISH_FAILURE_KEY}') AS __myco_status_publish_failure
    FROM schema_meta WHERE key = 'version'`)
    .first<{ value: string; __myco_status_publish_failure: string | null }>();
  return {
    version: row === null ? null : Number(row.value),
    documentPublishFailure: row?.__myco_status_publish_failure ?? null,
  };
}

/** The schema version the bound database carries, or null when it carries none. */
export async function schemaVersion(db: RelationalStore): Promise<number | null> {
  const row = await db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>();
  return row === null ? null : Number(row.value);
}

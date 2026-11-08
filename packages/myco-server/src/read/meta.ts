import type { ErrorClassifier, RelationalStore } from '../core/adapters.js';
export { statusMetadata, type StatusMetadata } from '../db/documents/failure-head.js';
import { within } from '../core/recovery-inventory.js';
import { readFailureTelemetry, StorageContractError } from '../telemetry.js';

const DATABASE_READ_MS = 5_000;

/** Query availability is measured independently of the projections that use the database. */
export async function databaseReadStatus(db: RelationalStore, classifier?: ErrorClassifier) {
  try {
    const row = await within(() => db.prepare('SELECT 1 AS readable').first<{ readable: number }>(), DATABASE_READ_MS, Date.now);
    if (row?.readable !== 1) throw new StorageContractError('the read check returned no result');
    return { readable: true as const };
  } catch (error) {
    return { readable: false as const, ...readFailureTelemetry(error, classifier) };
  }
}

/** The schema version the bound database carries, or null when it carries none. */
export async function schemaVersion(db: RelationalStore): Promise<number | null> {
  const row = await db.prepare(`SELECT value FROM schema_meta WHERE key = 'version'`).first<{ value: string }>();
  return row === null ? null : Number(row.value);
}

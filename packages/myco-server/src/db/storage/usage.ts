import type { RelationalStore } from '../../core/adapters.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { assertion, read, readSet, write } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';

/**
 * Registered logical bytes and blob count, per Project and for the Deployment (`project_id=''`), maintained by the
 * statement that registers or removes a `blobs` row. A `blobs` row is one logical registration, so a duplicate upload
 * moves nothing; these are logical bytes, not what the store bills.
 *
 * Existing rows are counted once by a keyset build through `projection_catchup`. A row is counted exactly when
 * `countedKey` holds: the build has finished, or its key is at or before the committed cursor, or past the frontier the
 * build will stop at. A trigger moves a counter only for a counted key; a build page adds the keys it moves the cursor
 * past, in one commit with the cursor.
 */
export const STORAGE_USAGE_PROJECTION = 'storage_usage';
export const STORAGE_USAGE_PHASE = 'blobUsage';
export const STORAGE_USAGE_PAGE = 500;
export const DEPLOYMENT_USAGE_KEY = '';

const tuple = (json: string) => `COALESCE(json_extract(${json},'$[0]'),''),COALESCE(json_extract(${json},'$[1]'),'')`;
const buildRow = (alias = '') => `${alias}projection='${STORAGE_USAGE_PROJECTION}' AND ${alias}phase='${STORAGE_USAGE_PHASE}'`;

const countedKey = (row: 'NEW' | 'OLD') => `EXISTS(SELECT 1 FROM projection_catchup c WHERE ${buildRow('c.')}
  AND (c.done=1 OR (c.frontier IS NOT NULL AND ((${row}.project_id,${row}.key)<=(${tuple('c.after_key')}) OR (${row}.project_id,${row}.key)>(${tuple('c.frontier')})))))`;

/** The derived table, its triggers and the build's seed, as one schema step freezes them. */
export function storageUsageSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS storage_usage(project_id TEXT PRIMARY KEY CHECK (project_id='' OR (${PROJECT_ID_GRAMMAR})),
      blobs INTEGER NOT NULL DEFAULT 0,registered_logical_bytes INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`,
    `CREATE TRIGGER IF NOT EXISTS storage_usage_blob_insert AFTER INSERT ON blobs WHEN ${countedKey('NEW')}
      BEGIN INSERT INTO storage_usage(project_id,blobs,registered_logical_bytes) VALUES(NEW.project_id,1,NEW.size),('',1,NEW.size)
        ON CONFLICT(project_id) DO UPDATE SET blobs=blobs+1,registered_logical_bytes=registered_logical_bytes+excluded.registered_logical_bytes; END`,
    `CREATE TRIGGER IF NOT EXISTS storage_usage_blob_delete AFTER DELETE ON blobs WHEN ${countedKey('OLD')}
      BEGIN UPDATE storage_usage SET blobs=blobs-1,registered_logical_bytes=registered_logical_bytes-OLD.size WHERE project_id IN (OLD.project_id,''); END`,
    `CREATE TRIGGER IF NOT EXISTS storage_usage_blob_size AFTER UPDATE OF size ON blobs WHEN OLD.size IS NOT NEW.size AND ${countedKey('NEW')}
      BEGIN UPDATE storage_usage SET registered_logical_bytes=registered_logical_bytes-OLD.size+NEW.size WHERE project_id IN (NEW.project_id,''); END`,
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${STORAGE_USAGE_PROJECTION}','${STORAGE_USAGE_PHASE}',NOT EXISTS(SELECT 1 FROM blobs) ON CONFLICT DO NOTHING`,
  ];
}

const STORAGE_USAGE_SOURCE = { table: 'blobs', columns: ['project_id', 'key'], pageSize: STORAGE_USAGE_PAGE };

const BUILD_STATE = `(SELECT after_key,frontier FROM projection_catchup WHERE ${buildRow()})`;
/** The keys this page moves the cursor past. The page closes at the frontier when it is the last, so a key registered inside the remaining range during the page is counted here. */
const PAGE_ROWS = `FROM blobs b,${BUILD_STATE} s
  WHERE s.frontier IS NOT NULL AND (b.project_id,b.key)>(${tuple('s.after_key')})
    AND (b.project_id,b.key)<=(${tuple(`CASE WHEN json_array_length(?1)<${STORAGE_USAGE_PAGE} THEN s.frontier ELSE json_extract(?1,'$[#-1]') END`)})`;

const STORAGE_USAGE_RECONCILE = [
  write<[keys: string]>({ name: 'storageUsage.pageProjects', sql: `INSERT INTO storage_usage(project_id,blobs,registered_logical_bytes)
    SELECT b.project_id,COUNT(*),SUM(b.size) ${PAGE_ROWS} GROUP BY b.project_id
    ON CONFLICT(project_id) DO UPDATE SET blobs=blobs+excluded.blobs,registered_logical_bytes=registered_logical_bytes+excluded.registered_logical_bytes` }),
  write<[keys: string]>({ name: 'storageUsage.pageDeployment', sql: `INSERT INTO storage_usage(project_id,blobs,registered_logical_bytes)
    SELECT '${DEPLOYMENT_USAGE_KEY}',COUNT(*),SUM(b.size) ${PAGE_ROWS} HAVING COUNT(*)>0
    ON CONFLICT(project_id) DO UPDATE SET blobs=blobs+excluded.blobs,registered_logical_bytes=registered_logical_bytes+excluded.registered_logical_bytes` }),
];

/** A page counts only the cursor it read: a concurrent or restarted build aborts the batch before it counts a key twice. */
const storageUsageCursorHeld = assertion<[after: string, generation: number]>({ name: 'storageUsage.cursorHeld', sql:
  `SELECT CASE WHEN EXISTS(SELECT 1 FROM projection_catchup WHERE ${buildRow()} AND after_key=?1 AND generation=?2 AND done=0) THEN 1 ELSE json_extract('[]','$[storage_usage_cursor_moved]') END` });

export const clearStorageUsage = write<[]>({ name: 'storageUsage.clear', sql: 'DELETE FROM storage_usage' });
/** A restarted build recounts every key, so counters a copy brought with it cannot survive the restart. */
export const STORAGE_USAGE_CATCHUP = {
  projection: STORAGE_USAGE_PROJECTION,
  reset: () => [clearStorageUsage.bind()],
  phases: { [STORAGE_USAGE_PHASE]: { source: STORAGE_USAGE_SOURCE, reconcile: STORAGE_USAGE_RECONCILE, guards: held => [storageUsageCursorHeld.bind(held.after_key, held.generation)] } },
} as const satisfies CatchupFamily;
/** Restarts the build over a copy whose counters may not describe its rows; the caller commits it with `clearStorageUsage`. */
export const restartStorageUsage = write<[]>({ name: 'storageUsage.restart', sql:
  `UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+1 WHERE ${buildRow()}` });

export type StorageUsage = { state: 'ready'; blobs: number; registeredLogicalBytes: number } | { state: 'building' };

const deploymentUsage = read<[], { done: number; blobs: number | null; bytes: number | null }>({ name: 'storageUsage.deployment', sql:
  `SELECT c.done,u.blobs,u.registered_logical_bytes AS bytes FROM projection_catchup c
    LEFT JOIN storage_usage u ON u.project_id='${DEPLOYMENT_USAGE_KEY}' WHERE ${buildRow('c.')}` });

/** Registered bytes and blobs across the Deployment; `building` until every existing row has been counted. */
export async function readDeploymentStorageUsage(db: RelationalStore): Promise<StorageUsage> {
  const [[row]] = await readSet(db, deploymentUsage.bind());
  if (row === undefined || row.done !== 1) return { state: 'building' };
  return { state: 'ready', blobs: row.blobs ?? 0, registeredLogicalBytes: row.bytes ?? 0 };
}

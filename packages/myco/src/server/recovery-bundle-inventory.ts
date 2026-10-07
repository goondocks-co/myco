import type { Database } from 'bun:sqlite';
import { ARCHIVE_BUNDLE_ENTRIES, type BundleEntryIdentity } from '@myco-server-worker/core/archive-bundle.js';

export const RECOVERY_LOCATOR_PAGE_ROWS = 256;
const INVENTORY_TABLE = 'recovery_bundle_locator_inventory';
const SOURCES = [
  { table: 'events', id: 'event_id', bundle: 'bundle_id', entry: 'bundle_entry', kind: 'event',
    facts: 'event_id,envelope_hash' },
  { table: 'tool_calls', id: 'tool_call_id', bundle: 'input_bundle_id', entry: 'input_bundle_entry', kind: 'tool-input',
    facts: 'NULL AS event_id,NULL AS envelope_hash' },
] as const;
type LocatorRow = { project_id: string; resource_id: string; bundle_id: number | null; bundle_entry: number | null;
  event_id: string | null; envelope_hash: string | null; token_id: string };

/** A private temporary index built by one bounded tuple pass over each source table. */
export function recoveryBundleInventory(db: Database) {
  db.exec(`CREATE TEMP TABLE ${INVENTORY_TABLE} (
    project_id TEXT NOT NULL,bundle_id INTEGER NOT NULL,kind TEXT NOT NULL,resource_id TEXT NOT NULL,
    entry INTEGER NOT NULL,event_id TEXT,envelope_hash TEXT,token_id TEXT NOT NULL,
    PRIMARY KEY(project_id,bundle_id,kind,resource_id)) WITHOUT ROWID`);
  const drop = () => db.exec(`DROP TABLE temp.${INVENTORY_TABLE}`);
  try {
    const insert = db.prepare(`INSERT INTO temp.${INVENTORY_TABLE}
      (project_id,bundle_id,kind,resource_id,entry,event_id,envelope_hash,token_id) VALUES(?,?,?,?,?,?,?,?)`);
    try {
      db.transaction(() => {
        for (const source of SOURCES) {
          const page = db.prepare<LocatorRow, [string, string, number]>(`SELECT project_id,${source.id} AS resource_id,
            ${source.bundle} AS bundle_id,${source.entry} AS bundle_entry,${source.facts},token_id
            FROM ${source.table} WHERE (project_id,${source.id})>(?,?) ORDER BY project_id,${source.id} LIMIT ?`);
          let project = '', resource = '';
          try {
            for (;;) {
              const rows = page.all(project, resource, RECOVERY_LOCATOR_PAGE_ROWS);
              for (const row of rows) {
                if (row.bundle_id === null) continue;
                if (!Number.isSafeInteger(row.bundle_id) || !Number.isSafeInteger(row.bundle_entry) || row.bundle_entry! < 0) {
                  throw new Error('content_bundle_entry_invalid');
                }
                insert.run(row.project_id,row.bundle_id,source.kind,row.resource_id,row.bundle_entry,
                  row.event_id,row.envelope_hash,row.token_id);
              }
              const last = rows.at(-1);
              if (last === undefined) break;
              project = last.project_id; resource = last.resource_id;
            }
          } finally { page.finalize(); }
        }
      })();
    } finally { insert.finalize(); }
    const dangling = db.query(`SELECT 1 FROM temp.${INVENTORY_TABLE} i LEFT JOIN archive_bundles a
      ON a.id=i.bundle_id AND a.project_id=i.project_id WHERE a.id IS NULL LIMIT 1`).get();
    if (dangling !== null) throw new Error('event_content_reference_invalid');
    const lookup = db.prepare<LocatorRow & { kind: 'event'|'tool-input'; entry: number }, [string, number, number]>(
      `SELECT * FROM temp.${INVENTORY_TABLE} WHERE project_id=? AND bundle_id=? ORDER BY kind,resource_id LIMIT ?`);
    return {
      forBundle(projectId: string, bundleId: number): BundleEntryIdentity[] {
        return lookup.all(projectId,bundleId,ARCHIVE_BUNDLE_ENTRIES+1).map(row => ({
          projectId: row.project_id,entry: row.entry,kind: row.kind,resourceId: row.resource_id,tokenId: row.token_id,
          ...(row.kind === 'event' ? { eventId: row.event_id!,envelopeHash: row.envelope_hash! } : {}),
        }));
      },
      close() { lookup.finalize(); drop(); },
    };
  } catch (error) { drop(); throw error; }
}

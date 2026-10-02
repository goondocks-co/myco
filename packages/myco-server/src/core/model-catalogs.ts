/**
 * The models each worker last listed for each harness it offers: the one writer and the one reader of
 * `worker_model_catalogs`.
 *
 * A worker reports one harness's catalog at a time (`POST /worker/models`); the newest report of a credential and
 * harness replaces the one before it. Settings reads every stored catalog to offer its models, and a claim reads the
 * claiming worker's catalog for what the model it requests resolves to. A catalog is the worker's own listing of its
 * machine, never evidence that a provider accepts a request. A credential's catalogs are forgotten with its worker
 * contact.
 */
import type { RelationalStore } from './adapters.js';
import { parseModelCatalog, type ModelCatalog } from '@goondocks/myco-shared/execution-profile';

/** A stored catalog, with the machine that reported it and when the Deployment received it. */
export interface StoredModelCatalog extends ModelCatalog {
  machineId: string | null;
  receivedAt: number;
}

/** Store the catalog a worker reported, replacing the one its credential last reported for the same harness. */
export async function recordModelCatalog(
  db: RelationalStore, report: { credentialId: string; machineId: string | null; catalog: ModelCatalog; now: number },
): Promise<void> {
  const { catalog } = report;
  await db.prepare(
    `INSERT INTO worker_model_catalogs (credential_id, harness, machine_id, catalog, fetched_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (credential_id, harness) DO UPDATE SET
       machine_id = excluded.machine_id, catalog = excluded.catalog, fetched_at = excluded.fetched_at, received_at = excluded.received_at`,
  ).bind(report.credentialId, catalog.harness, report.machineId, JSON.stringify(catalog), catalog.fetchedAt, report.now).run();
}

/** A stored row as a catalog, or null where it no longer reads as one; a reader states that it does not know rather than guess. */
function catalogOf(row: Record<string, unknown>): StoredModelCatalog | null {
  let parsed: unknown;
  try { parsed = JSON.parse(String(row.catalog)); } catch { return null; }
  const catalog = parseModelCatalog(parsed);
  if (catalog === null || catalog.harness !== String(row.harness)) return null;
  return { ...catalog, machineId: row.machine_id == null ? null : String(row.machine_id), receivedAt: Number(row.received_at) };
}

/** Every stored catalog, newest received first. A row that no longer reads as a catalog is left out. */
export async function readModelCatalogs(db: RelationalStore): Promise<StoredModelCatalog[]> {
  const { results } = await db.prepare(
    `SELECT harness, machine_id, catalog, received_at FROM worker_model_catalogs ORDER BY received_at DESC, harness`,
  ).all<Record<string, unknown>>();
  return (results ?? []).flatMap((row) => { const catalog = catalogOf(row); return catalog === null ? [] : [catalog]; });
}

/**
 * What the claiming worker's harness listed `model` as resolving to, or undefined where its catalog lists no
 * resolution for it, or it has no catalog.
 */
export async function catalogResolution(db: RelationalStore, credentialId: string, harness: string, model: string): Promise<string | undefined> {
  const row = await db.prepare(`SELECT harness, machine_id, catalog, received_at FROM worker_model_catalogs WHERE credential_id = ? AND harness = ?`)
    .bind(credentialId, harness).first<Record<string, unknown>>();
  if (row == null) return undefined;
  return catalogOf(row)?.models.find((entry) => entry.id === model)?.resolvesTo;
}

/** Forget the catalogs of credentials whose worker contact is gone, at most `batch` rows per call. */
export async function pruneModelCatalogs(db: RelationalStore, batch: number): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM worker_model_catalogs
      WHERE rowid IN (
        SELECT rowid FROM worker_model_catalogs
         WHERE credential_id NOT IN (SELECT credential_id FROM worker_contacts)
         LIMIT ?)`,
  ).bind(batch).run();
  return result.meta.changes ?? 0;
}

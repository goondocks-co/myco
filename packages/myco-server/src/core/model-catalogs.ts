/**
 * The models each machine's worker last listed for each harness it offers: the one writer and the one reader of
 * `worker_model_catalogs`.
 *
 * A worker reports one harness's catalog at a time (`POST /worker/models`), and the newest report of a machine and
 * harness replaces the one before it, whichever of the machine's credentials sent it. Only a catalog received within
 * `MODEL_CATALOG_FRESH_MS` counts, subject to the machine's latest known harness offers: Settings offers its models,
 * and a claim reads the claiming machine's resolutions from it. The lease sweep forgets the rest. A catalog is the
 * worker's own listing of its machine, made with the machine's own login, never evidence that a provider accepts a request.
 */
import type { RelationalStore } from './adapters.js';
import { MODEL_CATALOG_FRESH_MS, parseModelCatalog, type ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import { readMachineOffers } from './worker-contacts.js';

/** A stored catalog, with when the Deployment received it. */
export interface StoredModelCatalog extends ModelCatalog {
  receivedAt: number;
}

/** The oldest instant a catalog may have been received at and still count, at `now`. */
const freshSince = (now: number): number => now - MODEL_CATALOG_FRESH_MS;

/** Each model the catalog lists a resolution for, and the model it resolves to. */
const resolutionsOf = (catalog: ModelCatalog): Record<string, string> =>
  Object.fromEntries(catalog.models.flatMap((model) => (model.resolvesTo === undefined ? [] : [[model.id, model.resolvesTo]])));

/** Store the catalog a machine's worker reported, replacing the one the machine last reported for the same harness. */
export async function recordModelCatalog(
  db: RelationalStore, report: { machineId: string; catalog: ModelCatalog; now: number },
): Promise<void> {
  const { catalog } = report;
  await db.prepare(
    `INSERT INTO worker_model_catalogs (machine_id, harness, catalog, resolutions, fetched_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (machine_id, harness) DO UPDATE SET
       catalog = excluded.catalog, resolutions = excluded.resolutions, fetched_at = excluded.fetched_at, received_at = excluded.received_at`,
  ).bind(report.machineId, catalog.harness, JSON.stringify(catalog), JSON.stringify(resolutionsOf(catalog)), catalog.fetchedAt, report.now).run();
}

/** A stored row as a catalog, or null where it no longer reads as one; a reader states that it does not know rather than guess. */
function catalogOf(row: Record<string, unknown>): StoredModelCatalog | null {
  let parsed: unknown;
  try { parsed = JSON.parse(String(row.catalog)); } catch { return null; }
  const catalog = parseModelCatalog(parsed);
  if (catalog === null || catalog.harness !== String(row.harness)) return null;
  return { ...catalog, receivedAt: Number(row.received_at) };
}

/** Catalogs count only where the machine's latest known offers keep their harness authenticated. */
async function availableCatalogRows(db: RelationalStore, now: number, scope?: { machineId: string; harness: string }): Promise<Record<string, unknown>[]> {
  const where = scope === undefined ? '' : ' AND machine_id = ? AND harness = ?';
  const values = scope === undefined ? [] : [scope.machineId, scope.harness];
  const { results } = await db.prepare(
    `SELECT machine_id, harness, catalog, resolutions, received_at FROM worker_model_catalogs
      WHERE received_at >= ?${where} ORDER BY received_at DESC, harness`,
  ).bind(freshSince(now), ...values).all<Record<string, unknown>>();
  const reports = await readMachineOffers(db);
  return (results ?? []).filter((row) => {
    const machineId = String(row.machine_id);
    return !reports.has(machineId) || reports.get(machineId)?.some((offer) => offer.id === String(row.harness) && offer.authenticated) === true;
  });
}

/** Every available catalog received within the freshness window at `now`, newest first. Unreadable catalogs are left out. */
export async function readModelCatalogs(db: RelationalStore, now: number): Promise<StoredModelCatalog[]> {
  return (await availableCatalogRows(db, now)).flatMap((row) => { const catalog = catalogOf(row); return catalog === null ? [] : [catalog]; });
}

/**
 * What the claiming machine's fresh catalog of `harness` lists `model` as resolving to, or undefined where it lists no
 * resolution for it, or the machine has no fresh, available catalog of the harness.
 */
export async function catalogResolution(db: RelationalStore, machineId: string, harness: string, model: string, now: number): Promise<string | undefined> {
  const [row] = await availableCatalogRows(db, now, { machineId, harness });
  if (row == null) return undefined;
  let resolutions: unknown;
  try { resolutions = JSON.parse(String(row.resolutions)); } catch { return undefined; }
  if (resolutions === null || typeof resolutions !== 'object' || !Object.hasOwn(resolutions, model)) return undefined;
  const resolved: unknown = (resolutions as Record<string, unknown>)[model];
  return typeof resolved === 'string' && resolved !== '' ? resolved : undefined;
}

/** Forget catalogs received before the freshness window at `now`, at most `batch` rows per call. */
export async function pruneModelCatalogs(db: RelationalStore, now: number, batch: number): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM worker_model_catalogs
      WHERE rowid IN (SELECT rowid FROM worker_model_catalogs WHERE received_at < ? ORDER BY received_at LIMIT ?)`,
  ).bind(freshSince(now), batch).run();
  return result.meta.changes ?? 0;
}

/**
 * The models each machine's worker, and each runner, last listed for each harness it offers: the one writer and the one
 * reader of `worker_model_catalogs` and `runner_model_catalogs`.
 *
 * A worker reports one harness's catalog at a time (`POST /worker/models`), and the newest report of a machine and
 * harness replaces the one before it, whichever of the machine's credentials sent it. Only a catalog received within
 * `MODEL_CATALOG_FRESH_MS` counts, subject to the machine's latest known harness offers: Settings offers its models,
 * and a claim reads the claiming machine's resolutions from it. The lease sweep forgets the rest. A catalog is the
 * worker's own listing of its machine, made with the machine's own login, never evidence that a provider accepts a request.
 */
import type { PreparedStatement, RelationalStore } from './adapters.js';
import { MODEL_CATALOG_FRESH_MS, parseModelCatalog, type ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import { readMachineOffers } from './worker-contacts.js';

/** Whose listing a catalog is: a legacy worker's machine, or a runner by its stable id. */
export type CatalogOwner = { kind: 'machine'; machineId: string } | { kind: 'runner'; runnerId: string };

/** A stored catalog, with when the Deployment received it. */
export interface StoredModelCatalog extends ModelCatalog {
  receivedAt: number;
}

/** Replacement credentials establish their own model observations. */
export function invalidateRunnerCatalogs(db: RelationalStore, runnerId: string): PreparedStatement {
  return db.prepare('DELETE FROM runner_model_catalogs WHERE runner_id = ?').bind(runnerId);
}

/** The oldest instant a catalog may have been received at and still count, at `now`. */
const freshSince = (now: number): number => now - MODEL_CATALOG_FRESH_MS;

/** Each model the catalog lists a resolution for, and the model it resolves to. */
const resolutionsOf = (catalog: ModelCatalog): Record<string, string> =>
  Object.fromEntries(catalog.models.flatMap((model) => (model.resolvesTo === undefined ? [] : [[model.id, model.resolvesTo]])));

/** Store the catalog a machine's worker reported, replacing the one the machine last reported for the same harness. */
export async function recordModelCatalog(
  db: RelationalStore, report: { owner: CatalogOwner; catalog: ModelCatalog; now: number },
): Promise<void> {
  const { catalog, owner } = report;
  const [table, key] = owner.kind === 'machine' ? ['worker_model_catalogs', 'machine_id'] : ['runner_model_catalogs', 'runner_id'];
  await db.prepare(
    `INSERT INTO ${table} (${key}, harness, catalog, resolutions, fetched_at, received_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (${key}, harness) DO UPDATE SET
       catalog = excluded.catalog, resolutions = excluded.resolutions, fetched_at = excluded.fetched_at, received_at = excluded.received_at`,
  ).bind(owner.kind === 'machine' ? owner.machineId : owner.runnerId, catalog.harness, JSON.stringify(catalog), JSON.stringify(resolutionsOf(catalog)), catalog.fetchedAt, report.now).run();
}

/** A stored row as a catalog, or null where it no longer reads as one; a reader states that it does not know rather than guess. */
function catalogOf(row: Record<string, unknown>): StoredModelCatalog | null {
  let parsed: unknown;
  try { parsed = JSON.parse(String(row.catalog)); } catch { return null; }
  const catalog = parseModelCatalog(parsed);
  if (catalog === null || catalog.harness !== String(row.harness)) return null;
  return { ...catalog, receivedAt: Number(row.received_at) };
}

/**
 * Catalogs count only where their owner's latest known offers keep the harness authenticated: a machine's across its
 * legacy workers, a runner's from its own contact. A removed runner's catalog never counts.
 */
async function availableCatalogRows(db: RelationalStore, now: number, scope?: { owner: CatalogOwner; harness: string }): Promise<Record<string, unknown>[]> {
  const machines = scope === undefined || scope.owner.kind === 'machine';
  const runners = scope === undefined || scope.owner.kind === 'runner';
  const scoped = (column: string) => (scope === undefined ? '' : ` AND ${column} = ? AND harness = ?`);
  const values = scope === undefined ? [] : [scope.owner.kind === 'machine' ? scope.owner.machineId : scope.owner.runnerId, scope.harness];
  const parts = [
    ...(machines ? [{ sql: `SELECT 'machine' AS owner_kind, machine_id AS owner_id, harness, catalog, resolutions, received_at, NULL AS runner_offers
      FROM worker_model_catalogs WHERE received_at >= ?${scoped('machine_id')}`, params: [freshSince(now), ...values] }] : []),
    ...(runners ? [{ sql: `SELECT 'runner' AS owner_kind, m.runner_id AS owner_id, m.harness, m.catalog, m.resolutions, m.received_at, w.offers AS runner_offers
      FROM runner_model_catalogs m JOIN runners r ON r.id = m.runner_id LEFT JOIN runner_contacts w ON w.runner_id = m.runner_id
      WHERE m.received_at >= ? AND r.state <> 'removed'${scoped('m.runner_id')}`, params: [freshSince(now), ...values] }] : []),
  ];
  const { results } = await db.prepare(`${parts.map((part) => part.sql).join(' UNION ALL ')} ORDER BY received_at DESC, harness`)
    .bind(...parts.flatMap((part) => part.params)).all<Record<string, unknown>>();
  const reports = machines ? await readMachineOffers(db) : new Map<string, null>();
  return (results ?? []).filter((row) => {
    const harness = String(row.harness);
    if (row.owner_kind === 'runner') {
      if (typeof row.runner_offers !== 'string') return true;
      try {
        const offers: unknown = JSON.parse(row.runner_offers);
        return Array.isArray(offers) && offers.some((offer) => (offer as { id?: unknown }).id === harness && (offer as { authenticated?: unknown }).authenticated === true);
      } catch { return false; }
    }
    const machineId = String(row.owner_id);
    return !reports.has(machineId) || reports.get(machineId)?.some((offer) => offer.id === harness && offer.authenticated) === true;
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
export async function catalogResolution(db: RelationalStore, owner: CatalogOwner, harness: string, model: string, now: number): Promise<string | undefined> {
  const [row] = await availableCatalogRows(db, now, { owner, harness });
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
  const runners = await db.prepare(
    `DELETE FROM runner_model_catalogs
      WHERE rowid IN (SELECT rowid FROM runner_model_catalogs WHERE received_at < ? ORDER BY received_at LIMIT ?)`,
  ).bind(freshSince(now), batch).run();
  return (result.meta.changes ?? 0) + (runners.meta.changes ?? 0);
}

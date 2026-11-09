import type { RelationalStore } from '../../core/adapters.js';
import { first, read, readSet, rows, write, type Bound } from '../index.js';

const clearRunnerCatalog = write<[runner: string]>({ name: 'runners.clearCatalogs', sql: 'DELETE FROM runner_model_catalogs WHERE runner_id = ?1' });
/** Replacement credentials establish their own model observations. */
export const runnerCatalogInvalidation = (runnerId: string): Bound => clearRunnerCatalog.bind(runnerId);

type CatalogSlots = [owner: string, harness: string, catalog: string, resolutions: string, fetchedAt: number, now: number, order: number];
const upsert = <Extra extends readonly (string | number | null)[]>(table: string, key: string, name: string, extra: readonly string[]) => write<[...CatalogSlots, ...Extra], { observed_order: number | null }>({ name, sql:
  `INSERT INTO ${table} (${key}, harness, catalog, resolutions, fetched_at, received_at, observed_order${extra.map(column => `, ${column}`).join('')})
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7${extra.map((_, i) => `, ?${8 + i}`).join('')})
    ON CONFLICT (${key}, harness) DO UPDATE SET
      catalog = excluded.catalog, resolutions = excluded.resolutions, fetched_at = excluded.fetched_at, received_at = excluded.received_at,
      observed_order = excluded.observed_order${extra.map(column => `, ${column} = excluded.${column}`).join('')}
      WHERE excluded.observed_order IS NOT NULL AND (${table}.observed_order IS NULL OR excluded.observed_order > ${table}.observed_order)
    RETURNING observed_order` });
const machineUpsert = upsert<[]>('worker_model_catalogs', 'machine_id', 'runners.putMachineCatalog', []);
const runnerUpsert = upsert<[source: string | null, available: number]>('runner_model_catalogs', 'runner_id', 'runners.putRunnerCatalog', ['source', 'available']);

export interface CatalogWrite { harness: string; catalog: string; resolutions: string; fetchedAt: number; now: number; observedOrder: number; source: string | null }

/** Replace the owner's catalog of this harness when the report is newer. Answers whether the row changed, from the row the write returned. */
export async function putModelCatalog(db: RelationalStore, owner: { kind: 'machine' | 'runner'; id: string }, catalog: CatalogWrite): Promise<boolean> {
  const values: CatalogSlots = [owner.id, catalog.harness, catalog.catalog, catalog.resolutions, catalog.fetchedAt, catalog.now, catalog.observedOrder];
  const written = await rows(db, owner.kind === 'machine' ? machineUpsert.bind(...values) : runnerUpsert.bind(...values, catalog.source, 1));
  return written.length === 1;
}

const machineOrder = read<[owner: string, harness: string], { observed_order: number | null }>({ name: 'runners.machineCatalogOrder', sql: 'SELECT observed_order FROM worker_model_catalogs WHERE machine_id = ?1 AND harness = ?2' });
const runnerOrder = read<[owner: string, harness: string], { observed_order: number | null }>({ name: 'runners.runnerCatalogOrder', sql: 'SELECT observed_order FROM runner_model_catalogs WHERE runner_id = ?1 AND harness = ?2' });
export const catalogObservedOrder = async (db: RelationalStore, owner: { kind: 'machine' | 'runner'; id: string }, harness: string): Promise<number | null> =>
  (await first(db, owner.kind === 'machine' ? machineOrder.bind(owner.id, harness) : runnerOrder.bind(owner.id, harness)))?.observed_order ?? null;

export interface AvailableCatalogRow { owner_kind: 'machine' | 'runner'; owner_id: string; harness: string; catalog: string; resolutions: string; received_at: number; runner_offers: string | null }

const COLUMNS = (kind: string, owner: string, offers: string) => `'${kind}' AS owner_kind, ${owner} AS owner_id, harness, catalog, resolutions, received_at, ${offers} AS runner_offers`;
const machinePart = (scoped: string) => `SELECT ${COLUMNS('machine', 'machine_id', 'NULL')} FROM worker_model_catalogs WHERE received_at >= ?1${scoped}`;
const runnerPart = (scoped: string) => `SELECT 'runner' AS owner_kind, m.runner_id AS owner_id, m.harness, m.catalog, m.resolutions, m.received_at, w.offers AS runner_offers
  FROM runner_model_catalogs m JOIN runners r ON r.id = m.runner_id LEFT JOIN runner_contacts w ON w.runner_id = m.runner_id
  WHERE m.received_at >= ?1 AND r.state <> 'removed'${scoped}`;
const ordered = ' ORDER BY received_at DESC, harness';

const everyCatalog = read<[since: number], AvailableCatalogRow>({ name: 'runners.availableCatalogs', sql: `${machinePart('')} UNION ALL ${runnerPart('')}${ordered}` });
const machineCatalog = read<[since: number, machine: string, harness: string], AvailableCatalogRow>({ name: 'runners.machineCatalog', sql: `${machinePart(' AND machine_id = ?2 AND harness = ?3')}${ordered}` });
const runnerCatalog = read<[since: number, runner: string, harness: string], AvailableCatalogRow>({ name: 'runners.runnerCatalog', sql: `${runnerPart(' AND m.runner_id = ?2 AND m.harness = ?3')}${ordered}` });

export const availableCatalogBodies = async (db: RelationalStore, since: number, scope?: { owner: { kind: 'machine' | 'runner'; id: string }; harness: string }): Promise<AvailableCatalogRow[]> => {
  const bound = scope === undefined ? everyCatalog.bind(since)
    : scope.owner.kind === 'machine' ? machineCatalog.bind(since, scope.owner.id, scope.harness) : runnerCatalog.bind(since, scope.owner.id, scope.harness);
  return (await readSet(db, bound))[0];
};

const pruneMachine = write<[cutoff: number, batch: number], { machine_id: string }>({ name: 'runners.pruneMachineCatalogs', sql:
  'DELETE FROM worker_model_catalogs WHERE rowid IN (SELECT rowid FROM worker_model_catalogs WHERE received_at < ?1 ORDER BY received_at LIMIT ?2) RETURNING machine_id' });
const pruneRunner = write<[cutoff: number, batch: number], { runner_id: string }>({ name: 'runners.pruneRunnerCatalogs', sql:
  'DELETE FROM runner_model_catalogs WHERE rowid IN (SELECT rowid FROM runner_model_catalogs WHERE received_at < ?1 ORDER BY received_at LIMIT ?2) RETURNING runner_id' });

/** Forget stale catalogs, at most `batch` rows of each kind per call. Answers how many went. */
export async function pruneCatalogs(db: RelationalStore, cutoff: number, batch: number): Promise<number> {
  return (await rows(db, pruneMachine.bind(cutoff, batch))).length + (await rows(db, pruneRunner.bind(cutoff, batch))).length;
}

import type { RelationalStore } from '../../core/adapters.js';
import { capabilityOnSql, curationEnabledAtSql } from '../../db/settings/admission.js';
import { curationChangeSql } from '../curation-changes.js';
import { commitNamed, first, read, readSet, rows, write } from '../index.js';
import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import { CURATION_MAX_FAILURES } from '../runs/pull-policy.js';
import type { CurationSeedMember, CurationWork } from './curation-work.js';

/** Which spores deserve a curation run: the changed-Project walk, one Project's seed pass, and the current view of each candidate. */
const clockRow = read<[], { after_project: string }>({ name: 'curationDiscovery.clock', sql: 'SELECT after_project FROM spore_curation_clock WHERE id=1' });
const setClock = write<[project: string]>({ name: 'curationDiscovery.setClock', sql: 'UPDATE spore_curation_clock SET after_project=?1 WHERE id=1' });
const clearDirtyWrite = write<[project: string]>({ name: 'curationDiscovery.clearDirty', sql: 'UPDATE spore_curation_changes SET dirty=0 WHERE project_id=?1' });

export const readCurationClock = async (db: RelationalStore): Promise<string> => (await first(db, clockRow.bind()))!.after_project;
export const advanceCurationClock = (db: RelationalStore, project: string): Promise<unknown> => rows(db, setClock.bind(project));
export const clearCurationDirty = (db: RelationalStore, project: string): Promise<unknown> => rows(db, clearDirtyWrite.bind(project));

const enabledRow = read<[project: string], { enabled: number }>({ name: 'curationDiscovery.enabled', sql: `SELECT ${capabilityOnSql('?1', "'spore_curation'")} AS enabled` });
const floorRow = read<[project: string], { floor: number | null }>({
  name: 'curationDiscovery.floor',
  sql: `SELECT CASE WHEN ${capabilityOnSql('?1', "'spore_curation_backfill'")} THEN 0 ELSE ${curationEnabledAtSql('?1')} END AS floor`,
});
const IN_FLIGHT = `EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id=w.project_id AND r.id=w.run_id AND r.${IN_FLIGHT_RUN_STATUSES})`;
type OpenWork = CurationWork & { live: number };
const openWork = read<[project: string, now: number, maxFailures: number], OpenWork>({
  name: 'curationDiscovery.openWork',
  sql: `SELECT w.*,${IN_FLIGHT} AS live FROM spore_curation_work w INDEXED BY idx_curation_due
    WHERE w.project_id=?1 AND w.due_at IS NOT NULL AND (w.failures=0 OR w.due_at<=?2 OR w.failures>=?3 OR ${IN_FLIGHT}) LIMIT 1`,
});
const frontierRow = read<[project: string], { revision: number; pending_at: number | null }>({ name: 'curationDiscovery.frontier', sql: 'SELECT revision,pending_at FROM spore_curation_changes WHERE project_id=?1' });
interface CurationCursor { after_at: number; after_id: string; pass_revision: number; active: number }
const cursorRow = read<[project: string], CurationCursor>({ name: 'curationDiscovery.cursor', sql: 'SELECT after_at,after_id,pass_revision,active FROM spore_curation_cursor WHERE project_id=?1' });

interface CurationProjectState {
  enabled: boolean;
  open: OpenWork | null;
  frontier: { revision: number; pending_at: number | null };
  cursor: CurationCursor | null;
  floor: number | null;
}

/** Everything one discovery pass decides from, read in one batch. */
export async function readCurationProjectState(db: RelationalStore, project: string, now: number): Promise<CurationProjectState> {
  const [enabled, open, frontier, cursor, floor] = await readSet(db, enabledRow.bind(project), openWork.bind(project, now, CURATION_MAX_FAILURES), frontierRow.bind(project), cursorRow.bind(project), floorRow.bind(project));
  return { enabled: enabled[0]!.enabled === 1, open: open[0] ?? null, frontier: frontier[0]!, cursor: cursor[0] ?? null, floor: floor[0]!.floor };
}

const beginCursor = write<[start: number, project: string, revision: number], CurationCursor>({
  name: 'curationDiscovery.beginCursor',
  sql: `INSERT INTO spore_curation_cursor(project_id,after_at,after_id,pass_revision,active)
    SELECT project_id,?1,'',revision,1 FROM spore_curation_changes WHERE project_id=?2 AND revision=?3 AND dirty=1
    ON CONFLICT(project_id) DO UPDATE SET after_at=excluded.after_at,after_id='',pass_revision=excluded.pass_revision,active=1
    WHERE spore_curation_cursor.active=0 RETURNING after_at,after_id,pass_revision,active`,
});
const clearPending = write<[project: string, revision: number, start: number]>({
  name: 'curationDiscovery.clearPending',
  sql: `UPDATE spore_curation_changes SET pending_at=NULL WHERE project_id=?1 AND revision=?2 AND EXISTS
    (SELECT 1 FROM spore_curation_cursor WHERE project_id=?1 AND active=1 AND pass_revision=?2 AND after_at=?3 AND after_id='')`,
});

/** Starts a seed pass at this frontier, or answers null when another pass or a newer change got there first. */
export async function beginCurationPass(db: RelationalStore, project: string, start: number, revision: number): Promise<CurationCursor | null> {
  const committed = await commitNamed(db, { cursor: beginCursor.bind(start, project, revision), pending: clearPending.bind(project, revision, start) });
  return committed.cursor.results[0] ?? null;
}

type CurationSeed = { id: string; revision: number; stamp: number };
const SEED_STAMP = 'COALESCE(updated_at,created_at)';
const seedsAtStamp = read<[project: string, stamp: number, afterId: string, limit: number], CurationSeed>({
  name: 'curationDiscovery.seedsAtStamp',
  sql: `SELECT id,revision,${SEED_STAMP} AS stamp FROM spores INDEXED BY idx_spores_curation_seek WHERE project_id=?1 AND status='active' AND ${SEED_STAMP}=?2 AND id>?3 ORDER BY ${SEED_STAMP},id LIMIT ?4`,
});
const seedsAfterStamp = read<[project: string, stamp: number, limit: number], CurationSeed>({
  name: 'curationDiscovery.seedsAfterStamp',
  sql: `SELECT id,revision,${SEED_STAMP} AS stamp FROM spores INDEXED BY idx_spores_curation_seek WHERE project_id=?1 AND status='active' AND ${SEED_STAMP}>?2 ORDER BY ${SEED_STAMP},id LIMIT ?3`,
});

/** The next seeds after the cursor: the remainder of its instant, then later instants. */
export async function readCurationSeeds(db: RelationalStore, project: string, cursor: Pick<CurationCursor, 'after_at' | 'after_id'>, limit: number): Promise<CurationSeed[]> {
  const [tied, later] = await readSet(db, seedsAtStamp.bind(project, cursor.after_at, cursor.after_id, limit), seedsAfterStamp.bind(project, cursor.after_at, limit));
  return [...tied, ...later].slice(0, limit);
}

interface CurationSeedState { id: string; acked: number | null; receipt_id: string | null; updated_at: number | null; neighbor_mean: number | null; neighbor_std: number | null }
const seedStates = read<[project: string, modelKey: string, seeds: string], CurationSeedState>({
  name: 'curationDiscovery.seedStates',
  sql: `SELECT seed.value AS id,(SELECT a.revision FROM spore_curation_receipts a WHERE a.project_id=?1 AND a.spore_id=seed.value) AS acked,
      r.id AS receipt_id,r.updated_at,r.neighbor_mean,r.neighbor_std
    FROM json_each(?3) seed
    LEFT JOIN embedding_versions v ON v.project_id=?1 AND v.type='spore' AND v.record_id=seed.value
    LEFT JOIN embedding_receipts r INDEXED BY idx_embedding_receipts_source ON r.project_id=v.project_id AND r.model_key=?2 AND r.type=v.type AND r.record_id=v.record_id AND r.revision=v.revision AND r.ready=1`,
});

/** Each seed's curation receipt and ready vector, keyed by seed. */
export async function readCurationSeedStates(db: RelationalStore, project: string, modelKey: string, seeds: readonly string[]): Promise<Map<string, CurationSeedState>> {
  if (seeds.length === 0) return new Map();
  return new Map((await rows(db, seedStates.bind(project, modelKey, JSON.stringify(seeds)))).map(state => [state.id, state]));
}

interface CurationReceiptHit { id: string; record_id: string; revision: string; neighbor_mean: number | null; neighbor_std: number | null }
/** How many neighbours a seed's gate looks at, and so how many vector receipts one lookup names. */
export const CURATION_GATE_NEIGHBORS = 16;
const VECTOR_SLOTS = Array.from({ length: CURATION_GATE_NEIGHBORS }, (_, index) => `?${index + 3}`).join(',');
const receiptsByVector = read<[project: string, modelKey: string, ...ids: (string | null)[]], CurationReceiptHit>({
  name: 'curationDiscovery.receiptsByVector',
  sql: `SELECT id,record_id,revision,neighbor_mean,neighbor_std FROM embedding_receipts INDEXED BY idx_embedding_receipts_spore
    WHERE project_id=?1 AND model_key=?2 AND ready=1 AND type='spore' AND id IN (${VECTOR_SLOTS})`,
});
export const readCurationVectorReceipts = (db: RelationalStore, project: string, modelKey: string, ids: readonly string[]): Promise<CurationReceiptHit[]> =>
  ids.length === 0 ? Promise.resolve([]) : rows(db, receiptsByVector.bind(project, modelKey, ...Array.from({ length: CURATION_GATE_NEIGHBORS }, (_, index) => ids[index] ?? null)));

type CurationNeighbourRow = { id: string; revision: number; reviewed: number };
const neighbours = read<[project: string, hits: string], CurationNeighbourRow>({
  name: 'curationDiscovery.neighbours',
  sql: `SELECT s.id,s.revision,CASE WHEN ack.revision=s.revision THEN 1 ELSE 0 END AS reviewed
    FROM json_each(?2) hit CROSS JOIN spores s ON s.project_id=?1 AND s.id=json_extract(hit.value,'$.id')
    LEFT JOIN spore_curation_receipts ack ON ack.project_id=s.project_id AND ack.spore_id=s.id
    WHERE +s.status='active'
      AND EXISTS (SELECT 1 FROM embedding_versions WHERE project_id=s.project_id AND type='spore' AND record_id=s.id AND revision=json_extract(hit.value,'$.revision'))
      AND NOT EXISTS (SELECT 1 FROM spore_curation_owners WHERE project_id=s.project_id AND spore_id=s.id)`,
});

/** The named vector hits still current, unowned and at the revision their vector holds. */
export function readCurationNeighbours(db: RelationalStore, project: string, hits: readonly { record_id: string; revision: string }[]): Promise<CurationNeighbourRow[]> {
  if (hits.length === 0) return Promise.resolve([]);
  return rows(db, neighbours.bind(project, JSON.stringify(hits.map(hit => ({ id: hit.record_id, revision: hit.revision })))));
}

const offerWork = write<[project: string, key: string, members: string, at: number], { cluster_key: string }>({
  name: 'curationDiscovery.offerWork',
  sql: `INSERT OR IGNORE INTO spore_curation_work(project_id,cluster_key,members,due_at) SELECT ?1,?2,?3,?4
    WHERE NOT EXISTS (SELECT 1 FROM json_each(?3) j LEFT JOIN spores s ON s.project_id=?1 AND s.id=json_extract(j.value,'$.id') AND +s.status='active' AND s.revision=json_extract(j.value,'$.revision') WHERE s.id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM json_each(?3) j CROSS JOIN spore_curation_owners o ON o.project_id=?1 AND o.spore_id=json_extract(j.value,'$.id'))
    RETURNING cluster_key`,
});
const offerOwners = write<[project: string, key: string, members: string]>({
  name: 'curationDiscovery.offerOwners',
  sql: `INSERT OR IGNORE INTO spore_curation_owners(project_id,spore_id,cluster_key) SELECT ?1,json_extract(j.value,'$.id'),?2 FROM json_each(?3) j
    WHERE EXISTS (SELECT 1 FROM spore_curation_work WHERE project_id=?1 AND cluster_key=?2 AND decision IS NULL AND due_at IS NOT NULL)`,
});

/** Records a new assignment and its exclusive ownership in one commit; false when a member moved on or another group owns one. */
export async function offerCurationCluster(db: RelationalStore, project: string, key: string, members: readonly CurationSeedMember[], now: number): Promise<boolean> {
  const encoded = JSON.stringify(members);
  const committed = await commitNamed(db, { work: offerWork.bind(project, key, encoded, now), owners: offerOwners.bind(project, key, encoded) });
  return committed.work.results.length === 1;
}

const advanceCursor = write<[stamp: number, id: string, active: number, project: string, pass: number, afterAt: number, afterId: string]>({
  name: 'curationDiscovery.advanceCursor',
  sql: `UPDATE spore_curation_cursor SET after_at=?1,after_id=?2,active=?3 WHERE project_id=?4 AND pass_revision=?5 AND active=1 AND after_at=?6 AND after_id=?7`,
});
const CHECKPOINT = (project: string, pass: string, stamp: string, id: string) => `EXISTS (SELECT 1 FROM spore_curation_cursor WHERE project_id=${project} AND active=0 AND pass_revision=${pass} AND after_at=${stamp} AND after_id=${id})`;
const deferredChange = write<[project: string, deferredAt: number, pass: number, stamp: number, id: string]>({
  name: 'curationDiscovery.deferredChange',
  sql: curationChangeSql('?1', '?2', CHECKPOINT('?1', '?3', '?4', '?5')).replace(/;$/, ''),
});
const finishedChange = write<[pass: number, project: string, stamp: number, id: string]>({
  name: 'curationDiscovery.finishedChange',
  sql: `UPDATE spore_curation_changes SET dirty=CASE WHEN revision=?1 THEN 0 ELSE 1 END WHERE project_id=?2 AND ${CHECKPOINT('?2', '?1', '?3', '?4')}`,
});

interface CurationPassProgress {
  project: string;
  pass: number;
  from: { after_at: number; after_id: string };
  to: { stamp: number; id: string };
  /** The pass found nothing more to do from this page. */
  finished: boolean;
  /** A vector is still applying: the pass stops here and the frontier returns to this instant. */
  deferredAt: number | null;
}

/** Saves a seed page's position; a finished pass rests unless the frontier moved while it ran. */
export async function commitCurationProgress(db: RelationalStore, progress: CurationPassProgress): Promise<void> {
  const { project, pass, from, to, finished, deferredAt } = progress;
  await commitNamed(db, {
    cursor: advanceCursor.bind(to.stamp, to.id, finished ? 0 : 1, project, pass, from.after_at, from.after_id),
    change: deferredAt !== null ? [deferredChange.bind(project, deferredAt, pass, to.stamp, to.id)]
      : finished ? [finishedChange.bind(pass, project, to.stamp, to.id)] : [],
  });
}

import type { RelationalStore } from '../../core/adapters.js';
import { OBJECT_PUT_IN_FLIGHT_MS } from '../../constants.js';
import { VECTOR_LOST_MS, VECTOR_REWRITE_LIMIT } from '../../core/embedding/provider.js';
import { HUBNESS_MEMBER as MEMBER, RECEIPT } from '../../core/embedding/receipt-state.js';
import { CURRENT_EMBEDDING_SOURCES } from '../embedding-sources.js';
import { commit, read, readSet, write, type BindValue, type Bound } from '../index.js';
import { VECTOR_PAGE, reclaimDue, sealDue } from './vector-pages.js';
import { changed, jsonKeys, trigger, type Trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

/** The source type whose vectors calibration covers. */
const SOURCE_TYPE = 'spore';
/** The distribution these vectors are calibrated into: a vector holds one state row and one contribution per distribution. */
const KIND = 'hubness';

/** A receipt names a current indexed vector of this source: what calibration covers, once the store returns it. */
const SPORE_SOURCE = CURRENT_EMBEDDING_SOURCES.find((source) => source.type === SOURCE_TYPE)!;
const CURRENT_RECEIPT = `r.type='${SOURCE_TYPE}' AND r.ready=${RECEIPT.ready} AND EXISTS (SELECT 1 FROM embedding_versions v WHERE v.project_id=r.project_id AND v.type='${SOURCE_TYPE}'
    AND v.record_id=r.record_id AND v.revision=r.revision AND EXISTS (SELECT 1 FROM ${SPORE_SOURCE.table} WHERE project_id=v.project_id AND ${SPORE_SOURCE.id}=v.record_id AND (${SPORE_SOURCE.eligible})))`;

/**
 * A vector's calibration status, read from its membership `m` and current receipt `r`: `uncovered` (no member yet),
 * `missing` (left out while the store does not return it, and still written again), `exhausted` (left out, written
 * again the most times), `departing` (a settled member that no longer names a covered vector), or NULL at rest.
 */
const STATUS = `CASE WHEN m.state IS NOT NULL
    THEN CASE WHEN m.state=${MEMBER.settled} AND NOT (r.id IS NOT NULL AND r.rewrites=0) THEN 'departing' END
  WHEN r.id IS NULL THEN NULL
  WHEN r.rewrites=0 THEN 'uncovered'
  WHEN r.rewrites<${VECTOR_REWRITE_LIMIT} THEN 'missing'
  ELSE 'exhausted' END`;

/**
 * Re-derive the calibration state of the vector keys `keys` (columns `project_id,model_key,id`): a key that is neither a
 * current vector nor a member loses its row; every other key holds exactly one row, stamped with its model's epoch.
 * Replaying it, or interleaving it with triggers, never double-counts.
 */
function reconcileCalibrationState(keys: string): string[] {
  return [
    `DELETE FROM embedding_calibration_state WHERE (project_id,model_key,kind,id) IN (SELECT project_id,model_key,'${KIND}',id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM embedding_hubness_members m WHERE m.project_id=embedding_calibration_state.project_id
        AND m.model_key=embedding_calibration_state.model_key AND m.id=embedding_calibration_state.id)
      AND NOT EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id=embedding_calibration_state.project_id
        AND r.model_key=embedding_calibration_state.model_key AND r.id=embedding_calibration_state.id AND ${CURRENT_RECEIPT})`,
    `INSERT INTO embedding_calibration_state(project_id,model_key,id,epoch,kind,is_current,rewrites,updated_at,member,status)
      SELECT k.project_id,k.model_key,k.id,
        COALESCE((SELECT e.epoch FROM embedding_models e WHERE e.project_id=k.project_id AND e.model_key=k.model_key),0),'${KIND}',
        r.id IS NOT NULL,COALESCE(r.rewrites,0),COALESCE(r.updated_at,0),m.state,${STATUS}
      FROM (${keys}) k LEFT JOIN embedding_receipts r ON r.project_id=k.project_id AND r.model_key=k.model_key AND r.id=k.id AND ${CURRENT_RECEIPT}
        LEFT JOIN embedding_hubness_members m ON m.project_id=k.project_id AND m.model_key=k.model_key AND m.id=k.id
      WHERE r.id IS NOT NULL OR m.id IS NOT NULL
      ON CONFLICT(project_id,model_key,kind,id) DO UPDATE SET epoch=excluded.epoch,is_current=excluded.is_current,
        rewrites=excluded.rewrites,updated_at=excluded.updated_at,member=excluded.member,status=excluded.status
      WHERE (epoch,is_current,rewrites,updated_at,member,status) IS NOT
        (excluded.epoch,excluded.is_current,excluded.rewrites,excluded.updated_at,excluded.member,excluded.status)`,
  ];
}

const vectorKey = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.model_key AS model_key,${row}.id AS id`;
/** Every model's vector of one spore, from the receipts naming it. */
const sourceKeys = (row: string) => `SELECT r.project_id AS project_id,r.model_key AS model_key,r.id AS id FROM embedding_receipts r
  WHERE r.project_id=${row}.project_id AND r.type='${SOURCE_TYPE}' AND r.record_id=${row}.record_id`;

/** The vector keys carried as one JSON array of `[project_id, model_key, id]`. */
const CALIBRATION_KEYS = jsonKeys(['project_id', 'model_key', 'id']);

/** One catch-up page: the keys' current calibration state, read inside the caller's commit. */
const CALIBRATION_RECONCILE = reconcileCalibrationState(CALIBRATION_KEYS)
  .map((sql, i) => write<[string]>({ name: `calibration.statePage${i}`, sql }));

/** The catch-up sources that initialize calibration state: every indexed vector and every member, in key order. */
export const CALIBRATION_CATCHUP = {
  projection: 'embedding_calibration',
  phases: {
    calibrationReceipts: { source: { table: 'embedding_receipts INDEXED BY idx_embedding_receipts_spore', columns: ['project_id', 'model_key', 'id'], where: `type='${SOURCE_TYPE}' AND ready=${RECEIPT.ready}` }, reconcile: CALIBRATION_RECONCILE },
    calibrationMembers: { source: { table: 'embedding_hubness_members', columns: ['project_id', 'model_key', 'id'] }, reconcile: CALIBRATION_RECONCILE },
  },
} as const satisfies CatchupFamily;

/** Each state row's contribution to its population row. */
const contribution = (row: string) => ({
  total: `${row}.is_current`,
  covered: `(${row}.is_current=1 AND ${row}.rewrites=0)`,
  member_count: `(${row}.member IS NOT NULL)`,
  operating: `(COALESCE(${row}.member,-1) IN (${MEMBER.joining},${MEMBER.leaving}))`,
  uncovered: `(${row}.status IS 'uncovered')`,
  departing: `(${row}.status IS 'departing')`,
  stale: `(COALESCE(${row}.member,-1) IN (${MEMBER.settled},${MEMBER.joining}) AND NOT (${row}.is_current=1 AND ${row}.rewrites=0))`,
});
const COUNTERS = Object.keys(contribution('NEW')) as Array<keyof ReturnType<typeof contribution>>;
const populationUpsert = (row: string, values: string[]) => `INSERT INTO embedding_calibration_population(project_id,model_key,epoch,kind,${COUNTERS.join(',')})
    VALUES(${row}.project_id,${row}.model_key,${row}.epoch,${row}.kind,${values.join(',')})
    ON CONFLICT(project_id,model_key,epoch,kind) DO UPDATE SET ${COUNTERS.map(c => `${c}=${c}+excluded.${c}`).join(',')}`;
const add = (row: string) => populationUpsert(row, COUNTERS.map(c => contribution(row)[c]));
const remove = (row: string) => populationUpsert(row, COUNTERS.map(c => `-${contribution(row)[c]}`));
const moved = populationUpsert('NEW', COUNTERS.map(c => `${contribution('NEW')[c]}-${contribution('OLD')[c]}`));
/** A population row goes with the last vector counted in it, whatever its epoch: an absent row reads as zero. */
const dropEmpty = `DELETE FROM embedding_calibration_population WHERE project_id=OLD.project_id AND model_key=OLD.model_key AND epoch=OLD.epoch AND kind=OLD.kind
    AND total=0 AND member_count=0`;

/**
 * The triggers that keep calibration state and its population current: a receipt, source version or membership change
 * re-derives only the vector keys it names, and each state row moves its population by `-old +new`.
 */
export function calibrationTriggers(): Trigger[] {
  const spore = (...rows: string[]) => rows.map(row => `${row}.type='${SOURCE_TYPE}'`).join(' OR ');
  const receiptColumns = ['project_id', 'model_key', 'id', 'type', 'record_id', 'revision', 'ready', 'rewrites', 'updated_at'];
  const versionColumns = ['project_id', 'type', 'record_id', 'revision'];
  const memberColumns = ['project_id', 'model_key', 'id', 'state'];
  const rest = ['is_current', 'rewrites', 'member', 'status'];
  const reconcile = reconcileCalibrationState;
  return [
    trigger('embedding_calibration_receipt_insert', 'embedding_receipts', 'INSERT', reconcile(vectorKey('NEW')), spore('NEW')),
    trigger('embedding_calibration_receipt_update', 'embedding_receipts', `UPDATE OF ${receiptColumns.join(',')}`, [...reconcile(vectorKey('OLD')), ...reconcile(vectorKey('NEW'))], `(${spore('OLD', 'NEW')}) AND (${changed(receiptColumns)})`),
    trigger('embedding_calibration_receipt_delete', 'embedding_receipts', 'DELETE', reconcile(vectorKey('OLD')), spore('OLD')),
    trigger('embedding_calibration_version_insert', 'embedding_versions', 'INSERT', reconcile(sourceKeys('NEW')), spore('NEW')),
    trigger('embedding_calibration_version_update', 'embedding_versions', `UPDATE OF ${versionColumns.join(',')}`, [...reconcile(sourceKeys('OLD')), ...reconcile(sourceKeys('NEW'))], `(${spore('OLD', 'NEW')}) AND (${changed(versionColumns)})`),
    trigger('embedding_calibration_version_delete', 'embedding_versions', 'DELETE', reconcile(sourceKeys('OLD')), spore('OLD')),
    trigger('embedding_calibration_member_insert', 'embedding_hubness_members', 'INSERT', reconcile(vectorKey('NEW'))),
    trigger('embedding_calibration_member_update', 'embedding_hubness_members', `UPDATE OF ${memberColumns.join(',')}`, [...reconcile(vectorKey('OLD')), ...reconcile(vectorKey('NEW'))], changed(memberColumns)),
    trigger('embedding_calibration_member_delete', 'embedding_hubness_members', 'DELETE', reconcile(vectorKey('OLD'))),
    trigger('embedding_calibration_population_insert', 'embedding_calibration_state', 'INSERT', [add('NEW')]),
    trigger('embedding_calibration_population_update', 'embedding_calibration_state', `UPDATE OF ${rest.join(',')}`, [moved], `OLD.epoch IS NEW.epoch AND OLD.kind IS NEW.kind AND (${changed(rest)})`),
    trigger('embedding_calibration_population_move', 'embedding_calibration_state', 'UPDATE OF epoch,kind', [remove('OLD'), add('NEW'), dropEmpty], 'OLD.epoch IS NOT NEW.epoch OR OLD.kind IS NOT NEW.kind'),
    trigger('embedding_calibration_population_delete', 'embedding_calibration_state', 'DELETE', [remove('OLD'), dropEmpty]),
  ];
}

/** The calibration's model counts: a Project's current spore vectors under `model` at its epoch, and what remains to do. */
export interface CalibrationPopulation {
  state: 'ready' | 'building';
  epoch: number;
  /** Advanced by every spore source or receipt change; every page commit is fenced by the revision it read. */
  revision: number;
  total: number;
  covered: number;
  members: number;
  operating: number;
  uncovered: number;
  departing: number;
  stale: number;
  /** A settled member's moments do not count exactly the other members. Read only at rest. */
  miscounted: boolean;
}

/**
 * Calibration is unavailable while its projection is initializing or a reset is still retiring this Project's rows: the
 * maintained counts do not yet name the population to calibrate, so the answer is `building`, never a zero.
 */
const populationRow = read<[string, string], Omit<CalibrationPopulation, 'state' | 'miscounted'> & { ready: number; retiring: number; miscounted: number }>({
  name: 'calibration.population',
  sql: `WITH e(epoch) AS (SELECT COALESCE((SELECT epoch FROM embedding_models WHERE project_id=?1 AND model_key=?2),0))
    SELECT e.epoch AS epoch,
      COALESCE((SELECT MIN(done) FROM projection_catchup WHERE projection='embedding_calibration'),0) AS ready,
      EXISTS(SELECT 1 FROM embedding_resets WHERE project_id=?1) AND EXISTS(SELECT 1 FROM projection_catchup WHERE projection='embedding_reset' AND done=0) AS retiring,
      COALESCE((SELECT revision FROM embedding_hubness_revision WHERE project_id=?1),0) AS revision,
      COALESCE(p.total,0) AS total,COALESCE(p.covered,0) AS covered,COALESCE(p.member_count,0) AS members,COALESCE(p.operating,0) AS operating,
      COALESCE(p.uncovered,0) AS uncovered,COALESCE(p.departing,0) AS departing,COALESCE(p.stale,0) AS stale,
      COALESCE(p.member_count,0)>0 AND COALESCE(p.operating,0)=0 AND (
        (SELECT n FROM embedding_hubness_members INDEXED BY idx_embedding_hubness_members_moments WHERE project_id=?1 AND model_key=?2 AND state=${MEMBER.settled} ORDER BY n LIMIT 1) IS NOT COALESCE(p.member_count,0)-1
        OR (SELECT n FROM embedding_hubness_members INDEXED BY idx_embedding_hubness_members_moments WHERE project_id=?1 AND model_key=?2 AND state=${MEMBER.settled} ORDER BY n DESC LIMIT 1) IS NOT COALESCE(p.member_count,0)-1) AS miscounted
    FROM e LEFT JOIN embedding_calibration_population p ON p.project_id=?1 AND p.model_key=?2 AND p.epoch=e.epoch AND p.kind='${KIND}'` });

const populationOf = (row: Omit<CalibrationPopulation, 'state' | 'miscounted'> & { ready: number; retiring: number; miscounted: number }): CalibrationPopulation =>
  ({ ...row, state: row.ready === 1 && row.retiring === 0 ? 'ready' : 'building', miscounted: row.miscounted === 1 });

/** The maintained population of a Project's current spore vectors under `model`, and whether it may be relied on. */
export async function calibrationPopulation(db: RelationalStore, projectId: string, model: string): Promise<CalibrationPopulation> {
  const [rows] = await readSet(db, populationRow.bind(projectId, model));
  return populationOf(rows[0]!);
}

/** Seeks of the two partitions either side of `model`: a member of another model is work on its own. */
const foreignBelow = read<[string, string], { model_key: string }>({ name: 'calibration.foreignBelow', sql: 'SELECT model_key FROM embedding_hubness_members WHERE project_id=?1 AND model_key<?2 LIMIT 1' });
const foreignAbove = read<[string, string], { model_key: string }>({ name: 'calibration.foreignAbove', sql: 'SELECT model_key FROM embedding_hubness_members WHERE project_id=?1 AND model_key>?2 LIMIT 1' });
const publishing = read<[string], { found: number }>({ name: 'calibration.publishing', sql: 'SELECT 1 AS found FROM embedding_cursors WHERE project_id=?1 AND hubness_cursor IS NOT NULL' });
const queueHead = read<[string, string, number, string], { found: number }>({ name: 'calibration.queueHead',
  sql: `SELECT 1 AS found FROM embedding_calibration_state INDEXED BY idx_embedding_calibration_queue
    WHERE project_id=?1 AND model_key=?2 AND epoch=?3 AND kind='${KIND}' AND status=?4 LIMIT 1` });
const exhaustedDue = read<[string, string, number, number], { found: number }>({ name: 'calibration.exhaustedDue',
  sql: `SELECT 1 AS found FROM embedding_calibration_state INDEXED BY idx_embedding_calibration_exhausted
    WHERE project_id=?1 AND model_key=?2 AND epoch=?3 AND kind='${KIND}' AND status='exhausted' AND updated_at>?4 LIMIT 1` });

/** Too few current vectors to calibrate, with memberships left that no longer count: they retire without any distance being computed. */
export const outlivesPopulation = (population: CalibrationPopulation): boolean =>
  population.total < 2 && (population.operating > 0 || population.departing > 0 || population.miscounted);

const foreignBetween = read<[string, string, string], { model_key: string }>({ name: 'calibration.foreignBetween',
  sql: 'SELECT model_key FROM embedding_hubness_members WHERE project_id=?1 AND model_key>?2 AND model_key<?3 ORDER BY model_key LIMIT 1' });
const ABOVE_EVERY_MODEL = '\u{10FFFF}';
/**
 * Another model whose memberships leave under calibration of `model`, or null. Below two current vectors a membership
 * under a kept model stays: one seek into each gap between `model` and the kept models finds any other, however many
 * members a kept model holds.
 */
export async function foreignModelToRetire(db: RelationalStore, projectId: string, model: string, population: CalibrationPopulation, kept: readonly string[]): Promise<string | null> {
  if (population.total >= 2) return foreignMemberModel(db, projectId, model);
  const edges = ['', ...[...new Set([model, ...kept])].sort(), ABOVE_EVERY_MODEL];
  const gaps = await Promise.all(edges.slice(1).map(async (to, i) => (await readSet(db, foreignBetween.bind(projectId, edges[i]!, to)))[0]));
  return gaps.find(rows => rows.length > 0)?.[0]!.model_key ?? null;
}

/**
 * Calibration has work under `model` for a Project: a member of another model, an operation in progress, a settled member
 * whose vector is no longer current, a current vector no member covers, a left-out vector still looked for or due to be
 * written again, statistics still to publish, settled moments that do not count the other members, a full page of vectors
 * still held in the database, or a stored page no member names. With fewer than two current vectors only the retirement
 * of memberships, those under `kept` models aside, and of pages remains. It only ever reads maintained state: the population row, the queue heads and the
 * cursor, a fixed handful of keyed rows however many spores the Project holds. While the population is `building` there
 * is no proof of rest, so the answer is yes.
 */
export async function calibrationHasWork(db: RelationalStore, projectId: string, model: string, now: number, kept: readonly string[] = []): Promise<boolean> {
  const population = await calibrationPopulation(db, projectId, model);
  if (population.state === 'building') return true;
  const unreferenced = reclaimDue(projectId, now - OBJECT_PUT_IN_FLIGHT_MS);
  if (outlivesPopulation(population)) return true;
  if (population.total < 2) {
    if (await foreignModelToRetire(db, projectId, model, population, kept) !== null) return true;
    return (await readSet(db, unreferenced))[0].length > 0;
  }
  if (population.operating > 0 || population.uncovered > 0 || population.departing > 0 || population.miscounted) return true;
  const heads = await readSet(db, foreignBelow.bind(projectId, model), foreignAbove.bind(projectId, model), publishing.bind(projectId),
    queueHead.bind(projectId, model, population.epoch, 'missing'), exhaustedDue.bind(projectId, model, population.epoch, now - VECTOR_LOST_MS), sealDue(projectId, model), unreferenced);
  return heads.some(found => found.length > 0);
}

/** A calibration queue entry. */
export interface QueuedVector { id: string; updated_at: number; rewrites: number }
/** Where the lost-vector probe stopped: the last write and id of the last abandoned vector it took. */
export interface CalibrationProbe { at: number; id: string }
const queuePage = read<[string, string, number, string, number], QueuedVector>({ name: 'calibration.queuePage',
  sql: `SELECT id,updated_at,rewrites FROM embedding_calibration_state INDEXED BY idx_embedding_calibration_queue
    WHERE project_id=?1 AND model_key=?2 AND epoch=?3 AND kind='${KIND}' AND status=?4 ORDER BY id LIMIT ?5` });
const exhaustedWaiting = read<[string, string, number, number, number], QueuedVector>({ name: 'calibration.exhaustedWaiting',
  sql: `SELECT id,updated_at,rewrites FROM embedding_calibration_state INDEXED BY idx_embedding_calibration_exhausted
    WHERE project_id=?1 AND model_key=?2 AND epoch=?3 AND kind='${KIND}' AND status='exhausted' AND updated_at>?4 ORDER BY updated_at,id LIMIT ?5` });
const abandonedColumns = `SELECT id,updated_at,rewrites FROM embedding_calibration_state INDEXED BY idx_embedding_calibration_exhausted
    WHERE project_id=?1 AND model_key=?2 AND epoch=?3 AND kind='${KIND}' AND status='exhausted'`;
const abandonedAfter = read<[string, string, number, number, number, string, number], QueuedVector>({ name: 'calibration.abandonedAfter',
  sql: `${abandonedColumns} AND updated_at<=?4 AND (updated_at,id)>(?5,?6) ORDER BY updated_at,id LIMIT ?7` });
/** The probe, last written before the deadline, is this seek's only upper bound, so the rows past it are never walked. */
const abandonedUpTo = read<[string, string, number, number, string, number], QueuedVector>({ name: 'calibration.abandonedUpTo',
  sql: `${abandonedColumns} AND (updated_at,id)<=(?4,?5) ORDER BY updated_at,id LIMIT ?6` });

/** The next settled members whose vectors are no longer covered. */
export async function departingVectors(db: RelationalStore, projectId: string, model: string, epoch: number, limit: number): Promise<QueuedVector[]> {
  const [rows] = await readSet(db, queuePage.bind(projectId, model, epoch, 'departing', limit));
  return rows;
}

/** The next current vectors no member covers. */
export async function uncoveredVectors(db: RelationalStore, projectId: string, model: string, epoch: number, limit: number): Promise<QueuedVector[]> {
  const [rows] = await readSet(db, queuePage.bind(projectId, model, epoch, 'uncovered', limit));
  return rows;
}

/**
 * Left-out vectors to look for: those still written again, in id order; those written again the most times and still
 * within `VECTOR_LOST_MS` of their last write, oldest first; then, only with room left, those no longer written again
 * from the probe on, wrapping in last-write order, so each one is looked for in turn. Every page is one index seek.
 */
export async function leftOutVectors(db: RelationalStore, projectId: string, model: string, epoch: number, lostBefore: number, probe: CalibrationProbe, limit: number): Promise<QueuedVector[]> {
  const [missing, waiting] = await readSet(db, queuePage.bind(projectId, model, epoch, 'missing', limit), exhaustedWaiting.bind(projectId, model, epoch, lostBefore, limit));
  const live = [...missing, ...waiting].slice(0, limit);
  if (live.length === limit) return live;
  const room = limit - live.length;
  const [after, upTo] = await readSet(db, abandonedAfter.bind(projectId, model, epoch, lostBefore, probe.at, probe.id, room), abandonedUpTo.bind(projectId, model, epoch, probe.at, probe.id, room));
  return [...live, ...after, ...upTo].slice(0, limit);
}

/** A calibration member's moments. */
export interface MemberMoments { id: string; state: number; n: number; mean: number; m2: number }
/** A member with where its vector is held: `vector` is base64 float32 until a stored page, named by `page_id`, holds it. */
export interface MemberVector extends MemberMoments { vector: string; page_id: number | null; page_offset: number | null; page_length: number | null }

const operatingPage = read<[string, string, number], MemberVector>({ name: 'calibration.operatingMembers',
  sql: `SELECT id,state,n,mean,m2,vector,page_id,page_offset,page_length FROM embedding_hubness_members INDEXED BY idx_embedding_hubness_members_state
    WHERE project_id=?1 AND model_key=?2 AND state IN (${MEMBER.joining},${MEMBER.leaving}) ORDER BY id LIMIT ?3` });
const settledPage = read<[string, string, string, number], MemberVector>({ name: 'calibration.settledMembers',
  sql: `SELECT id,state,n,mean,m2,vector,page_id,page_offset,page_length FROM embedding_hubness_members INDEXED BY idx_embedding_hubness_members_state
    WHERE project_id=?1 AND model_key=?2 AND state=${MEMBER.settled} AND id>?3 ORDER BY id LIMIT ?4` });
const settledMomentsPage = read<[string, string, string, number], MemberMoments>({ name: 'calibration.settledMoments',
  sql: `SELECT id,state,n,mean,m2 FROM embedding_hubness_members INDEXED BY idx_embedding_hubness_members_state
    WHERE project_id=?1 AND model_key=?2 AND state=${MEMBER.settled} AND id>?3 ORDER BY id LIMIT ?4` });

/** The members one operation adds or removes, at most `limit`. */
export async function operatingMembers(db: RelationalStore, projectId: string, model: string, limit: number): Promise<MemberVector[]> {
  const [rows] = await readSet(db, operatingPage.bind(projectId, model, limit));
  return rows;
}

/** One page of settled members with their vector copies, keyed after `after`. */
export async function settledMembers(db: RelationalStore, projectId: string, model: string, after: string, limit: number): Promise<MemberVector[]> {
  const [rows] = await readSet(db, settledPage.bind(projectId, model, after, limit));
  return rows;
}

/** One page of settled members' moments alone: what publishing their statistics reads. */
export async function settledMoments(db: RelationalStore, projectId: string, model: string, after: string, limit: number): Promise<MemberMoments[]> {
  const [rows] = await readSet(db, settledMomentsPage.bind(projectId, model, after, limit));
  return rows;
}

/** Another model a Project still holds calibration members under, read from the two partitions either side of `model`. */
async function foreignMemberModel(db: RelationalStore, projectId: string, model: string): Promise<string | null> {
  const [below, above] = await readSet(db, foreignBelow.bind(projectId, model), foreignAbove.bind(projectId, model));
  return below[0]?.model_key ?? above[0]?.model_key ?? null;
}

interface CursorRow { hubness_token: string | null; hubness_cursor: string | null; hubness_publication_revision: number | null; hubness_probe: string | null; hubness_probe_at: number | null }
const cursorRow = read<[string], CursorRow>({ name: 'calibration.cursor',
  sql: 'SELECT hubness_token,hubness_cursor,hubness_publication_revision,hubness_probe,hubness_probe_at FROM embedding_cursors WHERE project_id=?1' });
const openCursor = write<[string]>({ name: 'calibration.openCursor', sql: 'INSERT INTO embedding_cursors(project_id) VALUES (?1) ON CONFLICT(project_id) DO NOTHING' });
const mintToken = write<[string]>({ name: 'calibration.mintToken', sql: 'UPDATE embedding_cursors SET hubness_token=lower(hex(randomblob(8))) WHERE project_id=?1 AND hubness_token IS NULL' });
const moveProbe = write<[string, number, string]>({ name: 'calibration.moveProbe', sql: 'UPDATE embedding_cursors SET hubness_probe=?1,hubness_probe_at=?2 WHERE project_id=?3' });

/** One step's view of a calibration: the population, and the cursor whose token fences everything decided from it. */
interface CalibrationView {
  population: CalibrationPopulation;
  token: string;
  cursor: string | null;
  publicationRevision: number | null;
  probe: CalibrationProbe;
}

async function readCalibrationView(db: RelationalStore, projectId: string, model: string): Promise<CalibrationView> {
  const [populations, cursors] = await readSet(db, populationRow.bind(projectId, model), cursorRow.bind(projectId));
  const cursor = cursors[0];
  return { population: populationOf(populations[0]!), token: cursor?.hubness_token ?? '', cursor: cursor?.hubness_cursor ?? null, publicationRevision: cursor?.hubness_publication_revision ?? null,
    probe: { at: cursor?.hubness_probe_at ?? 0, id: cursor?.hubness_probe ?? '' } };
}

/**
 * The population and the commit token read together in one consistent read, so a step can only commit what it decided
 * from the state that token names. A Project with something to calibrate and no token gets one first, and is read again.
 */
export async function calibrationView(db: RelationalStore, projectId: string, model: string, retiring = false): Promise<CalibrationView> {
  const first = await readCalibrationView(db, projectId, model);
  if (first.token !== '' || first.population.state === 'building' || (first.population.total < 2 && !retiring)) return first;
  await commit(db, openCursor.bind(projectId), mintToken.bind(projectId));
  return readCalibrationView(db, projectId, model);
}

/** Move the lost-vector probe past the last one taken. */
export async function moveCalibrationProbe(db: RelationalStore, projectId: string, next: CalibrationProbe): Promise<void> {
  await commit(db, moveProbe.bind(next.id, next.at, projectId));
}

/** Every calibration write holds only while the cursor still carries the token its step read. */
const holds = (project: string, token: string) => `EXISTS (SELECT 1 FROM embedding_hubness_commits c JOIN embedding_cursors t ON t.project_id=c.project_id
  WHERE c.project_id=${project} AND c.token IS ${token} AND t.hubness_token=c.token)`;
/** Rows carried as one JSON array of `[id, n, mean, m2, neighbor_mean, neighbor_std]`. */
const CARRIED = `v AS MATERIALIZED (SELECT json_extract(j.value,'$[0]') AS id,json_extract(j.value,'$[1]') AS n,json_extract(j.value,'$[2]') AS mean,
  json_extract(j.value,'$[3]') AS m2,json_extract(j.value,'$[4]') AS neighbor_mean,json_extract(j.value,'$[5]') AS neighbor_std FROM json_each(?1) j)`;

const clearFence = write<[string]>({ name: 'calibration.fenceClear', sql: 'DELETE FROM embedding_hubness_commits WHERE project_id=?1' });
const openFence = write<[string, string, number]>({ name: 'calibration.fenceOpen',
  sql: `INSERT INTO embedding_hubness_commits(project_id,token) SELECT project_id,hubness_token FROM embedding_cursors
    WHERE project_id=?1 AND hubness_token IS ?2 AND COALESCE((SELECT revision FROM embedding_hubness_revision WHERE project_id=?1),0)=?3` });

/** How one commit moves the cursor: its fence advances the token, and the move sets what the next step continues from. */
type CursorMove = readonly [keyof typeof CURSOR_MOVES, ...BindValue[]];
const moveCursor = (key: string, set: string, slots: number) => write<readonly BindValue[], { project_id: string }>({ name: `calibration.move${key}`,
  sql: `UPDATE embedding_cursors SET hubness_token=lower(hex(randomblob(8)))${set} WHERE project_id=?${slots + 1} AND ${holds(`?${slots + 1}`, `?${slots + 2}`)} RETURNING project_id` });
const CURSOR_MOVES = {
  none: moveCursor('None', '', 0),
  clear: moveCursor('Clear', ', hubness_cursor=NULL', 0),
  clearCount: moveCursor('ClearCount', ', hubness_cursor=NULL, hubness_count=NULL', 0),
  pass: moveCursor('Pass', ", hubness_cursor=''", 0),
  advance: moveCursor('Advance', ', hubness_cursor=?1', 1),
  publish: moveCursor('Publish', ', hubness_cursor=?1, hubness_publication_revision=?2', 2),
  published: moveCursor('Published', ', hubness_cursor=NULL, hubness_publication_revision=?1', 1),
  settle: moveCursor('Settle', ', hubness_cursor=NULL, hubness_model=?1, hubness_count=?2', 2),
} as const;

/**
 * One calibration step's commit: `statements`, the cursor move and the fence, atomically, and only while the cursor
 * still carries `token` and the Project's calibration revision is still the one the step read. Answers whether it held.
 */
export async function commitCalibration(db: RelationalStore, projectId: string, token: string, revision: number, statements: readonly Bound[], [move, ...values]: CursorMove): Promise<boolean> {
  const results = await commit(db, clearFence.bind(projectId), openFence.bind(projectId, token, revision), ...statements,
    CURSOR_MOVES[move].bind(...values, projectId, token), clearFence.bind(projectId));
  return results[results.length - 2]!.results.length === 1;
}

/**
 * Let a written and verified page's members stop holding the bytes it now holds, and seal it, in one transaction under
 * the step's fence. Every statement applies only while that exact page is still being written, so a page already sealed,
 * replaced or gone leaves every row holding its bytes and the cursor as it was. Answers whether that page sealed.
 */
export async function commitVectorPageSeal(db: RelationalStore, projectId: string, model: string, token: string, revision: number, page: { id: number; objectKey: string },
  slots: ReadonlyArray<readonly [id: string, offset: number, length: number]>): Promise<boolean> {
  const results = await commit(db, clearFence.bind(projectId), openFence.bind(projectId, token, revision),
    retireInline.bind(JSON.stringify(slots), projectId, model, page.id, token, page.objectKey),
    moveSealing.bind(projectId, token, page.id, model, page.objectKey),
    sealPage.bind(page.id, projectId, model, page.objectKey, token), clearFence.bind(projectId));
  return results[3].results.length === 1 && results[4].results.length === 1;
}

const addJoiner = write<[string, string, string, string, string]>({ name: 'calibration.addJoiner',
  sql: `INSERT INTO embedding_hubness_members(project_id,model_key,id,state,vector) SELECT ?1,?2,?3,${MEMBER.joining},?4 WHERE ${holds('?1', '?5')}` });
const clearRewrites = write<[string, string, string, string]>({ name: 'calibration.clearRewrites',
  sql: `UPDATE embedding_receipts SET rewrites=0 WHERE project_id=?1 AND model_key=?2 AND id IN (SELECT value FROM json_each(?3)) AND ready=${RECEIPT.ready} AND rewrites>0 AND ${holds('?1', '?4')}` });
const requeueLost = write<[string, string, string, number, string]>({ name: 'calibration.requeueLost',
  sql: `UPDATE embedding_receipts SET ready=${RECEIPT.journaled},rewrites=rewrites+1 WHERE project_id=?1 AND model_key=?2 AND id IN (SELECT value FROM json_each(?3))
    AND ready=${RECEIPT.ready} AND rewrites<${VECTOR_REWRITE_LIMIT} AND updated_at<=?4 AND ${holds('?1', '?5')}` });
const markLeaving = write<[string, string, string, string]>({ name: 'calibration.markLeaving',
  sql: `UPDATE embedding_hubness_members SET state=${MEMBER.leaving} WHERE project_id=?1 AND model_key=?2 AND state=${MEMBER.settled}
    AND id IN (SELECT value FROM json_each(?3)) AND ${holds('?1', '?4')}` });
const settleJoiners = write<[string, string, string]>({ name: 'calibration.settleJoiners',
  sql: `UPDATE embedding_hubness_members SET state=${MEMBER.settled} WHERE project_id=?1 AND model_key=?2 AND state=${MEMBER.joining} AND ${holds('?1', '?3')}` });
const retireLeavers = write<[string, string, string]>({ name: 'calibration.retireLeavers',
  sql: `DELETE FROM embedding_hubness_members WHERE project_id=?1 AND model_key=?2 AND state=${MEMBER.leaving} AND ${holds('?1', '?3')}` });
const dropModelPage = write<[string, string, number, string]>({ name: 'calibration.dropModelPage',
  sql: `DELETE FROM embedding_hubness_members WHERE (project_id,model_key,id) IN
    (SELECT project_id,model_key,id FROM embedding_hubness_members WHERE project_id=?1 AND model_key=?2 ORDER BY id LIMIT ?3) AND ${holds('?1', '?4')}` });
const carry = write<[string, string, string, string]>({ name: 'calibration.carryMoments',
  sql: `WITH ${CARRIED} UPDATE embedding_hubness_members SET n=v.n,mean=v.mean,m2=v.m2 FROM v
    WHERE embedding_hubness_members.project_id=?2 AND embedding_hubness_members.model_key=?3 AND embedding_hubness_members.id=v.id AND ${holds('?2', '?4')}` });
/** This write's own page, by id, Project, model and object name, while it is still being written. */
const writingPage = (id: string, project: string, model: string, key: string) =>
  `EXISTS (SELECT 1 FROM embedding_vector_pages p WHERE p.page_id=${id} AND p.project_id=${project} AND p.model_key=${model} AND p.object_key=${key} AND p.state=${VECTOR_PAGE.writing})`;
/** Members give up their bytes only to the page this transaction goes on to seal; the fence holds their state and bytes as read. */
const retireInline = write<[string, string, string, number, string, string]>({ name: 'calibration.retireInline',
  sql: `WITH v AS MATERIALIZED (SELECT json_extract(j.value,'$[0]') AS id,json_extract(j.value,'$[1]') AS at,json_extract(j.value,'$[2]') AS bytes FROM json_each(?1) j)
    UPDATE embedding_hubness_members SET page_id=?4,page_offset=v.at,page_length=v.bytes,vector='' FROM v
    WHERE embedding_hubness_members.project_id=?2 AND embedding_hubness_members.model_key=?3 AND embedding_hubness_members.id=v.id
      AND embedding_hubness_members.state=${MEMBER.settled} AND embedding_hubness_members.page_id IS NULL
      AND ${writingPage('?4', '?2', '?3', '?6')} AND ${holds('?2', '?5')}` });
/** Advances the token for a seal this transaction is making, ahead of the seal itself. */
const moveSealing = write<[string, string, number, string, string], { project_id: string }>({ name: 'calibration.moveSealing',
  sql: `UPDATE embedding_cursors SET hubness_token=lower(hex(randomblob(8))) WHERE project_id=?1 AND ${writingPage('?3', '?1', '?4', '?5')} AND ${holds('?1', '?2')} RETURNING project_id` });
/** Seals the page last: the fence row opened for this token stands, while the cursor has already moved on from it. */
const sealPage = write<[number, string, string, string, string], { page_id: number }>({ name: 'calibration.sealPage',
  sql: `UPDATE embedding_vector_pages SET state=${VECTOR_PAGE.sealed} WHERE page_id=?1 AND project_id=?2 AND model_key=?3 AND object_key=?4 AND state=${VECTOR_PAGE.writing}
    AND EXISTS (SELECT 1 FROM embedding_hubness_commits c WHERE c.project_id=?2 AND c.token IS ?5) RETURNING page_id` });
const publishStatistics = write<[string, string, string, string]>({ name: 'calibration.publishStatistics',
  sql: `WITH ${CARRIED} UPDATE embedding_receipts SET neighbor_mean=v.neighbor_mean,neighbor_std=v.neighbor_std FROM v
    WHERE embedding_receipts.project_id=?2 AND embedding_receipts.model_key=?3 AND embedding_receipts.id=v.id
      AND (embedding_receipts.neighbor_mean,embedding_receipts.neighbor_std) IS NOT (v.neighbor_mean,v.neighbor_std) AND ${holds('?2', '?4')}` });

/** Writes one fenced operation takes. Every one holds only while the step's fence does. */
export const calibrationWrites = {
  addJoiner: (projectId: string, model: string, id: string, vector: string, token: string) => addJoiner.bind(projectId, model, id, vector, token),
  clearRewrites: (projectId: string, model: string, ids: readonly string[], token: string) => clearRewrites.bind(projectId, model, JSON.stringify(ids), token),
  requeueLost: (projectId: string, model: string, ids: readonly string[], lostBefore: number, token: string) => requeueLost.bind(projectId, model, JSON.stringify(ids), lostBefore, token),
  markLeaving: (projectId: string, model: string, ids: readonly string[], token: string) => markLeaving.bind(projectId, model, JSON.stringify(ids), token),
  settleJoiners: (projectId: string, model: string, token: string) => settleJoiners.bind(projectId, model, token),
  retireLeavers: (projectId: string, model: string, token: string) => retireLeavers.bind(projectId, model, token),
  dropModelPage: (projectId: string, model: string, limit: number, token: string) => dropModelPage.bind(projectId, model, limit, token),
  carryMoments: (projectId: string, model: string, token: string, rows: readonly MemberMoments[]) => carry.bind(JSON.stringify(rows.map(r => [r.id, r.n, r.mean, r.m2])), projectId, model, token),
  publishStatistics: (projectId: string, model: string, token: string, rows: ReadonlyArray<readonly [string, number, number, number, number | null, number | null]>) =>
    publishStatistics.bind(JSON.stringify(rows), projectId, model, token),
};

/** A Project's spore vectors under one model left out of calibration while the vector store does not return them. */
export interface MissingSporeVectors {
  /** Being written again, or due to be. */
  rewriting: number;
  /** Written again, and waited on for `VECTOR_LOST_MS` from that write. */
  waiting: number;
  /** Written again `VECTOR_REWRITE_LIMIT` times and still not returned; no longer written again. */
  abandoned: number;
}

/** The most left-out receipts one report reads, so a report costs the same however many vectors are left out. */
export const MISSING_REPORT_LIMIT = 200;
/** Left-out vectors come from maintained membership: a stale receipt is in neither arm, so a retirement backlog costs nothing here. */
const missingCounts = read<[number, string, string, number], MissingSporeVectors>({ name: 'calibration.missingCounts',
  sql: `SELECT COALESCE(SUM(s.rewritten=1 OR (s.updated_at<=?1 AND s.rewrites<${VECTOR_REWRITE_LIMIT})),0) AS rewriting,
      COALESCE(SUM(s.rewritten=0 AND s.updated_at>?1),0) AS waiting,
      COALESCE(SUM(s.rewritten=0 AND s.updated_at<=?1 AND s.rewrites>=${VECTOR_REWRITE_LIMIT}),0) AS abandoned
    FROM (SELECT 1 AS rewritten,0 AS updated_at,0 AS rewrites FROM (SELECT 1 FROM embedding_source_state INDEXED BY idx_embedding_source_rewriting
        WHERE project_id=?2 AND model_key=?3 AND type='${SOURCE_TYPE}' AND state='rewriting' LIMIT ?4)
      UNION ALL SELECT 0,updated_at,rewrites FROM (SELECT updated_at,rewrites FROM embedding_calibration_state INDEXED BY idx_embedding_calibration_left_out
        WHERE project_id=?2 AND model_key=?3 AND kind='${KIND}' AND is_current=1 AND rewrites>0
          AND epoch=COALESCE((SELECT e.epoch FROM embedding_models e WHERE e.project_id=?2 AND e.model_key=?3),0) LIMIT ?4)
      LIMIT ?4) s` });

/** Both arms name every left-out vector only once their projections have caught up, no reset is retiring, and the model is active and initialized; a model with no row and no receipts has nothing left out. */
const missingReady = read<[string, string], { ready: number }>({ name: 'calibration.missingReady',
  sql: `SELECT COALESCE((SELECT MIN(done) FROM projection_catchup WHERE projection='embedding_calibration'),0)=1
      AND COALESCE((SELECT done FROM projection_catchup WHERE projection='embedding_state' AND phase='versions'),0)=1
      AND NOT (EXISTS(SELECT 1 FROM embedding_resets WHERE project_id=?1) AND EXISTS(SELECT 1 FROM projection_catchup WHERE projection='embedding_reset' AND done=0))
      AND COALESCE((SELECT active=1 AND complete=1 FROM embedding_models WHERE project_id=?1 AND model_key=?2),
        NOT EXISTS(SELECT 1 FROM embedding_receipts WHERE project_id=?1 AND model_key=?2))=1 AS ready` });

/**
 * How many of a Project's spore vectors under `model` are left out of calibration, and why, counting at most
 * `MISSING_REPORT_LIMIT` of them. Null while the maintained membership cannot say yet: never a zero that means "not counted".
 */
export async function missingSporeVectors(db: RelationalStore, projectId: string, model: string, now: number): Promise<MissingSporeVectors | null> {
  const [ready, rows] = await readSet(db, missingReady.bind(projectId, model), missingCounts.bind(now - VECTOR_LOST_MS, projectId, model, MISSING_REPORT_LIMIT));
  if (ready[0]?.ready !== 1) return null;
  return rows[0] ?? { rewriting: 0, waiting: 0, abandoned: 0 };
}

const coveredIds = read<[string, string, number], { id: string }>({ name: 'calibration.coveredIds',
  sql: `SELECT id FROM embedding_calibration_state WHERE project_id=?1 AND model_key=?2 AND epoch=?3 AND kind='${KIND}' AND is_current=1 AND rewrites=0 ORDER BY id` });

/** The spore vectors calibration covers under `model`, in id order. */
export async function currentSporeVectorIds(db: RelationalStore, projectId: string, model: string): Promise<string[]> {
  const { epoch } = await calibrationPopulation(db, projectId, model);
  const [rows] = await readSet(db, coveredIds.bind(projectId, model, epoch));
  return rows.map(row => row.id);
}

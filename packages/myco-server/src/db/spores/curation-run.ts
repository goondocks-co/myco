import type { RelationalStore } from '../../core/adapters.js';
import { curationDueWorkSql } from '../runs/pull-policy.js';
import { assertion, commit, first, read, readSet, refusalCode, refusalDetail, refused, rows, write, type Bound } from '../index.js';
import { sporeReadStatement, type SporeWithSource } from './records.js';
import { CURATION_CLUSTER_CAP } from '../../core/spore-curation-contract.js';
import type { CurationMember, CurationWork } from './curation-work.js';

/** What one curation run reads and writes: its whole-read ledger, its write receipts, and the admission that binds each decision to the revisions it read. */
const CURATION_OWNED = refusalCode('myco_curation_owned');
const CURATION_CHANGED = refusalCode('myco_curation_changed');

export const curationOwnedRefused = (error: unknown): boolean => refused(error, CURATION_OWNED);

/** What changed after the run read it, in words a refusal can carry; null when `error` is not this refusal. */
export function curationChangedReason(error: unknown): string | null {
  const detail = refusalDetail(error, CURATION_CHANGED);
  if (detail === null) return null;
  if (detail === '' || detail === 'group') return 'the curation decision is closed or its final group changed';
  const [problem, status, current, readRevision, ...id] = detail.split(':') as [string, string, string, string, ...string[]];
  const name = JSON.stringify(id.join(':'));
  if (problem === 'unread') return `spore ${name} has not been read whole by this run at revision ${readRevision}`;
  if (problem === 'owned') return `spore ${name} is owned by another open group`;
  return status === '' ? `spore ${name} no longer exists; this run read revision ${readRevision}` : `spore ${name} is ${status} at revision ${current}; this run read revision ${readRevision}`;
}

/** One candidate's place in the run's ledger. */
interface CurationCandidate { id: string; revision: number; read: number }

const candidatesByIds = read<[project: string, run: string, ids: string], CurationCandidate>({
  name: 'curationRun.candidatesByIds',
  sql: `SELECT spore_id AS id,revision,read FROM spore_curation_candidates WHERE project_id=?1 AND run_id=?2 AND spore_id IN (SELECT value FROM json_each(?3))`,
});
/** The ledger rows of the named spores, keyed by spore. */
export async function readCurationCandidates(db: RelationalStore, project: string, run: string, ids: readonly string[]): Promise<Map<string, CurationCandidate>> {
  if (ids.length === 0) return new Map();
  return new Map((await rows(db, candidatesByIds.bind(project, run, JSON.stringify(ids)))).map(candidate => [candidate.id, candidate]));
}

const readMembers = read<[project: string, run: string], CurationMember>({ name: 'curationRun.readMembers', sql: 'SELECT spore_id AS id,revision FROM spore_curation_candidates WHERE project_id=?1 AND run_id=?2 AND read=1' });
const candidateRow = read<[project: string, run: string, id: string], CurationCandidate>({ name: 'curationRun.candidate', sql: 'SELECT spore_id AS id,revision,read FROM spore_curation_candidates WHERE project_id=?1 AND run_id=?2 AND spore_id=?3' });
const ownerElsewhere = read<[project: string, id: string, key: string], { one: number }>({ name: 'curationRun.ownerElsewhere', sql: 'SELECT 1 AS one FROM spore_curation_owners WHERE project_id=?1 AND spore_id=?2 AND cluster_key<>?3' });
const workRow = read<[project: string, key: string], CurationWork>({ name: 'curationRun.work', sql: 'SELECT * FROM spore_curation_work WHERE project_id=?1 AND cluster_key=?2' });

interface CurationMaterialState {
  work: CurationWork | null;
  candidate: CurationCandidate | null;
  ownedElsewhere: boolean;
  read: CurationMember[];
  spore: SporeWithSource | null;
}

/** Everything one whole read decides from, in one batch. */
export async function readCurationMaterialState(db: RelationalStore, request: { project: string; run: string; key: string; id: string }): Promise<CurationMaterialState> {
  const { project, run, key, id } = request;
  const [work, candidate, owner, members, spore] = await readSet(db, workRow.bind(project, key), candidateRow.bind(project, run, id), ownerElsewhere.bind(project, id, key), readMembers.bind(project, run), sporeReadStatement(project, id));
  return { work: work[0] ?? null, candidate: candidate[0] ?? null, ownedElsewhere: owner.length > 0, read: members, spore: spore[0] ?? null };
}

const stillUnowned = assertion<[project: string, id: string, key: string]>({
  name: 'curationRun.materialUnowned',
  refusal: CURATION_OWNED,
  when: 'NOT EXISTS (SELECT 1 FROM spore_curation_owners WHERE project_id=?1 AND spore_id=?2 AND cluster_key<>?3)',
});
const materialAdmitted = assertion<[project: string, key: string, run: string, bytes: number, limit: number, id: string, cap: number, revision: number]>({
  name: 'curationRun.materialAdmitted',
  refusal: CURATION_CHANGED,
  when: `EXISTS (SELECT 1 FROM spore_curation_work WHERE project_id=?1 AND cluster_key=?2 AND run_id=?3 AND decision IS NULL AND final_members IS NULL AND read_bytes+?4<=?5)
    AND EXISTS (SELECT 1 FROM spore_curation_candidates WHERE project_id=?1 AND run_id=?3 AND spore_id=?6 AND read=0)
    AND (SELECT COUNT(*) FROM spore_curation_candidates WHERE project_id=?1 AND run_id=?3 AND read=1)<?7
    AND EXISTS (SELECT 1 FROM spores WHERE project_id=?1 AND id=?6 AND revision=?8 AND status='active')`,
});
const addBytes = write<[bytes: number, project: string, key: string]>({ name: 'curationRun.addBytes', sql: 'UPDATE spore_curation_work SET read_bytes=read_bytes+?1 WHERE project_id=?2 AND cluster_key=?3' });
const markRead = write<[project: string, run: string, id: string]>({ name: 'curationRun.markRead', sql: 'UPDATE spore_curation_candidates SET read=1 WHERE project_id=?1 AND run_id=?2 AND spore_id=?3' });

/** Reserves one whole read, bound to the revision served; refuses with a named reason and writes nothing when the state behind that decision has moved. */
export async function commitCurationRead(db: RelationalStore, request: { project: string; run: string; key: string; id: string; revision: number; bytes: number; limit: number }): Promise<void> {
  const { project, run, key, id, revision, bytes, limit } = request;
  await commit(db, stillUnowned.bind(project, id, key), materialAdmitted.bind(project, key, run, bytes, limit, id, CURATION_CLUSTER_CAP, revision), addBytes.bind(bytes, project, key), markRead.bind(project, run, id));
}

type DecisionSlots = [project: string, run: string, key: string, members: string, resolved: number, requireEvent: number, selected: string | null, pending: string | null, ignorePending: number];

const RUN_EVENT = `EXISTS (SELECT 1 FROM resolution_events e INDEXED BY idx_curation_resolution_author WHERE e.project_id=?1 AND e.author=?2 LIMIT 1)`;
const decisionAdmitted = assertion<DecisionSlots>({
  name: 'curationRun.decisionAdmitted',
  refusal: CURATION_CHANGED,
  with: `WITH wanted AS (SELECT json_extract(j.value,'$.id') AS id,json_extract(j.value,'$.revision') AS revision FROM json_each(?4) j),
    checked AS (SELECT w.id,w.revision AS read_revision,s.status,s.revision AS current,CASE
        WHEN s.id IS NULL THEN 'changed'
        WHEN NOT ((s.status='active' AND s.revision=w.revision) OR (?5=1 AND s.revision=w.revision+1 AND EXISTS (
          SELECT 1 FROM resolution_events e INDEXED BY idx_curation_resolution_author WHERE e.project_id=s.project_id AND e.author=?2 AND e.spore_id=s.id
            AND ((e.action='supersede' AND s.status='superseded') OR (e.action='consolidate' AND s.status='consolidated') OR (e.action='obsolete' AND s.status='obsolete'))))) THEN 'changed'
        WHEN NOT EXISTS (SELECT 1 FROM spore_curation_candidates c WHERE c.project_id=?1 AND c.run_id=?2 AND c.spore_id=w.id AND c.revision=w.revision AND c.read=1) THEN 'unread'
        WHEN EXISTS (SELECT 1 FROM spore_curation_owners o WHERE o.project_id=?1 AND o.spore_id=w.id AND o.cluster_key<>?3) THEN 'owned'
      END AS problem FROM wanted w LEFT JOIN spores s ON s.project_id=?1 AND s.id=w.id)`,
  when: `NOT EXISTS (SELECT 1 FROM checked WHERE problem IS NOT NULL)
    AND (?5=0 OR ?6=0 OR ${RUN_EVENT})
    AND EXISTS (SELECT 1 FROM spore_curation_work WHERE project_id=?1 AND cluster_key=?3 AND run_id=?2 AND decision IS NULL AND final_members IS ?7 AND (write_refusal IS ?8 OR ?9=1))`,
  detail: `COALESCE((SELECT problem||':'||COALESCE(status,'')||':'||COALESCE(current,'')||':'||read_revision||':'||id FROM checked WHERE problem IS NOT NULL LIMIT 1),'group')`,
});

interface CurationDecisionGuard {
  project: string;
  run: string;
  key: string;
  members: readonly CurationMember[];
  /** A retained member may instead carry exactly this run's one lifecycle transition and its lineage event. */
  resolved: boolean;
  /** A resolved decision needs at least one lineage event by this run. */
  requireEvent: boolean;
  selected: string | null;
  pending: string | null;
  /** A keep decision may close over a refused lifecycle write. */
  ignorePending: boolean;
}

export const curationDecisionAdmitted = (guard: CurationDecisionGuard): Bound =>
  decisionAdmitted.bind(guard.project, guard.run, guard.key, JSON.stringify(guard.members.map(({ id, revision }) => ({ id, revision }))),
    guard.resolved ? 1 : 0, guard.requireEvent ? 1 : 0, guard.selected, guard.pending, guard.ignorePending ? 1 : 0);

const clearPending = write<[project: string, key: string, run: string, pending: string]>({ name: 'curationRun.clearPending', sql: 'UPDATE spore_curation_work SET write_refusal=NULL WHERE project_id=?1 AND cluster_key=?2 AND run_id=?3 AND write_refusal=?4' });
const fixFinal = write<[members: string, project: string, key: string]>({ name: 'curationRun.fixFinal', sql: 'UPDATE spore_curation_work SET final_members=?1 WHERE project_id=?2 AND cluster_key=?3' });
const holdOwners = write<[project: string, key: string, members: string]>({
  name: 'curationRun.holdOwners',
  sql: `INSERT OR IGNORE INTO spore_curation_owners(project_id,spore_id,cluster_key) SELECT ?1,json_extract(j.value,'$.id'),?2 FROM json_each(?3) j WHERE 1`,
});

/** The statements a lifecycle write commits before its own: the pending mark clears and, for a merge, the final group and its ownership land with it. */
export function curationWriteHolds(request: { project: string; run: string; key: string; pending: string; merge: boolean; members: readonly CurationMember[] }): Bound[] {
  const { project, run, key, pending, merge, members } = request;
  const encoded = JSON.stringify(members);
  return [clearPending.bind(project, key, run, pending), ...(merge ? [fixFinal.bind(encoded, project, key)] : []), holdOwners.bind(project, key, encoded)];
}

const startWrite = write<[pending: string, project: string, run: string], { cluster_key: string }>({
  name: 'curationRun.startWrite',
  sql: 'UPDATE spore_curation_work SET write_refusal=?1 WHERE project_id=?2 AND run_id=?3 AND decision IS NULL AND final_members IS NULL RETURNING cluster_key',
});
const recordRefusalWrite = write<[refusal: string, project: string, run: string, pending: string]>({ name: 'curationRun.recordRefusal', sql: 'UPDATE spore_curation_work SET write_refusal=?1 WHERE project_id=?2 AND run_id=?3 AND write_refusal=?4' });

/** Marks a lifecycle write as in progress; false when the run holds no open assignment without a final group. */
export const startCurationWrite = async (db: RelationalStore, request: { pending: string; project: string; run: string }): Promise<boolean> =>
  await first(db, startWrite.bind(request.pending, request.project, request.run)) !== null;

export const recordCurationRefusal = (db: RelationalStore, request: { refusal: string; project: string; run: string; pending: string }): Promise<unknown> =>
  rows(db, recordRefusalWrite.bind(request.refusal, request.project, request.run, request.pending));

type RunWorkView = Pick<CurationWork, 'decision' | 'final_members' | 'write_refusal'>;
const workByRun = read<[project: string, run: string], RunWorkView>({ name: 'curationRun.workByRun', sql: 'SELECT decision,final_members,write_refusal FROM spore_curation_work WHERE project_id=?1 AND run_id=?2' });
const readCandidatesHeld = read<[project: string, run: string], CurationMember & { status: string | null; currentRevision: number | null }>({
  name: 'curationRun.readCandidates',
  sql: `SELECT c.spore_id AS id,c.revision,s.status,s.revision AS currentRevision FROM spore_curation_candidates c LEFT JOIN spores s ON s.project_id=c.project_id AND s.id=c.spore_id
    WHERE c.project_id=?1 AND c.run_id=?2 AND c.read=1 ORDER BY c.spore_id`,
});
const anyRunEvent = read<[project: string, run: string], { one: number }>({ name: 'curationRun.anyEvent', sql: `SELECT 1 AS one FROM resolution_events WHERE project_id=?1 AND author=?2 LIMIT 1` });

/** The state the next-step guidance is decided from. */
export async function readCurationStep(db: RelationalStore, project: string, run: string) {
  const [held, read, event] = await readSet(db, workByRun.bind(project, run), readCandidatesHeld.bind(project, run), anyRunEvent.bind(project, run));
  return { held: held[0] ?? null, read, resolved: event.length > 0 };
}

const heldFinal = read<[project: string, run: string], { final_members: string | null }>({ name: 'curationRun.heldFinal', sql: 'SELECT final_members FROM spore_curation_work WHERE project_id=?1 AND run_id=?2 AND decision IS NULL' });
export const readCurationFinalGroup = (db: RelationalStore, project: string, run: string) => first(db, heldFinal.bind(project, run));

const runContext = read<[project: string, run: string], { run_context: string | null }>({ name: 'curationRun.runContext', sql: 'SELECT run_context FROM agent_runs WHERE project_id=?1 AND id=?2' });
export const readCurationRunContext = async (db: RelationalStore, project: string, run: string): Promise<string | null> => (await first(db, runContext.bind(project, run)))?.run_context ?? null;

const retiredByRun = read<[project: string, run: string], CurationMember>({
  name: 'curationRun.retired',
  sql: `SELECT c.spore_id AS id,c.revision FROM spore_curation_candidates c WHERE c.project_id=?1 AND c.run_id=?2 AND c.read=1
    AND EXISTS (SELECT 1 FROM resolution_events e WHERE e.project_id=c.project_id AND e.spore_id=c.spore_id AND e.author=c.run_id AND e.action='obsolete')`,
});
export const readCurationRetired = (db: RelationalStore, project: string, run: string): Promise<CurationMember[]> => rows(db, retiredByRun.bind(project, run));

const reserveSearchWrite = write<[project: string, run: string, limit: number], { searches: number }>({
  name: 'curationRun.reserveSearch',
  sql: 'UPDATE spore_curation_work SET searches=searches+1 WHERE project_id=?1 AND run_id=?2 AND decision IS NULL AND searches<?3 RETURNING searches',
});
export const reserveCurationSearch = (db: RelationalStore, project: string, run: string, limit: number) => first(db, reserveSearchWrite.bind(project, run, limit));

const addCandidates = write<[project: string, run: string, spores: string]>({
  name: 'curationRun.addCandidates',
  sql: `INSERT OR IGNORE INTO spore_curation_candidates(project_id,run_id,spore_id,revision) SELECT ?1,?2,json_extract(j.value,'$.id'),json_extract(j.value,'$.revision') FROM json_each(?3) j
    WHERE EXISTS (SELECT 1 FROM spore_curation_work WHERE project_id=?1 AND run_id=?2 AND decision IS NULL)`,
});
export const addCurationCandidates = (db: RelationalStore, project: string, run: string, spores: readonly CurationMember[]): Promise<unknown> =>
  rows(db, addCandidates.bind(project, run, JSON.stringify(spores.map(({ id, revision }) => ({ id, revision })))));

const completedBy = read<[project: string, run: string], { one: number }>({ name: 'curationRun.completedBy', sql: "SELECT 1 AS one FROM spore_curation_work WHERE project_id=?1 AND run_id=?2 AND decision IN ('keep','resolved') AND reason IS NOT NULL LIMIT 1" });
export const curationCompletedBy = async (db: RelationalStore, scope: { projectId: string }, run: { id: string }): Promise<boolean> => await first(db, completedBy.bind(scope.projectId, run.id)) !== null;

const outcomeCounts = read<[project: string, run: string], { action: string; n: number }>({
  name: 'curationRun.outcomeCounts',
  sql: 'SELECT action,COUNT(DISTINCT spore_id) AS n FROM resolution_events INDEXED BY idx_curation_resolution_author WHERE project_id=?1 AND author=?2 GROUP BY action',
});
/** Source transition counts from this run's persisted lifecycle evidence. A run holds at most one cluster, so this read costs at most the cluster cap. */
export async function curationOutcomeCounts(db: RelationalStore, project: string, run: string): Promise<{ obsoleted: number; superseded: number; consolidated: number }> {
  const counted = await rows(db, outcomeCounts.bind(project, run));
  const count = (action: string) => counted.find(row => row.action === action)?.n ?? 0;
  return { obsoleted: count('obsolete'), superseded: count('supersede'), consolidated: count('consolidate') };
}

const dueHead = read<[project: string, now: number], Pick<CurationWork, 'cluster_key' | 'due_at'>>({
  name: 'curationRun.dueHead',
  sql: `SELECT cluster_key,due_at FROM spore_curation_work w INDEXED BY idx_curation_due WHERE ${curationDueWorkSql('?1', '?2')} ORDER BY due_at,cluster_key LIMIT 1`,
});
export const readCurationDueHead = (db: RelationalStore, project: string, now: number) => first(db, dueHead.bind(project, now));

import type { RelationalStore } from '../../core/adapters.js';
import { curationChangeSql } from '../curation-changes.js';
import { commitNamed, first, read, write, type Bound } from '../index.js';

/** One curation assignment: the row a run holds, and the commit that settles it. */
export interface CurationMember { id: string; revision: number }
export interface CurationWork {
  cluster_key: string; members: string; final_members: string | null; read_bytes: number; due_at: number | null;
  failures: number; run_id: string | null; decision: string | null; write_refusal: string | null;
}
export type CurationSeedMember = CurationMember & { closeness: number };

const workRow = read<[project: string, key: string], CurationWork>({ name: 'curation.work', sql: 'SELECT * FROM spore_curation_work WHERE project_id=?1 AND cluster_key=?2' });
export const readCurationWork = (db: RelationalStore, project: string, key: string): Promise<CurationWork | null> => first(db, workRow.bind(project, key));

const WORK_OPEN = `EXISTS (SELECT 1 FROM spore_curation_work WHERE project_id=?1 AND cluster_key=?2 AND decision IS NULL AND run_id IS ?3)`;
type CloseSlots = [project: string, key: string, run: string | null];

const closeReceipts = write<[...CloseSlots, members: string]>({
  name: 'curation.closeReceipts',
  sql: `INSERT INTO spore_curation_receipts(project_id,spore_id,revision,cluster_key)
    SELECT ?1,json_extract(j.value,'$.id'),json_extract(j.value,'$.revision'),?2 FROM json_each(?4) j WHERE ${WORK_OPEN}
    ON CONFLICT(project_id,spore_id) DO UPDATE SET revision=excluded.revision,cluster_key=excluded.cluster_key`,
});
const closeOwners = write<CloseSlots>({ name: 'curation.closeOwners', sql: `DELETE FROM spore_curation_owners WHERE project_id=?1 AND cluster_key=?2 AND ${WORK_OPEN}` });
const closeDirty = write<[...CloseSlots, members: string]>({
  name: 'curation.closeDirty',
  sql: curationChangeSql('?1', `(SELECT COALESCE(MIN(COALESCE(s.updated_at,s.created_at)),0) FROM json_each(?4) j CROSS JOIN spores s ON s.project_id=?1 AND s.id=json_extract(j.value,'$.id'))`, WORK_OPEN).replace(/;$/, ''),
});
const closeWork = write<[decision: string, reason: string, at: number, reviewed: string, project: string, key: string, run: string | null], { cluster_key: string }>({
  name: 'curation.closeWork',
  sql: `UPDATE spore_curation_work SET decision=?1,reason=?2,decided_at=?3,due_at=NULL,final_members=?4,write_refusal=NULL
    WHERE project_id=?5 AND cluster_key=?6 AND decision IS NULL AND run_id IS ?7 RETURNING cluster_key`,
});

export interface CurationClose {
  projectId: string;
  work: Pick<CurationWork, 'cluster_key' | 'run_id' | 'members'>;
  decision: string;
  reason: string;
  now: number;
  /** The final members that take a receipt for this close; a seed left out stays eligible for a later group. */
  reviewed: readonly CurationMember[];
}

/**
 * Settle one assignment. Every statement holds only while the assignment is still open under this run, and the decision lands last, so a close that loses to
 * another moves nothing. A `changed` close marks the Project for rediscovery from the seeds' earliest stamp.
 */
export function curationCloseWrites(close: CurationClose): { receipts: Bound; dirty: Bound[]; owners: Bound; work: Bound<{ cluster_key: string }, 'write'> } {
  const { projectId, work, decision, reason, now, reviewed } = close;
  const key = work.cluster_key, run = work.run_id;
  const encoded = JSON.stringify(reviewed.map(({ id, revision }) => ({ id, revision })));
  return {
    receipts: closeReceipts.bind(projectId, key, run, encoded),
    dirty: decision === 'changed' ? [closeDirty.bind(projectId, key, run, work.members)] : [],
    owners: closeOwners.bind(projectId, key, run),
    work: closeWork.bind(decision, reason, now, encoded, projectId, key, run),
  };
}

/** Whether this close settled the assignment; false when the assignment had already moved on. */
export async function commitCurationClose(db: RelationalStore, close: CurationClose): Promise<boolean> {
  return (await commitNamed(db, curationCloseWrites(close))).work.results.length === 1;
}

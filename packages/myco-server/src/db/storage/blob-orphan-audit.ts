import type { RelationalStore } from '../../core/adapters.js';
import { BLOB_RESERVATION_TTL_MS } from '../../constants.js';
import { assertion, commitNamed, read, readSet, refusalCode, refused, write } from '../index.js';
import { unreferencedAmong } from './blob-held.js';
import { OBJECT_WALK_QUARANTINE_MS } from './object-reconciliation.js';
import { HOLD_OPEN, releaseAgedOrphans, type ObservedOrphan } from './release-queue.js';

/** Blob registrations examined in one audit page. */
export const ORPHAN_AUDIT_PAGE = 8;
/** How long a finished walk of the registered blobs rests before the next one begins. */
export const ORPHAN_AUDIT_REST_MS = 24 * 60 * 60 * 1000;

const moved = refusalCode('orphan_audit_moved');

interface AuditState { cursor_project: string; cursor_key: string; revision: number; armed_at: number; next_pass_at: number; held: number }
const auditState = read<[], AuditState>({ name: 'storage.orphanAuditState', sql:
  `SELECT cursor_project,cursor_key,revision,armed_at,next_pass_at,${HOLD_OPEN} AS held FROM orphan_sweep_state WHERE id=1` });
const auditPage = read<[project: string, key: string, limit: number], { project_id: string; key: string; received_at: number; generation: string | null }>({ name: 'storage.orphanAuditPage', sql:
  'SELECT project_id,key,received_at,generation FROM blobs WHERE (project_id,key)>(?1,?2) ORDER BY project_id,key LIMIT ?3' });
const unchanged = assertion<[revision: number]>({ name: 'storage.orphanAuditHeld', refusal: moved, when: 'EXISTS(SELECT 1 FROM orphan_sweep_state WHERE id=1 AND revision=?1)' });
const advance = write<[project: string, key: string, nextPass: number]>({ name: 'storage.advanceOrphanAudit', sql:
  'UPDATE orphan_sweep_state SET cursor_project=?1,cursor_key=?2,next_pass_at=?3,revision=revision+1 WHERE id=1' });
const armAudit = write<[now: number]>({ name: 'storage.armOrphanAudit', sql: 'UPDATE orphan_sweep_state SET armed_at=?1,revision=revision+1 WHERE id=1 AND armed_at=0' });
/** Restarts the audit with its object lifecycle: a restored database audits only what it registers after now. */
const resetAudit = write<[now: number]>({ name: 'storage.resetOrphanAudit', sql:
  "UPDATE orphan_sweep_state SET cursor_project='',cursor_key='',next_pass_at=0,revision=revision+1,armed_at=?1 WHERE id=1" });

/** Restarts the audit against a restored database. */
export async function resetOrphanAudit(db: RelationalStore, now: number): Promise<void> {
  await commitNamed(db, { reset: resetAudit.bind(now) });
}

/**
 * Examines one page of registered blobs for what no row references: an upload whose event never arrived, or anything a
 * deletion should have recorded and did not. Walks every registration from a durable position, then rests.
 *
 * A registration is released only when it arrived after this database armed the audit, its upload grace has passed, and
 * no reference holds it in the commit that decides it; the store delete then waits out a quarantine. Older orphans cost
 * only storage. Answers how many were released.
 */
export async function auditBlobOrphans(db: RelationalStore, now: number): Promise<{ released: number; deferred: number }> {
  const [[state]] = await readSet(db, auditState.bind());
  if (state === undefined) throw new Error('orphan audit position is missing');
  if (state.held === 1 || now < state.next_pass_at) return { released: 0, deferred: 0 };
  // The first audit pass arms the floor: everything this database already holds stays out of its reach.
  if (state.armed_at === 0) { await commitNamed(db, { armed: armAudit.bind(now) }); return { released: 0, deferred: 0 }; }
  const [page] = await readSet(db, auditPage.bind(state.cursor_project, state.cursor_key, ORPHAN_AUDIT_PAGE));
  const cutoff = now - BLOB_RESERVATION_TTL_MS;
  const aged = page.filter(row => row.received_at >= state.armed_at && row.received_at <= cutoff);
  const unreferenced = await unreferencedAmong(db, aged.map(row => ({ projectId: row.project_id, key: row.key })));
  const generations = new Map(aged.map(row => [JSON.stringify([row.project_id, row.key]), row.generation]));
  const observed: ObservedOrphan[] = unreferenced.map(ref => ({ ...ref, generation: generations.get(JSON.stringify([ref.projectId, ref.key])) ?? null }));
  const walked = page.length < ORPHAN_AUDIT_PAGE;
  const last = page.at(-1);
  try {
    const outcome = await releaseAgedOrphans(db, observed, now, cutoff, { deleteDueAt: now + OBJECT_WALK_QUARANTINE_MS, fence: unchanged.bind(state.revision) });
    await commitNamed(db, {
      unchanged: unchanged.bind(state.revision),
      advance: walked ? advance.bind('', '', now + ORPHAN_AUDIT_REST_MS) : advance.bind(last!.project_id, last!.key, 0),
    });
    return outcome;
  } catch (error) {
    if (refused(error, moved)) return { released: 0, deferred: 0 };
    throw error;
  }
}

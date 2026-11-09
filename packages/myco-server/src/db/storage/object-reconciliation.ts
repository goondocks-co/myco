import type { ContentStore, ListedObject } from '../../core/adapters.js';
import { blobObjectName } from '../../core/blob-objects.js';
import { vectorPageProject } from '../../core/embedding/vector-pages.js';
import { BLOB_RESERVATION_TTL_MS } from '../../constants.js';
import { assertion, commitNamed, read, readSet, refusalCode, refused, write } from '../index.js';
import { blobHeld } from './blob-held.js';
import { objectJournalSql } from './object-journal.js';
import { HOLD_OPEN, RELEASE_PAGE, releaseAgedOrphans, type ObservedOrphan } from './release-queue.js';

/** How long a finished walk of the store rests before the next one begins. */
export const OBJECT_RECONCILE_PASS_MS = 6 * 60 * 60 * 1000;
/** How long an object the walk finds waits in the release journal before its store delete, so a database rolled back over its own store has a way back. */
export const OBJECT_WALK_QUARANTINE_MS = 24 * 60 * 60 * 1000;

const cursorMoved = refusalCode('object_store_reconciliation_moved');

/** A named blob object as one JSON element; a legacy object's generation is null. */
interface ListedBlob { x: string; p: string; k: string; g: string | null }

const LISTED = `(SELECT json_extract(j.value,'$.x') AS x,json_extract(j.value,'$.p') AS p,json_extract(j.value,'$.k') AS k,json_extract(j.value,'$.g') AS g FROM json_each(?1) j)`;

const walkState = read<[], { after_key: string; next_pass_at: number; revision: number; armed_at: number; held: number }>({ name: 'storage.objectStoreWalk', sql:
  `SELECT after_key,next_pass_at,revision,armed_at,${HOLD_OPEN} AS held FROM object_store_reconciliation WHERE slot=1` });
/** Listed objects a registration still names, aged past the grace, that no surviving row holds. */
const unreferencedRegistered = read<[page: string, cutoff: number], { p: string; k: string; g: string | null }>({ name: 'storage.objectStoreUnreferenced', sql:
  `SELECT c.p,c.k,c.g FROM ${LISTED} c JOIN blobs b ON b.project_id=c.p AND b.key=c.k
    WHERE b.generation IS c.g AND b.received_at<=?2 AND NOT (${blobHeld('c.p', 'c.k')})` });
const unchanged = assertion<[revision: number]>({ name: 'storage.objectStoreWalkHeld', when: 'EXISTS(SELECT 1 FROM object_store_reconciliation WHERE slot=1 AND revision=?1)', refusal: cursorMoved });
/** A blob object in a known Project that no row, upload or unresolved PUT owns: nothing can adopt it now, so it goes to the release journal. */
const journalOwnerless = write<[page: string, deleteDueAt: number], { physical: string }>({ name: 'storage.journalOwnerlessObjects', sql:
  `${objectJournalSql(`SELECT c.x,'upload',?2 FROM ${LISTED} c WHERE NOT ${HOLD_OPEN}
    AND EXISTS(SELECT 1 FROM projects p WHERE p.project_id=c.p)
    AND NOT EXISTS(SELECT 1 FROM blobs b WHERE b.project_id=c.p AND b.key=c.k AND b.generation IS c.g)
    AND NOT EXISTS(SELECT 1 FROM blob_reservations r WHERE r.reservation_id=c.g)
    AND NOT EXISTS(SELECT 1 FROM object_settlement_intents i WHERE i.physical=c.x)`)} RETURNING physical` });
/** A vector page object of a known Project that no page row names: its writer is gone and nothing can adopt it now. */
const journalPages = write<[page: string, deleteDueAt: number], { physical: string }>({ name: 'storage.journalOwnerlessVectorPages', sql:
  `${objectJournalSql(`SELECT c.x,'upload',?2 FROM ${LISTED} c WHERE NOT ${HOLD_OPEN}
    AND EXISTS(SELECT 1 FROM projects p WHERE p.project_id=c.p)
    AND NOT EXISTS(SELECT 1 FROM embedding_vector_pages v WHERE v.object_key=c.x)`)} RETURNING physical` });
const advance = write<[after: string, nextPass: number]>({ name: 'storage.advanceObjectStoreWalk', sql:
  'UPDATE object_store_reconciliation SET after_key=?1,next_pass_at=?2,revision=revision+1 WHERE slot=1' });

/** Resets the walk with its object lifecycle: a restored database walks its destination store from the start and owns only what lands after now. */
export const resetObjectStoreWalk = write<[now: number]>({ name: 'storage.resetObjectStoreWalk', sql:
  "UPDATE object_store_reconciliation SET after_key='',next_pass_at=0,revision=revision+1,armed_at=?1 WHERE slot=1" });

const listedBlob = (object: ListedObject): ListedBlob | null => {
  const name = blobObjectName(object.key);
  return name === null ? null : { x: object.key, p: name.projectId, k: name.key, g: name.generation };
};
const listedPage = (object: ListedObject): { x: string; p: string } | null => {
  const project = vectorPageProject(object.key);
  return project === null ? null : { x: object.key, p: project };
};

/** What one page of the walk released or journaled. */
export interface WalkReport {
  /** Registered blobs with no reference, released with their rows. */
  released: number;
  /** Blob objects no row, upload or intent owns, journaled for their store delete. */
  ownerless: number;
  /** Vector pages no page row names, journaled for their store delete. */
  vectorPages: number;
}

const NOTHING: WalkReport = { released: 0, ownerless: 0, vectorPages: 0 };

/**
 * Walks one page of the object store from its durable position.
 *
 * An object is released only when nothing owns it, its upload grace has passed, it landed after this database took
 * ownership of the store, and the batch that decides it says so against the rows as they stand. A listing is older than
 * that batch; it never decides. A database that never claimed a store therefore releases nothing from it. An object not
 * of a shape this Deployment writes (a backup, staging) is never read back as anything to release. Objects the listing
 * shows young, or that an owner still holds, are revisited by the next pass, so an object that lands late is found later
 * still. What the walk finds waits out `OBJECT_WALK_QUARANTINE_MS` in the journal before any store delete.
 */
export async function reconcileStoredObjects(env: Pick<ContentStore, 'db' | 'blobs'>, now: number): Promise<WalkReport> {
  const [[state]] = await readSet(env.db, walkState.bind());
  if (state === undefined || state.held === 1 || now < state.next_pass_at) return NOTHING;
  const listing = await env.blobs.list({ limit: RELEASE_PAGE, ...(state.after_key === '' ? {} : { startAfter: state.after_key }) });
  const cutoff = now - BLOB_RESERVATION_TTL_MS;
  const deleteDueAt = now + OBJECT_WALK_QUARANTINE_MS;
  const decidable = listing.objects.filter(object => {
    const uploaded = object.uploaded.getTime();
    return uploaded >= state.armed_at && uploaded <= cutoff;
  });
  const blobs = JSON.stringify(decidable.flatMap(object => listedBlob(object) ?? []));
  const pages = JSON.stringify(decidable.flatMap(object => listedPage(object) ?? []));

  const [unreferenced] = await readSet(env.db, unreferencedRegistered.bind(blobs, cutoff));
  const observed: ObservedOrphan[] = unreferenced.map(row => ({ projectId: row.p, key: row.k, generation: row.g }));
  const walked = !listing.truncated || listing.objects.length === 0;
  let released = 0;
  try {
    ({ released } = await releaseAgedOrphans(env.db, observed, now, cutoff, { deleteDueAt, fence: unchanged.bind(state.revision) }));
    const { ownerless, vectorPages } = await commitNamed(env.db, {
      unchanged: unchanged.bind(state.revision),
      ownerless: journalOwnerless.bind(blobs, deleteDueAt),
      vectorPages: journalPages.bind(pages, deleteDueAt),
      advanced: advance.bind(walked ? '' : listing.objects.at(-1)!.key, walked ? now + OBJECT_RECONCILE_PASS_MS : 0),
    });
    return { released, ownerless: ownerless.results.length, vectorPages: vectorPages.results.length };
  } catch (error) {
    if (refused(error, cursorMoved)) return { ...NOTHING, released };
    throw error;
  }
}

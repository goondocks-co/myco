import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { RESTORE_START, restorePass, type RestoreOptions, type RestoreOutcome } from '@myco-server-worker/core/backup.js';
import { restoreDocuments } from '@myco-server-worker/ingest/document-restore.js';

/**
 * One artifact's rows written in one call, walked from its start to its end in a single unbounded pass. For tests whose
 * subject is what a table holds after the rows land, not the restore an owner runs; a test about a restore uses
 * `restoreThroughJob`.
 */
export async function restoreArtifact(db: RelationalStore, opts: RestoreOptions): Promise<RestoreOutcome> {
  const documents = opts.documents ?? (opts.blobs === undefined ? undefined : restoreDocuments({ db, blobs: opts.blobs }));
  return (await restorePass(db, { ...opts, documents }, { from: RESTORE_START, rows: Number.POSITIVE_INFINITY, admitted: false })).outcome;
}

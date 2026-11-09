import { advanceRereads, requestReread, rereadJob, type RereadSelector } from '@myco-server-worker/db/documents/reread.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';

/** Runs every reread job forward until none has work left. */
export async function drainRereads(db: RelationalStore, now = Date.now()): Promise<void> {
  for (let wake = 0; wake < 10_000; wake += 1) {
    if (!(await advanceRereads(db, now)).more) return;
  }
  throw new Error('transcript reread did not settle');
}

/** Requests a reread and runs its job to the end, answering how many transcripts it rewound. */
export async function rereadTranscripts(db: RelationalStore, selector: RereadSelector, now = Date.now()): Promise<number> {
  const job = await requestReread(db, selector, 'test-owner', now);
  await drainRereads(db, now);
  return (await rereadJob(db, job.id))!.rewound;
}

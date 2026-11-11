import type { RelationalStore } from './adapters.js';
import { refused } from '../db/index.js';
import { boundWriteGuardStore } from '../db/kernel/guarded-store.js';
import { liveRunWrite, RUN_WRITE_EXPIRED } from '../db/runs/live-run-write.js';
import { type RunCaller } from '../db/runs/lifecycle.js';

export class RunWriteExpired extends Error {
  constructor() { super('credential holds no live run'); }
}

/** Run mutations and their authority assertions commit in one atomic store batch, checked before and after the writes. */
export function runWriteStore(db: RelationalStore, projectId: string, runId: string, caller: RunCaller): RelationalStore {
  const assertion = () => liveRunWrite(projectId, runId, caller);
  return boundWriteGuardStore(db, assertion, error => {
    if (refused(error, RUN_WRITE_EXPIRED)) throw new RunWriteExpired();
    throw error;
  }, { after: () => [assertion()] });
}

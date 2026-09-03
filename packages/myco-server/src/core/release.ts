/**
 * Releasing what a dispatched run holds once it is terminal.
 *
 * Two callers land a run terminal: the runtime's own status write through the
 * update route, and the stale-run sweep on the tick for a runtime that went
 * away without one. Both release the same two things — the container hold,
 * so the instance drains, and the dispatch-minted credential, which exists for
 * its run alone — through this one function, so a run released by the sweep
 * looks exactly like a run that finished. A run claimed under a person's own
 * credential carries it in the same column; that credential is the person's,
 * and a release leaves it alone.
 */
import type { ServerEnv } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { revokeCredentialOfMember } from '../auth/tokens.js';
import { drainQueue, HARNESS_MEMBER_ID } from './harness.js';

export interface ReleasableRun {
  id: string;
  dispatchedBy: string | null;
}

/**
 * End the run's container hold and revoke its credential. A run a schedule
 * recorded without a credential has nothing to revoke; a hold that has already
 * ended is left to its own deadline.
 */
export async function releaseRun(env: ServerEnv, _scope: ReadScope, run: ReleasableRun, now: number, options: { drain: boolean } = { drain: true }): Promise<void> {
  try { await env.harnessEnd?.(run.id); } catch { /* the hold's own deadline still ends the container */ }
  if (run.dispatchedBy !== null) await revokeCredentialOfMember(env.db, HARNESS_MEMBER_ID, run.dispatchedBy, now);
  // The capacity this run held is spent at once on the queue; the sweep passes false and leaves it to the tick that runs it.
  if (options.drain) {
    try { await drainQueue(env, now); } catch { /* the next wake drains */ }
  }
}

import { runUpdateStatement, isTerminalRunStatus, type RunCaller, type RunUpdate } from '../db/runs/lifecycle.js';
import { commitRunChange } from '../db/runs/change.js';
import type { RunErrorCode } from './reader-codes.js';
import { emit } from '../telemetry.js';
import type { ServerEnv } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { revokeCredentialOfMemberStatement, revokeCredentialOfMember } from '../auth/tokens.js';
import { drainQueue } from './harness.js';
import { HARNESS_MEMBER_ID } from '../constants.js';

interface ReleasableRun {
  id: string;
  dispatchedBy: string | null;
}

/**
 * End the run's container hold and revoke its credential. A run a schedule
 * recorded without a credential has nothing to revoke; a hold that has already
 * ended is left to its own deadline.
 */
export async function releaseRun(env: ServerEnv, _scope: ReadScope, run: ReleasableRun, now: number, options: { drain: boolean } = { drain: true }): Promise<void> {
  if (run.dispatchedBy !== null) await revokeCredentialOfMember(env.db, HARNESS_MEMBER_ID, run.dispatchedBy, now);
  // The capacity this run held is spent at once on the queue; the sweep passes false and leaves it to the tick that runs it.
  if (options.drain) {
    try { await drainQueue(env, now); } catch { /* the next wake drains */ }
  }
}

/** A runtime ending and retirement of its dispatch credential commit in the same transaction. */
export async function commitRunUpdate(env: ServerEnv, scope: ReadScope, runId: string, update: RunUpdate,
  options: { caller: RunCaller; now: number; errorCode: RunErrorCode; context?: Readonly<Record<string, string>>; replaced?: boolean },
): Promise<number> {
  const statement = runUpdateStatement(env.db, scope, runId, update, undefined, options.errorCode, options.context, options.caller, options.replaced === true && update.status === 'failed');
  if (statement === null) return 0;
  const terminal = isTerminalRunStatus(update.status);
  const { changed, following } = await commitRunChange(env.db, statement, terminal ? [
    revokeCredentialOfMemberStatement(env.db, HARNESS_MEMBER_ID, options.caller.tokenId, options.now, { sql: 'changes() = 1', params: [] }),
  ] : []);
  const retired = following[0];
  if (retired !== undefined) emit({ kind: 'credential_revoked', tokenId: options.caller.tokenId, revokedBy: HARNESS_MEMBER_ID, revoked: retired.results.length === 1 });
  return changed;
}

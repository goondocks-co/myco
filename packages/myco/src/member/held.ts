/**
 * Capture held for a repository that is connected now (#1547): wherever a connection is found, what its hooks held
 * while it had none is moved into the project's spool, so no way of connecting it, and no join that stopped between
 * writing the connection and moving the capture, strands it.
 */
import fs from 'node:fs';
import { rootKeyFor } from './auto-join.js';
import { flushPending, mergeHeldState, pendingDir, pendingRoot } from './pending.js';
import { readSessionStateResult, updateSessionState } from './session-state.js';
import { MemberSpool } from './spool.js';

/** Move what `root`'s hooks held into `projectId`'s spool, when anything is held; how many records moved. */
export function flushHeldCapture(root: string, projectId: string, opts: { mycoHome: string; now: number; deadline?: number }): number {
  // A machine that never held anything has no pending folder, and is asked nothing more.
  if (!fs.existsSync(pendingRoot(opts.mycoHome))) return 0;
  const rootKey = rootKeyFor(root, opts.mycoHome);
  if (!fs.existsSync(pendingDir(rootKey, opts.mycoHome))) return 0;
  return flushPending(rootKey, new MemberSpool(projectId, { mycoHome: opts.mycoHome }), opts);
}

/** Make one held session's receipts available to its next joined hook before the broader replay runs. */
export function restoreHeldReceiptsForHook(root: string, sessionId: string, into: MemberSpool, opts: { mycoHome: string; now: number }): void {
  if (!fs.existsSync(pendingRoot(opts.mycoHome))) return;
  const dir = pendingDir(rootKeyFor(root, opts.mycoHome), opts.mycoHome);
  if (!fs.existsSync(dir)) return;
  const result = readSessionStateResult(dir, sessionId);
  if (!result.ok) {
    if (result.reason !== 'missing') process.stderr.write(`[myco] member: pending receipts ${sessionId} ${result.reason} — kept for helper retry\n`);
    return;
  }
  updateSessionState(into.dir, sessionId, (state) => mergeHeldState(state, result.state), opts.now);
}

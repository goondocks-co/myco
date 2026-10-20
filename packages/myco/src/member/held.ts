/**
 * Capture held for a repository that is connected now (#1547): wherever a connection is found, what its hooks held
 * while it had none is moved into the project's spool, so no way of connecting it, and no join that stopped between
 * writing the connection and moving the capture, strands it.
 */
import fs from 'node:fs';
import type { MemberRoutingIdentity } from './routing.js';
import { flushPendingForRoot, heldSessionStates, pendingRoot } from './pending.js';
import { reconcileSessionState } from './session-reconcile.js';
import { replaceSessionState, updateSessionState } from './session-state.js';
import { MemberSpool } from './spool.js';

/** Move what `root`'s hooks held for this Deployment into its Project spool; return the record count. */
export function flushHeldCapture(root: string, route: MemberRoutingIdentity, opts: { mycoHome: string; now: number; deadline?: number }): number {
  // A machine that never held anything has no pending folder, and is asked nothing more.
  if (!fs.existsSync(pendingRoot(opts.mycoHome))) return 0;
  return flushPendingForRoot(root, new MemberSpool(route, { mycoHome: opts.mycoHome }), opts);
}

/** Make one held session's receipts available to its next joined hook before the broader replay runs. */
export function restoreHeldReceiptsForHook(root: string, sessionId: string, into: MemberSpool, opts: { mycoHome: string; now: number }): void {
  if (!fs.existsSync(pendingRoot(opts.mycoHome))) return;
  if (into.routing === null) throw new Error('Held receipts require a destination');
  for (const held of heldSessionStates(root, into.routing, sessionId, opts.mycoHome)) {
    updateSessionState(into.dir, sessionId, (state) => replaceSessionState(state, reconcileSessionState(state, held).state), opts.now);
  }
}

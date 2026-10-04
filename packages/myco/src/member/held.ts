/**
 * Capture held for a repository that is connected now (#1547): wherever a connection is found, what its hooks held
 * while it had none is moved into the project's spool, so no way of connecting it, and no join that stopped between
 * writing the connection and moving the capture, strands it.
 */
import fs from 'node:fs';
import { rootKeyFor } from './auto-join.js';
import { flushPending, hasPendingCapture, pendingDir, pendingRoot, pendingSpool } from './pending.js';
import { MemberSpool } from './spool.js';

/** Move what `root`'s hooks held into `projectId`'s spool, when anything is held; how many records moved. */
export function flushHeldCapture(root: string, projectId: string, opts: { mycoHome: string; now: number }): number {
  // A machine that never held anything has no pending folder, and is asked nothing more.
  if (!fs.existsSync(pendingRoot(opts.mycoHome))) return 0;
  const rootKey = rootKeyFor(root, opts.mycoHome);
  if (!fs.existsSync(pendingDir(rootKey, opts.mycoHome))) return 0;
  return flushPending(rootKey, new MemberSpool(projectId, { mycoHome: opts.mycoHome }), opts);
}

/** A joined hook keeps using the repository spool while older held capture cannot move. */
export function joinedCaptureHold(root: string, projectId: string, opts: { mycoHome: string; now: number }): {
  repo: { root: string; rootKey: string };
  spool: MemberSpool | null;
} | null {
  if (!fs.existsSync(pendingRoot(opts.mycoHome))) return null;
  const repo = { root, rootKey: rootKeyFor(root, opts.mycoHome) };
  if (!hasPendingCapture(repo.rootKey, opts.mycoHome)) return null;
  flushPending(repo.rootKey, new MemberSpool(projectId, { mycoHome: opts.mycoHome }), opts);
  if (!hasPendingCapture(repo.rootKey, opts.mycoHome)) return null;
  return { repo, spool: pendingSpool(repo, opts) };
}

/**
 * The member helper's sweep (#1561): kick the helper of every other project this home holds undelivered work for.
 *
 * Helpers are per project, and a project's helper starts only on that project's own hooks. A turn whose delivery was
 * cut short (the machine slept or shut down mid-pass, the network dropped) would otherwise wait for its project's
 * next session, which may never come. Every helper run ends with a sweep, so the next hook anywhere on the machine
 * bounds the wait. A project is kicked only while its own offline latch would let it dial, and at most once per
 * `SWEEP_INTERVAL_MS`: a project held on a refusal is not started again on every hook the machine runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { kickHelper, type KickOutcome } from './helper.js';
import { listRoutingEntries, routingKey, type MemberRoutingIdentity } from './routing.js';
import { MemberSpool } from './spool.js';
import type { DetachedSpawn } from '../runtime/spawn-detached.js';

/** The least time between two sweeps' kicks of one project. */
export const SWEEP_INTERVAL_MS = 10 * 60_000;
/** Written in a project's spool when a sweep kicks it: the kick's time, as the file's own. */
export const HELPER_SWEPT_FILE = 'helper.swept';

/** Whether a project's spool holds work no helper has delivered: records in a journal, or transcripts behind. */
function holdsWork(spool: MemberSpool): boolean {
  return spool.sessionIds().length > 0 || spool.transcriptBacklogIds().length > 0;
}

function sweptRecently(spool: MemberSpool, now: number): boolean {
  try {
    const at = fs.statSync(path.join(spool.dir, HELPER_SWEPT_FILE)).mtimeMs;
    return now - at >= 0 && now - at < SWEEP_INTERVAL_MS;
  } catch {
    return false;
  }
}

/** Kick every other project's helper that has work waiting; answers each project kicked, with what its kick did. */
export function kickWaitingProjects(mycoHome: string, self: MemberRoutingIdentity | string, opts: { now?: () => number; spawn?: DetachedSpawn } = {}): Array<{ projectId: string; outcome: KickOutcome }> {
  const now = opts.now ?? Date.now;
  const kicked: Array<{ projectId: string; outcome: KickOutcome }> = [];
  const projects = new Map(listRoutingEntries(mycoHome).map((entry) => [routingKey(entry), entry]));
  for (const [key, route] of projects) {
    if (typeof self !== 'string' && key === routingKey(self)) continue;
    const { projectId, serverUrl } = route;
    const spool = new MemberSpool(route, { mycoHome });
    if (!fs.existsSync(spool.dir) || !holdsWork(spool) || !spool.shouldDial(now(), false) || sweptRecently(spool, now())) continue;
    try {
      fs.writeFileSync(path.join(spool.dir, HELPER_SWEPT_FILE), '', { mode: 0o600 });
      const at = new Date(now());
      fs.utimesSync(path.join(spool.dir, HELPER_SWEPT_FILE), at, at);
    } catch { /* the mark only spares a second kick */ }
    kicked.push({ projectId, outcome: kickHelper({ projectId, serverUrl, mycoHome, reason: 'capture', spawn: opts.spawn, now }) });
  }
  return kicked;
}

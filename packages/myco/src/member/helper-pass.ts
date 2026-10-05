/**
 * One pass of the member helper over a project (`member/helper.ts`): the project's backlog (both lanes), then the
 * context the hooks asked for, then retention. What a detached helper runs, and what a hook that must deliver
 * before it exits runs in its own process (`--ship inline`, or a helper it could not start apart from itself).
 */
import { drainEntryBacklog } from './backlog.js';
import { deadlineBudget, type HookBudget } from './budget.js';
import type { HelperPass } from './helper.js';
import { prefetchContext, watchingFeatures } from './prefetch.js';
import { refreshDue, refreshMembership } from './refresh.js';
import type { RegistryEntry } from './registry.js';
import { applySpoolRetention } from './retention.js';
import { liveRoutingEntry, routingEntry, sameRoutingIdentity, type MemberRoutingIdentity } from './routing.js';
import { MemberSpool } from './spool.js';
import { backfillTranscriptPrompts } from './transcript-prompts.js';
import { ServerClient, type FetchLike } from './transport.js';

/** One pass of the helper over a project, ending by `deadline`: the project's backlog delivered, then its retention. */
export function helperPass(route: MemberRoutingIdentity, mycoHome: string, deps: {
  fetch?: FetchLike; now?: () => number;
  /** Full retained-journal migration is deferred while an inline hook owns the pass. */
  migrateLegacy?: boolean;
  /** The membership to deliver under, for a credential the registry does not hold (a sandbox's environment). */
  entry?: RegistryEntry;
} = {}): HelperPass {
  const now = deps.now ?? Date.now;
  return async (deadline, { force }) => {
    // Roots bound to one Deployment and Project share the same spool.
    const entry = deps.entry ?? routingEntry(route, mycoHome);
    if (entry == null) {
      process.stderr.write(`[myco] helper: this home holds no membership for ${route.serverUrl}/${route.projectId}; nothing to ship\n`);
      return;
    }
    if (!sameRoutingIdentity(entry, route)) throw new Error('Helper membership does not match its destination');
    const spool = new MemberSpool(route, { mycoHome });
    const budget = deadlineBudget(deadline);
    // Every answer the Deployment gives this pass keeps the features the hooks emit by current.
    const fetchImpl = watchingFeatures(deps.fetch ?? globalThis.fetch, { serverUrl: entry.serverUrl, spoolDir: spool.dir, mycoHome, now });
    const prefetch = async () => spool.shouldDial(now(), force)
      ? prefetchContext({ spool, client: new ServerClient(deps.entry === undefined ? await liveEntry(entry, mycoHome, fetchImpl, now, budget) : entry, fetchImpl, { credentialSource: deps.entry === undefined ? 'registry' : 'env' }), serverUrl: entry.serverUrl, mycoHome, budget, now })
      : null;
    // Prompts a harness writes only to its transcript, appended before the drain that delivers them.
    backfillTranscriptPrompts(spool, now);
    const backlog = await drainEntryBacklog(entry, { mycoHome, fetch: fetchImpl, now, budget, force, migrateLegacy: deps.migrateLegacy, rescan: false, newestFirst: true, credentialSource: deps.entry === undefined ? 'registry' : 'env' });
    let prefetched: Awaited<ReturnType<typeof prefetch>> = null;
    try { prefetched = await prefetch(); }
    catch (error) { process.stderr.write(`[myco] helper: context prefetch failed: ${error instanceof Error ? error.message : String(error)}\n`); }
    // Everything delivered (no journal and no transcript left behind): the state of sessions delivered long ago may go.
    const delivered = backlog.endedBy === 'done' && spool.sessionIds().length === 0 && spool.transcriptBacklogIds().length === 0;
    applySpoolRetention(spool, now(), { delivered });
    const shipped = backlog.sessions.reduce((n, s) => n + (s.events?.acked ?? 0) + (typeof s.transcripts === 'object' ? s.transcripts.shipped : 0), 0);
    const context = prefetched === null || prefetched.asked === 0 ? '' : `; context ${prefetched.answered} of ${prefetched.asked} served`;
    process.stderr.write(`[myco] helper: pass over ${backlog.sessions.length} session(s), ${shipped} record(s) and segment(s) delivered${force ? ' (past the offline latch)' : ''}${context}, ended by ${backlog.endedBy}\n`);
    return { more: backlog.endedBy === 'budget' || prefetched?.stoppedBy === 'budget' };
  };
}

/** The membership with its credential renewed first when its window is open, as the backlog's delivery does. */
async function liveEntry(entry: RegistryEntry, mycoHome: string, fetchImpl: FetchLike, now: () => number, budget: HookBudget): Promise<RegistryEntry> {
  if (!refreshDue(entry, now())) return entry;
  await refreshMembership(entry.serverUrl, { mycoHome, fetch: fetchImpl, now, budget, projectId: entry.projectId });
  return liveRoutingEntry(entry, mycoHome);
}

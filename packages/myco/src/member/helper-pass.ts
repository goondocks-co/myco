/**
 * One pass of the member helper over a project (`member/helper.ts`): the context the hooks asked for, then the
 * project's backlog (both lanes), then retention. What a detached helper runs, and what a hook that must deliver
 * before it exits runs in its own process (`--ship inline`, or a helper it could not start apart from itself).
 */
import { drainEntryBacklog } from './backlog.js';
import { deadlineBudget, type HookBudget } from './budget.js';
import type { HelperPass } from './helper.js';
import { prefetchContext, watchingFeatures } from './prefetch.js';
import { refreshDue, refreshMemberCredential } from './refresh.js';
import { listRegistryEntries, readRegistryEntry, type RegistryEntry } from './registry.js';
import { applySpoolRetention } from './retention.js';
import { MemberSpool } from './spool.js';
import { backfillTranscriptPrompts } from './transcript-prompts.js';
import { ServerClient, type FetchLike } from './transport.js';

/** One pass of the helper over a project, ending by `deadline`: the project's backlog delivered, then its retention. */
export function helperPass(projectId: string, mycoHome: string, deps: {
  fetch?: FetchLike; now?: () => number;
  /** The membership to deliver under, for a credential the registry does not hold (a sandbox's environment). */
  entry?: RegistryEntry;
} = {}): HelperPass {
  const now = deps.now ?? Date.now;
  return async (deadline, { force }) => {
    // The project's membership: any root this home connects to it, since every root of one project shares its spool.
    const entry = deps.entry ?? listRegistryEntries(mycoHome).find((candidate) => candidate.projectId === projectId);
    if (entry === undefined) {
      process.stderr.write(`[myco] helper: this home holds no membership for ${projectId}; nothing to ship\n`);
      return;
    }
    const spool = new MemberSpool(projectId, { mycoHome });
    const budget = deadlineBudget(deadline);
    // Every answer the Deployment gives this pass keeps the features the hooks emit by current.
    const fetchImpl = watchingFeatures(deps.fetch ?? globalThis.fetch, { spoolDir: spool.dir, mycoHome, now });
    // The context the hooks asked for first: the next prompt renders it, and capture waits on nothing here.
    const prefetched = spool.shouldDial(now(), force)
      ? await prefetchContext({ spool, client: new ServerClient(await liveEntry(entry, mycoHome, fetchImpl, now, budget), fetchImpl), serverUrl: entry.serverUrl, mycoHome, budget, now })
      : null;
    // Prompts a harness writes only to its transcript, appended before the drain that delivers them.
    backfillTranscriptPrompts(spool, now);
    const backlog = await drainEntryBacklog(entry, { mycoHome, fetch: fetchImpl, now, budget, force, rescan: false, newestFirst: true });
    // Everything delivered (no journal and no transcript left behind): the state of sessions delivered long ago may go.
    const delivered = backlog.endedBy === 'done' && spool.sessionIds().length === 0 && spool.transcriptBacklogIds().length === 0;
    applySpoolRetention(spool, now(), { tried: backlog.tried, delivered });
    const shipped = backlog.sessions.reduce((n, s) => n + (s.events?.acked ?? 0) + (typeof s.transcripts === 'object' ? s.transcripts.shipped : 0), 0);
    const context = prefetched === null || prefetched.asked === 0 ? '' : `; context ${prefetched.answered} of ${prefetched.asked} served`;
    process.stderr.write(`[myco] helper: pass over ${backlog.sessions.length} session(s), ${shipped} record(s) and segment(s) delivered${force ? ' (past the offline latch)' : ''}${context}, ended by ${backlog.endedBy}\n`);
    return { more: backlog.endedBy === 'budget' || prefetched?.stoppedBy === 'budget' };
  };
}

/** The membership with its credential renewed first when its window is open, as the backlog's delivery does. */
async function liveEntry(entry: RegistryEntry, mycoHome: string, fetchImpl: FetchLike, now: () => number, budget: HookBudget): Promise<RegistryEntry> {
  if (!refreshDue(entry, now())) return entry;
  await refreshMemberCredential(entry.root, { mycoHome, fetch: fetchImpl, now, budget });
  return readRegistryEntry(entry.root, mycoHome) ?? entry;
}

/**
 * The member helper's context step (#1561): ask the Deployment what the hooks asked for, and cache the answers they
 * render from (`member/context-cache.ts`).
 *
 * A session start, a compaction or a delegated agent asks for its block: the answer is cached as the Project's block
 * of that kind, which the next such hook renders. A prompt asks with its own text: the answer is cached for the
 * session's next prompt. Each ask names the session that asked, so the Deployment records what it served to which
 * session, binds the repository's remote at a session start, and stamps the turn's start from the prompt's id.
 *
 * A join warms the cache before any session asks (`warmProjectContext`): the Deployment previews the Project's blocks
 * for no session, so the first session after the join is served its whole block.
 *
 * Context requests run on a capped share of the helper's time and are answered `slow` past it, which never latches
 * the Deployment offline (#1559): a capture request decides that. An ask the Deployment answered, or refused for good,
 * is done; one it did not answer stays for the next pass.
 */
import { cacheMachineSettings, machineSettingsHeaders, beginMachineSettingsRequest } from './machine-settings.js';
import { canStartRequest, subRequestBudget, type HookBudget } from './budget.js';
import { FEATURES_HEADER, PROTOCOL_HEADER } from '@goondocks/myco-shared/member-protocol';
import { beginFeatureRequest, featureCacheDiagnostic, cacheDeploymentFeatures, cachedDeploymentFeatures, readProjectContext, removeSessionContext, updateProjectContext, writeSessionContext, type ContextAsk, type SessionBlockKind } from './context-cache.js';
import { refusalPermanent } from './constants.js';
import { gitRemote } from './git-facts.js';
import { readSessionState, updateSessionState } from './session-state.js';
import type { MemberSpool } from './spool.js';
import { classifyEventAnswer, ServerClient, type FetchLike } from './transport.js';
import { deadlineBudget } from './budget.js';
import { spoolDirFor } from './spool.js';

/** The longest one context request may take: the helper is off the hook's path, but a pass still has its deadline. */
export const CONTEXT_CAP_MS = 8_000;

const SESSION_PATH = '/context/session';
const PROMPT_PATH = '/context/prompt';

/** A served block is replaced or withdrawn by these: the Project serves nothing of that kind now. */
const WITHDRAWN = ['capability', 'instructions:off', 'instructions:empty'];

export interface PrefetchReport {
  asked: number;
  answered: number;
  /** Why the step stopped before every ask was made: out of time, or the Deployment did not answer. */
  stoppedBy?: 'budget' | 'unanswered';
}

/**
 * The repository remote a start or a compaction names, asked of git here, in the directory the hook ran in: the hook
 * reads nothing it does not need at once, and git's answer carries its `insteadOf` rewrites, which a read of the
 * repository's own config could not. An ask written before `remoteFrom` carries its remote.
 */
function remoteOf(ask: { remote?: string; remoteFrom?: string }): { remote: string } | Record<string, never> {
  const remote = ask.remote ?? (ask.remoteFrom !== undefined ? gitRemote(ask.remoteFrom) : undefined);
  return remote ? { remote } : {};
}

function requestFor(sessionId: string, ask: ContextAsk): { path: string; body: Record<string, unknown> } {
  switch (ask.kind) {
    case 'start':
      return { path: SESSION_PATH, body: { sessionId, kind: 'start', ...remoteOf(ask) } };
    case 'compact':
      return { path: SESSION_PATH, body: { sessionId, kind: 'compact', compaction: ask.compaction, ...remoteOf(ask) } };
    case 'subagent':
      return { path: SESSION_PATH, body: { sessionId, kind: 'subagent', agentId: ask.agentId, agentType: ask.agentType } };
    case 'prompt':
      return { path: PROMPT_PATH, body: { sessionId, promptId: ask.promptId, text: ask.text } };
  }
}

/** Every session holding an ask, the kicking sessions' oldest asks first. */
function sessionsWithAsks(spool: MemberSpool): Array<{ sessionId: string; asks: ContextAsk[] }> {
  const held: Array<{ sessionId: string; asks: ContextAsk[]; oldest: number }> = [];
  for (const sessionId of spool.stateSessionIds()) {
    const asks = readSessionState(spool.dir, sessionId).contextAsks ?? [];
    if (asks.length > 0) held.push({ sessionId, asks, oldest: Math.min(...asks.map((a) => a.at)) });
  }
  // The newest first: the session someone is typing into now is the one whose next prompt comes soonest.
  return held.sort((a, b) => b.oldest - a.oldest);
}

/** Drop an ask the Deployment has answered; a newer ask of the same kind, written meanwhile, stays. */
function settleAsk(spool: MemberSpool, sessionId: string, ask: ContextAsk, now: number): void {
  updateSessionState(spool.dir, sessionId, (state) => {
    state.contextAsks = (state.contextAsks ?? []).filter((held) => !(held.kind === ask.kind && held.at === ask.at));
    if (state.contextAsks.length === 0) delete state.contextAsks;
  }, now);
}

export async function prefetchContext(opts: {
  spool: MemberSpool; client: ServerClient; serverUrl: string; mycoHome: string; budget: HookBudget; now: () => number;
}): Promise<PrefetchReport> {
  const { spool, client, now } = opts;
  const report: PrefetchReport = { asked: 0, answered: 0 };
  for (const { sessionId, asks } of sessionsWithAsks(spool)) {
    for (const ask of asks) {
      if (!canStartRequest(opts.budget, now())) { report.stoppedBy = 'budget'; return report; }
      const request = requestFor(sessionId, ask);
      const machineOrder = ask.kind === 'prompt' ? undefined : beginMachineSettingsRequest(opts.serverUrl, opts.mycoHome);
      report.asked += 1;
      const answer = classifyEventAnswer(await client.request('POST', request.path, {
        body: JSON.stringify(request.body),
        headers: { 'content-type': 'application/json', ...machineSettingsHeaders(opts.serverUrl, opts.mycoHome) },
        budget: subRequestBudget(opts.budget, CONTEXT_CAP_MS, now()),
      }));
      if (answer.class === 'refused' && refusalPermanent(answer.code)) {
        process.stderr.write(`[myco] helper: context for ${sessionId} (${ask.kind}) refused: ${answer.code}\n`);
        settleAsk(spool, sessionId, ask, now());
        continue;
      }
      if (answer.class !== 'acked') {
        // Not answered now: the ask stays, and so do the rest, for the next pass.
        process.stderr.write(`[myco] helper: context for ${sessionId} (${ask.kind}) not served (${answer.class})\n`);
        report.stoppedBy = 'unanswered';
        return report;
      }
      report.answered += 1;
      const body = answer.body;
      const context = typeof body.context === 'string' ? body.context : '';
      const skipped = Array.isArray(body.skipped) ? body.skipped.filter((s): s is string => typeof s === 'string') : [];
      if (ask.kind === 'prompt') {
        if (context.length > 0) writeSessionContext(spool.dir, opts.mycoHome, sessionId, { version: 1, prompt: { context, promptId: ask.promptId, at: now() } });
        else removeSessionContext(spool.dir, sessionId);
      } else {
        const kind: SessionBlockKind = ask.kind;
        updateProjectContext(spool.dir, opts.mycoHome, (cache) => {
          if (context.length > 0) cache.blocks[kind] = { context, at: now() };
          // A Project that serves this block no more stops serving it here too; a session served before ('repeat')
          // says nothing of the Project.
          else if (skipped.some((s) => WITHDRAWN.includes(s))) delete cache.blocks[kind];
        });
        // The machine's own settings ride a session's answer.
        try { cacheMachineSettings(opts.serverUrl, body.machine, opts.mycoHome, machineOrder); } catch { /* the last cache stands */ }
      }
      settleAsk(spool, sessionId, ask, now());
    }
  }
  return report;
}

/**
 * A fetch that reads the features every Deployment answer advertises (`x-myco-features`) and keeps the Project's
 * cache and the Deployment's feature snapshot current: a feature named is cached, and one no longer named is
 * dropped at once, so a hook stops emitting its records against a Deployment rolled back to before it. Only an answer from the Deployment's own member pipeline
 * (one carrying its protocol header) speaks for it; anything else (an edge's error page, a network failure) says
 * nothing about its features.
 */
export function watchingFeatures(fetchImpl: FetchLike, opts: { serverUrl: string; spoolDir: string; mycoHome: string; now: () => number }): FetchLike {
  return async (input, init) => {
    let receivedAt: number | undefined;
    try { receivedAt = beginFeatureRequest(opts.serverUrl, opts.mycoHome); }
    catch (error) { featureCacheDiagnostic(opts.serverUrl, opts.mycoHome, 'write', error); }
    const res = await fetchImpl(input, init);
    if (receivedAt !== undefined && res.headers.get(PROTOCOL_HEADER) !== null) {
      const features = cachedDeploymentFeatures(res.headers.get(FEATURES_HEADER));
      try {
        if (cacheDeploymentFeatures(opts.serverUrl, features, opts.mycoHome, receivedAt, { spoolDir: opts.spoolDir, at: opts.now() })) {
          featureCacheDiagnostic(opts.serverUrl, opts.mycoHome, 'write');
        }
      } catch (error) {
        featureCacheDiagnostic(opts.serverUrl, opts.mycoHome, 'write', error);
      }
    }
    return res;
  };
}

/** The blocks a join previews: what a session start and a delegated agent render. A compaction falls back to the start's. */
const WARMED: readonly SessionBlockKind[] = ['start', 'subagent'];

/**
 * Cache the Project's blocks for a membership just joined, before any of its sessions asks: the Deployment previews
 * each (`preview`, naming no session, so none is held to have been served it). Only a block this machine does not
 * hold yet is asked for, inside `budget` (the joining hook's own, for a sandbox), each on the capped share a context
 * request gets. An answer not had (a Deployment that predates previews, or one not reached) leaves the block to the
 * first session's own ask. Answers how many blocks were cached.
 */
export async function warmProjectContext(
  membership: { serverUrl: string; token: string; projectId: string },
  opts: { mycoHome: string; fetch?: FetchLike; budget?: HookBudget; now?: () => number },
): Promise<number> {
  const now = opts.now ?? Date.now;
  const spoolDir = spoolDirFor(membership, opts.mycoHome);
  const budget = opts.budget ?? deadlineBudget(now() + WARMED.length * CONTEXT_CAP_MS);
  const fetchImpl = watchingFeatures(opts.fetch ?? globalThis.fetch, { serverUrl: membership.serverUrl, spoolDir, mycoHome: opts.mycoHome, now });
  const client = new ServerClient(membership, fetchImpl);
  let cached = 0;
  for (const kind of WARMED) {
    if (readProjectContext(spoolDir).blocks[kind] !== undefined) continue;
    if (!canStartRequest(budget, now())) break;
    const machineOrder = beginMachineSettingsRequest(membership.serverUrl, opts.mycoHome);
    let answer: ReturnType<typeof classifyEventAnswer>;
    try {
      answer = classifyEventAnswer(await client.request('POST', SESSION_PATH, {
        body: JSON.stringify({ kind, preview: true }),
        headers: { 'content-type': 'application/json', ...machineSettingsHeaders(membership.serverUrl, opts.mycoHome) },
        budget: subRequestBudget(budget, CONTEXT_CAP_MS, now()),
      }));
    } catch {
      break;
    }
    if (answer.class !== 'acked') break;
    const context = typeof answer.body.context === 'string' ? answer.body.context : '';
    if (context.length === 0) continue;
    updateProjectContext(spoolDir, opts.mycoHome, (cache) => { cache.blocks[kind] = { context, at: now() }; });
    try { cacheMachineSettings(membership.serverUrl, answer.body.machine, opts.mycoHome, machineOrder); } catch { /* the last cache stands */ }
    cached += 1;
  }
  return cached;
}

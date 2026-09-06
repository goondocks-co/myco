/**
 * What a hook asks the Deployment to serve it, spent from the hook's own
 * remaining budget.
 *
 * The call takes a third of what the hook has left, capped, so the drain that
 * follows it still ships records rather than spooling the turn whole. Anything
 * short of a served block — no room before the deadline, a timeout, a refusal,
 * an empty answer — answers `undefined` and writes one line to stderr, and the
 * caller keeps whatever response it had already built.
 *
 * The outcome moves the offline latch the way a drain pass does: a dark
 * Deployment is latched here, and an answer clears the latch so the drain that
 * follows is not skipped against a server that has just replied. `runMemberHook`
 * has already checked the latch before the seam runs; this keeps it current for
 * the pass behind it.
 */
import { canStartRequest, subRequestBudget } from './budget.js';
import type { HookRun } from './capture.js';
import { readSessionState, updateSessionState } from './session-state.js';
import { classifyEventAnswer } from './transport.js';
import { sessionInjectionKind, type SessionContextRequest } from '@goondocks/myco-shared/recall';

/** The longest one recall call may take, whatever the hook has left. */
export const RECALL_CAP_MS = 1500;

/** What a recall route answers: the block, the gates that closed, and the record the block burns. */
interface RecallAnswer {
  context: string;
  skipped: string[];
  kind?: string;
}

/**
 * The decisions a session may be told once and remember. A Project not admitted
 * and a record already standing are both settled for the life of the session; a
 * Deployment simply holding nothing yet is not, so a hook asks it again.
 */
const SETTLED: readonly string[] = ['capability', 'repeat'];

async function ask(run: HookRun, path: string, body: Record<string, unknown>): Promise<RecallAnswer | undefined> {
  if (!canStartRequest(run.budget, run.now())) return undefined;
  const answer = classifyEventAnswer(await run.client.request('POST', path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    budget: subRequestBudget(run.budget, RECALL_CAP_MS, run.now()),
  }));
  if (answer.class !== 'acked') {
    if (answer.class === 'retry') run.spool.markOffline(run.now(), answer.retryAfterMs);
    process.stderr.write(`[myco] ${run.hookName}: recall skipped (${answer.class})\n`);
    return undefined;
  }
  run.spool.clearLatch();
  return {
    context: typeof answer.body.context === 'string' ? answer.body.context : '',
    skipped: Array.isArray(answer.body.skipped) ? answer.body.skipped.filter((s): s is string => typeof s === 'string') : [],
    kind: typeof answer.body.kind === 'string' ? answer.body.kind : undefined,
  };
}

export async function servedContext(
  run: HookRun,
  path: string,
  body: Record<string, unknown>,
): Promise<string | undefined> {
  const answer = await ask(run, path, body);
  return answer === undefined || answer.context.length === 0 ? undefined : answer.context;
}

/** The shared receipt identity consulted before spending the hook's request budget. */
export const recallKind = (body: SessionContextRequest): string => sessionInjectionKind(body);

/**
 * What a hook asks the Deployment to serve it once per session.
 *
 * The session's own state is the gate: a symbiont that runs its start hook on
 * every invocation asks the first time and is silent from then on. The kind is
 * marked delivered when a block arrived, and also when the Deployment named a
 * settled decision — a Project not admitted, or a record already standing — so
 * a Deployment that serves this session nothing is asked once rather than on
 * every invocation. A Deployment that was unreachable, or that simply holds no
 * artifact yet, is asked again: what it holds can change within the session.
 *
 * The mark sits here rather than in the hook: it records an answer that has
 * already arrived, and it is written after the seam that carries it, never
 * beside an event still waiting to be appended.
 */
export async function servedOnce(
  run: HookRun,
  path: string,
  body: SessionContextRequest,
): Promise<string | undefined> {
  const local = recallKind(body);
  if (readSessionState(run.spool.dir, run.sessionId).delivered.includes(local)) return undefined;

  const answer = await ask(run, path, body);
  if (answer === undefined) return undefined;

  const served = answer.context.length > 0;
  if (served || answer.skipped.some((s) => SETTLED.includes(s))) {
    const kind = answer.kind ?? local;
    updateSessionState(run.spool.dir, run.sessionId, (state) => {
      if (!state.delivered.includes(kind)) state.delivered.push(kind);
    }, run.now());
  }
  return served ? answer.context : undefined;
}

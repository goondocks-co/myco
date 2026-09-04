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
 * follows is not skipped against a server that has just replied.
 */
import { canStartRequest, subRequestBudget } from './budget.js';
import type { HookRun } from './capture.js';
import { readSessionState, updateSessionState } from './session-state.js';
import { classifyEventAnswer } from './transport.js';

/** The longest one recall call may take, whatever the hook has left. */
export const RECALL_CAP_MS = 1500;

export async function servedContext(
  run: HookRun,
  path: string,
  body: Record<string, unknown>,
): Promise<string | undefined> {
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
  const served = typeof answer.body.context === 'string' ? answer.body.context : '';
  return served.length === 0 ? undefined : served;
}

/**
 * What a hook asks the Deployment to serve it once per session, under `kind`.
 *
 * The session's own state is the gate: a symbiont that runs its start hook on
 * every invocation asks the first time and is silent from then on. The kind is
 * marked delivered only where a block actually arrived, so a Deployment that
 * was unreachable is asked again on the next invocation.
 *
 * The mark sits here rather than in the hook: it records an answer that has
 * already arrived, and it is written after the seam that carries it, never
 * beside an event still waiting to be appended.
 */
export async function servedOnce(
  run: HookRun,
  path: string,
  kind: string,
  body: Record<string, unknown>,
): Promise<string | undefined> {
  if (readSessionState(run.spool.dir, run.sessionId).delivered.includes(kind)) return undefined;
  const served = await servedContext(run, path, body);
  if (served === undefined) return undefined;
  updateSessionState(run.spool.dir, run.sessionId, (state) => {
    if (!state.delivered.includes(kind)) state.delivered.push(kind);
  }, run.now());
  return served;
}

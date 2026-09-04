import { runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { subagentStartEvent } from '../member/envelope.js';
import { servedOnce } from '../member/recall.js';
import { readSessionState } from '../member/session-state.js';
import { HOOK_CONFIG } from './hook-config.generated.js';
import type { HookResponse } from './response.js';

const SESSION_RECALL_PATH = '/context/session';
/** How long a delegated agent's type may be before the body carries a shortened one. */
const MAX_AGENT_TYPE_CHARS = 64;

/** The recall kind one subagent type is served once per session. */
const kindFor = (agentType: string | undefined): string => `cortex:${agentType || 'unknown'}`;

/**
 * The Project's instructions, framed for a delegated agent.
 *
 * Each subagent type of a session is served once: two delegations of the same
 * type share one block, and a session that delegates to two different types
 * serves each of them.
 */
function recall(sessionId: string, agentType: string | undefined) {
  return async (run: HookRun): Promise<HookResponse | undefined> => {
    const served = await servedOnce(run, SESSION_RECALL_PATH, kindFor(agentType), { sessionId, kind: 'subagent', agentType });
    return served === undefined ? undefined : { additionalContext: served };
  };
}

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('subagent-start', opts, (run) => {
    const parentPromptId = readSessionState(run.spool.dir, run.sessionId).promptId;
    const raw = run.input.raw.agent_type;
    const agentType = typeof raw === 'string' && raw.length > 0 ? raw.slice(0, MAX_AGENT_TYPE_CHARS) : undefined;
    // A symbiont whose harness discards a SubagentStart answer is asked for
    // nothing: the call would spend the hook's budget on a block nobody reads.
    const takesInjection = HOOK_CONFIG[run.agent]?.capabilities.subagentStartInjection === true;
    return {
      events: [subagentStartEvent(run.ctx, run.input, { parentPromptId })],
      context: takesInjection ? recall(run.sessionId, agentType) : undefined,
    };
  });
}

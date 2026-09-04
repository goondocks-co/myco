import { runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { subagentStartEvent } from '../member/envelope.js';
import { servedOnce } from '../member/recall.js';
import { readSessionState } from '../member/session-state.js';
import { HOOK_CONFIG } from './hook-config.generated.js';
import type { HookResponse } from './response.js';

const SESSION_RECALL_PATH = '/context/session';
/** How long a delegated agent's id or type may be before the body carries a shortened one. */
const MAX_NAME_CHARS = 64;

const name = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, MAX_NAME_CHARS) : undefined);

/**
 * The Project's instructions, framed for a delegated agent.
 *
 * Every subagent is served: the block is remembered against the delegation's
 * own id, and against its type only where the harness names no id, so two
 * delegations of one type are two subagents rather than one.
 */
function recall(sessionId: string, agentId: string | undefined, agentType: string | undefined) {
  return async (run: HookRun): Promise<HookResponse | undefined> => {
    const served = await servedOnce(run, SESSION_RECALL_PATH, { sessionId, kind: 'subagent', agentId, agentType });
    return served === undefined ? undefined : { additionalContext: served };
  };
}

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('subagent-start', opts, (run) => {
    const parentPromptId = readSessionState(run.spool.dir, run.sessionId).promptId;
    // A symbiont whose harness discards a SubagentStart answer is asked for
    // nothing: the call would spend the hook's budget on a block nobody reads.
    const takesInjection = HOOK_CONFIG[run.agent]?.capabilities.subagentStartInjection === true;
    return {
      events: [subagentStartEvent(run.ctx, run.input, { parentPromptId })],
      context: takesInjection
        ? recall(run.sessionId, name(run.input.raw.agent_id), name(run.input.raw.agent_type))
        : undefined,
    };
  });
}

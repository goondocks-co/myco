import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { subagentStartEvent } from '../member/envelope.js';
import { renderedBlock, type ContextAsk } from '../member/context-cache.js';
import { readSessionState } from '../member/session-state.js';
import { sessionInjectionKind } from '@goondocks/myco-shared/recall';
import { HOOK_CONFIG } from './hook-config.generated.js';
import { transcriptWritesTurnRows } from './turn-rows.js';

/** How long a delegated agent's id or type may be before the ask carries a shortened one. */
const MAX_NAME_CHARS = 64;

const name = (value: unknown): string | undefined =>
  (typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, MAX_NAME_CHARS) : undefined);

/**
 * The Project's instructions, framed for a delegated agent, as this machine holds them.
 *
 * Every subagent is served: the block is remembered against the delegation's own id, and against its type only where
 * the harness names no id, so two delegations of one type are two subagents rather than one.
 */
export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('subagent-start', opts, (run) => {
    const state = readSessionState(run.spool.dir, run.sessionId);
    // A symbiont whose harness discards a SubagentStart answer is served nothing, and nothing is fetched for it.
    const takesInjection = HOOK_CONFIG[run.agent]?.capabilities.subagentStartInjection === true;
    const ask: ContextAsk = { kind: 'subagent', agentId: name(run.input.raw.agent_id), agentType: name(run.input.raw.agent_type), at: run.now() };
    const delivered = sessionInjectionKind(ask);
    // Served once per delegation, and asked for by the delegation that renders it: the Deployment's record of having
    // served it names the session it reached.
    const due = takesInjection && !state.delivered.includes(delivered);
    const served = due ? renderedBlock(run.spool.dir, run.credential.projectId, 'subagent') : undefined;
    // Delivered once the Deployment's block was: a delegation told its Project alone is served the block if it starts again.
    return {
      // The transcript carries the child's own turns for a symbiont that keeps
      // one; the start row would be a second write keyed to a minted parent.
      events: transcriptWritesTurnRows(run.agent) ? [] : [subagentStartEvent(run.ctx, run.input, { parentPromptId: state.promptId })],
      response: served === undefined ? undefined : { additionalContext: served.text },
      ask: due ? ask : undefined,
      record: served?.complete !== true ? undefined : (next) => { if (!next.delivered.includes(delivered)) next.delivered.push(delivered); },
    };
  });
}

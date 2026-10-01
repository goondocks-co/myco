import { runMemberHook, type HookMainOptions, type HookOutcome, type HookRun } from '../member/capture.js';
import { toolUseEvent, type OutboundEvent } from '../member/envelope.js';
import { planFileCapture, planRootFor, planWritePath } from '../member/plan-files.js';
import { renderedBlock } from '../member/context-cache.js';
import { readSessionState, type SessionState } from '../member/session-state.js';
import { sessionInjectionKind } from '@goondocks/myco-shared/recall';
import { HOOK_CONFIG } from './hook-config.generated.js';
import { hookShipsToolCalls, transcriptWritesTurnRows } from './turn-rows.js';

/**
 * The session block, for a harness whose prompt hook can only block: served once per session from what this machine
 * holds, so a session start that had nothing to serve gets a second chance here, and the helper is asked to fetch
 * the block while none has been served.
 */
function sessionBlock(run: HookRun, state: SessionState): Pick<HookOutcome, 'response' | 'ask' | 'record'> {
  const delivered = sessionInjectionKind({ kind: 'start' });
  if (state.delivered.includes(delivered)) return {};
  const block = renderedBlock(run.spool.dir, run.credential.projectId, 'start');
  if (block === undefined) return {};
  return {
    response: { additionalContext: block },
    // Asked for by the session that renders it, once: the Deployment's record of having served it names this session.
    ask: { kind: 'start', at: run.now() },
    record: (next) => { if (!next.delivered.includes(delivered)) next.delivered.push(delivered); },
  };
}

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('post-tool-use', opts, (run) => {
    const { input, sessionId, agent, ctx, spool, credential } = run;
    // A PostToolUse without a tool name is a non-tool step (Antigravity emits them); nothing to record.
    if (typeof input.toolName !== 'string' || input.toolName.length === 0) {
      process.stderr.write(`[myco] post-tool-use dropped (no tool_name) symbiont=${run.agent} session=${sessionId}\n`);
      return { events: [] };
    }
    const state = readSessionState(spool.dir, sessionId);
    // The prompt id names a turn only where the hooks mint it; the Deployment's
    // parse derives its own, which the member cannot know.
    const promptId = transcriptWritesTurnRows(agent) ? undefined : state.promptId;
    // The transcript already holds this call for a symbiont whose transcript carries tool calls.
    const events: OutboundEvent[] = hookShipsToolCalls(agent) ? [toolUseEvent(ctx, input, { promptId })] : [];
    const served = HOOK_CONFIG[agent]?.capabilities.postToolUseInjection === true ? sessionBlock(run, state) : {};
    // A write into a plan directory is the plan itself: read now, keyed by its path, named after the prompt that wrote it.
    const root = planRootFor(credential.root, typeof input.raw.cwd === 'string' ? input.raw.cwd : undefined);
    const planPath = planWritePath(agent, input.toolName, input.toolInput, root, run.machinePlanDirs());
    // A repository still joining has no project to key a plan to; the turn's end reads the write again once it has one.
    if (planPath === null || run.pending === true) return { events, ...served };
    const plan = planFileCapture(ctx, state, credential.projectId, root, planPath, promptId);
    return {
      events: [...events, ...plan.events], response: served.response, ask: served.ask,
      record: (next) => { plan.record(next); served.record?.(next); },
    };
  });
}

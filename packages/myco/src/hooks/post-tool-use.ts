import { runMemberHook, type HookMainOptions, type HookRun } from '../member/capture.js';
import { toolUseEvent, type OutboundEvent } from '../member/envelope.js';
import { planFileCapture, planRootFor, planWritePath } from '../member/plan-files.js';
import { servedOnce } from '../member/recall.js';
import { readSessionState } from '../member/session-state.js';
import { HOOK_CONFIG } from './hook-config.generated.js';
import type { HookResponse } from './response.js';
import { hookShipsToolCalls, transcriptWritesTurnRows } from './turn-rows.js';

const SESSION_RECALL_PATH = '/context/session';

/**
 * The session block, for a harness whose prompt hook can only block: asked for
 * once per session, so a start the Deployment could not answer gets a second
 * chance here and a start it did answer costs nothing more.
 */
function recall(sessionId: string) {
  return async (run: HookRun): Promise<HookResponse | undefined> => {
    const served = await servedOnce(run, SESSION_RECALL_PATH, { sessionId, kind: 'start' });
    return served === undefined ? undefined : { additionalContext: served };
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
    const context = HOOK_CONFIG[agent]?.capabilities.postToolUseInjection === true ? recall(sessionId) : undefined;
    // A write into a plan directory is the plan itself: read now, keyed by its path, named after the prompt that wrote it.
    const root = planRootFor(credential.root, typeof input.raw.cwd === 'string' ? input.raw.cwd : undefined);
    const planPath = planWritePath(agent, input.toolName, input.toolInput, root);
    if (planPath === null) return { events, context };
    const plan = planFileCapture(ctx, state, credential.projectId, root, planPath, promptId);
    return { events: [...events, ...plan.events], record: plan.record, context };
  });
}

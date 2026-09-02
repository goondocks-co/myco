import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
import { toolUseEvent, type OutboundEvent } from '../member/envelope.js';
import { planFileCapture, planWritePath } from '../member/plan-files.js';
import { readSessionState } from '../member/session-state.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('post-tool-use', opts, (run) => {
    const { input, sessionId, agent, ctx, spool, credential } = run;
    // A PostToolUse without a tool name is a non-tool step (Antigravity emits them); nothing to record.
    if (typeof input.toolName !== 'string' || input.toolName.length === 0) {
      process.stderr.write(`[myco] post-tool-use dropped (no tool_name) symbiont=${run.agent} session=${sessionId}\n`);
      return { events: [] };
    }
    const state = readSessionState(spool.dir, sessionId);
    const events: OutboundEvent[] = [toolUseEvent(ctx, input, { promptId: state.promptId })];
    // A write into a plan directory is the plan itself: read now, keyed by its path, named after the prompt that wrote it.
    const root = credential.root ?? resolveMemberProjectRoot(typeof input.raw.cwd === 'string' ? input.raw.cwd : undefined);
    const planPath = planWritePath(agent, input.toolName, input.toolInput, root);
    if (planPath === null) return { events };
    const plan = planFileCapture(ctx, state, credential.projectId, root, planPath);
    return { events: [...events, ...plan.events], record: plan.record };
  });
}

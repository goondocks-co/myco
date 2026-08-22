import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { toolUseEvent } from '../member/envelope.js';
import { readSessionState } from '../member/session-state.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('post-tool-use', opts, (run) => {
    const { input, sessionId, ctx, spool } = run;
    // A PostToolUse without a tool name is a non-tool step (Antigravity emits them); nothing to record.
    if (typeof input.toolName !== 'string' || input.toolName.length === 0) {
      process.stderr.write(`[myco] post-tool-use dropped (no tool_name) symbiont=${run.agent} session=${sessionId}\n`);
      return { events: [] };
    }
    const promptId = readSessionState(spool.dir, sessionId).promptId;
    return { events: [toolUseEvent(ctx, input, { promptId })] };
  });
}

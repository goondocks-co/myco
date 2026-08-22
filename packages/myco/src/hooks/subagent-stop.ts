import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { subagentStopEvent } from '../member/envelope.js';
import { readSessionState } from '../member/session-state.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('subagent-stop', opts, (run) => {
    const parentPromptId = readSessionState(run.spool.dir, run.sessionId).promptId;
    return { events: [subagentStopEvent(run.ctx, run.input, { parentPromptId })] };
  });
}

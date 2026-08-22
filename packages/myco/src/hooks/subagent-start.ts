import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { subagentStartEvent } from '../member/envelope.js';
import { readSessionState } from '../member/session-state.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('subagent-start', opts, (run) => {
    const parentPromptId = readSessionState(run.spool.dir, run.sessionId).promptId;
    return { events: [subagentStartEvent(run.ctx, run.input, { parentPromptId })] };
  });
}

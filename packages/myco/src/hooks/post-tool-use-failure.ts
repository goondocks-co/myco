import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { toolFailureEvent } from '../member/envelope.js';
import { readSessionState } from '../member/session-state.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('post-tool-use-failure', opts, (run) => {
    const promptId = readSessionState(run.spool.dir, run.sessionId).promptId;
    return { events: [toolFailureEvent(run.ctx, run.input, { promptId })] };
  });
}

import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { toolFailureEvent } from '../member/envelope.js';
import { readSessionState } from '../member/session-state.js';
import { hookShipsToolCalls, transcriptWritesTurnRows } from './turn-rows.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('post-tool-use-failure', opts, (run) => {
    // The transcript already holds this failure for a symbiont whose transcript carries tool calls.
    if (!hookShipsToolCalls(run.agent)) return { events: [] };
    const promptId = transcriptWritesTurnRows(run.agent) ? undefined : readSessionState(run.spool.dir, run.sessionId).promptId;
    return { events: [toolFailureEvent(run.ctx, run.input, { promptId })] };
  });
}

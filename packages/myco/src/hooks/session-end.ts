import { hookCwd, runMemberHook, type HookMainOptions } from '../member/capture.js';
import { gitFacts } from '../member/git-facts.js';
import { sessionEndEvent } from '../member/envelope.js';
import { transcriptPhase } from './stop.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('session-end', opts, (run) => {
    const transcript = transcriptPhase(run);
    const git = gitFacts(hookCwd(run.input));
    return {
      events: [sessionEndEvent(run.ctx, { endedAt: run.now(), headSha: git.headSha, dirty: git.dirty }), ...transcript.events],
      record: (state) => {
        transcript.record(state);
        state.endedAt = run.now();
      },
      ends: 'session-end',
    };
  });
}

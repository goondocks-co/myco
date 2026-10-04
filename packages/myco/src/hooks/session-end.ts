import { hookCwd, runMemberHook, type HookMainOptions } from '../member/capture.js';
import { sessionEndGitFacts } from '../member/git-facts.js';
import { sessionEndEvent } from '../member/envelope.js';
import { transcriptPhase } from './stop.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('session-end', opts, (run) => {
    const transcript = transcriptPhase(run);
    const endedAt = run.now();
    return {
      events: [sessionEndEvent(run.ctx, { endedAt }), ...transcript.events],
      record: (state) => {
        transcript.record(state);
        state.endedAt = endedAt;
      },
      optional: async () => {
        const git = await sessionEndGitFacts(hookCwd(run.input), run.budget, run.now());
        return { events: git.headSha === undefined ? [] : [sessionEndEvent(run.ctx, { endedAt, ...git })] };
      },
      transcriptAt: transcript.stoodAt,
      ends: 'session-end',
    };
  });
}

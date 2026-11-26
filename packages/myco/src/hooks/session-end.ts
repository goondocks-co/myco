import { GIT_AT_TURN_END_FEATURE } from '@goondocks/myco-shared/member-protocol';
import { featureAdvertised } from '../member/context-cache.js';
import { gitObservationCwd, runMemberHook, type HookMainOptions } from '../member/capture.js';
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
        const git = await sessionEndGitFacts(gitObservationCwd(run), run.budget, run.now());
        if (git.headSha === undefined) return { events: [] };
        const branch = featureAdvertised(run.credential, run.mycoHome, GIT_AT_TURN_END_FEATURE) ? git.branch : undefined;
        return { events: [sessionEndEvent(run.ctx, { endedAt, headSha: git.headSha, dirty: git.dirty, branch })] };
      },
      transcriptAt: transcript.stoodAt,
      ends: 'session-end',
    };
  });
}

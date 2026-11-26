import { GIT_AT_TURN_END_FEATURE } from '@goondocks/myco-shared/member-protocol';
import { featureAdvertised } from '../member/context-cache.js';
import { captureEndGit, runMemberHook, type HookMainOptions } from '../member/capture.js';
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
      optional: () => {
        const { headSha, branch, gitObservation } = captureEndGit(run);
        if (headSha === undefined) return { events: [] };
        const advertised = featureAdvertised(run.credential, run.mycoHome, GIT_AT_TURN_END_FEATURE);
        return { events: [{ ...sessionEndEvent(run.ctx, { endedAt, headSha, branch: advertised ? branch : undefined }), gitObservation }] };
      },
      transcriptAt: transcript.stoodAt,
      ends: 'session-end',
    };
  });
}

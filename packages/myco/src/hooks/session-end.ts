import { hookCwd, runMemberHook, type HookMainOptions } from '../member/capture.js';
import { gitFacts } from '../member/git-facts.js';
import { SESSION_END_TRANSCRIPT_BUDGET_MS } from '../member/constants.js';
import { sessionEndEvent } from '../member/envelope.js';
import { transcriptPhase } from './stop.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('session-end', opts, (run) => {
    const transcript = transcriptPhase(run);
    const git = gitFacts(hookCwd(run.input));
    return {
      events: [sessionEndEvent(run.ctx, { endedAt: run.now(), headSha: git.headSha, dirty: git.dirty }), ...transcript.events],
      record: transcript.record,
      probe: true,
      // SessionEnd gets a bounded slice of transcript work inside its budget.
      afterDrain: (r) => transcript.afterDrain(r, r.now() + SESSION_END_TRANSCRIPT_BUDGET_MS),
    };
  });
}

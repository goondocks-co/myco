import { hookCwd, runMemberHook, type HookMainOptions } from '../member/capture.js';
import { gitHead, trackedChanges } from '../member/git-facts.js';
import { sessionEndEvent } from '../member/envelope.js';
import { transcriptPhase } from './stop.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('session-end', opts, async (run) => {
    const transcript = transcriptPhase(run);
    // The commit from git's own files; whether tracked files changed is git's to say, its two questions asked at once.
    const cwd = hookCwd(run.input);
    const head = gitHead(cwd);
    const git = { headSha: head.headSha, dirty: head.headSha === undefined ? undefined : await trackedChanges(cwd) };
    return {
      events: [sessionEndEvent(run.ctx, { endedAt: run.now(), headSha: git.headSha, dirty: git.dirty }), ...transcript.events],
      record: (state) => {
        transcript.record(state);
        state.endedAt = run.now();
      },
      transcriptAt: transcript.stoodAt,
      ends: 'session-end',
    };
  });
}

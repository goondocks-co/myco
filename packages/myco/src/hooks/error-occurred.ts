import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { errorEvent } from '../member/envelope.js';

/** Capture-only: an agent-side error is recorded as session activity; nothing is written to stdout beyond the empty response. */
export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('error-occurred', opts, (run) => ({ events: [errorEvent(run.ctx, run.input)] }));
}

import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { stopFailureEvent } from '../member/envelope.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('stop-failure', opts, (run) => ({ events: [stopFailureEvent(run.ctx, run.input)] }));
}

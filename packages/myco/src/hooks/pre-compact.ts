import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { compactionEvent } from '../member/envelope.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('pre-compact', opts, (run) => ({ events: [compactionEvent(run.ctx, 'pre', run.input)] }));
}

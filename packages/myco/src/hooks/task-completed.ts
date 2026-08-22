import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { taskCompletedEvent } from '../member/envelope.js';

export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('task-completed', opts, (run) => ({ events: [taskCompletedEvent(run.ctx, run.input)] }));
}

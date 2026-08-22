import { runMemberHook, type HookMainOptions } from '../member/capture.js';
import { notificationEvent } from '../member/envelope.js';

/** Capture-only: a user-facing notification is recorded as session activity; nothing is injected back. */
export async function main(opts: HookMainOptions = {}) {
  await runMemberHook('notification', opts, (run) => ({ events: [notificationEvent(run.ctx, run.input)] }));
}

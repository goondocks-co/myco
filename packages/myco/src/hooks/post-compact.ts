import { sendEvent } from './send-event.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

export async function main(lockNamespace?: PerUserLockNamespace) {
  await sendEvent('post-compact', (input) => ({
    type: 'post_compact',
    trigger: input.raw.trigger,
    compact_summary: input.raw.compact_summary,
  }), lockNamespace);
}

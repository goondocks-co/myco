import { sendEvent } from './send-event.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

export async function main(lockNamespace?: PerUserLockNamespace) {
  await sendEvent('pre-compact', (input) => ({
    type: 'pre_compact',
    trigger: input.raw.trigger,
  }), lockNamespace);
}

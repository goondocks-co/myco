import { sendEvent } from './send-event.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';

export async function main(lockNamespace?: PerUserLockNamespace) {
  await sendEvent('stop-failure', (input) => ({
    type: 'stop_failure',
    error: input.raw.error,
    error_details: input.raw.error_details,
  }), lockNamespace);
}

import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('stop-failure', (input) => ({
    type: 'stop_failure',
    error: input.error,
    error_details: input.error_details,
  }));
}

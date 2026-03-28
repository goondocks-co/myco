import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('pre-compact', (input) => ({
    type: 'pre_compact',
    trigger: input.raw.trigger,
  }));
}

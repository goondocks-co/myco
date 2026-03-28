import { sendEvent } from './send-event.js';

export async function main() {
  await sendEvent('post-compact', (input) => ({
    type: 'post_compact',
    trigger: input.raw.trigger,
    compact_summary: input.raw.compact_summary,
  }));
}

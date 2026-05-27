import { sendEvent } from './send-event.js';

/**
 * Copilot's `errorOccurred` hook — fires when the agent encounters an
 * error (network failure, tool error surfaced to the agent, model API
 * fault, etc.). Capture-only per Copilot's contract: the docs explicitly
 * note "no processing of stdout," so this handler emits a record event
 * to the daemon and returns nothing.
 *
 * The payload carries whatever error context Copilot has at hand —
 * usually a `message` and `code` plus the agent state at the time. We
 * forward the raw payload as the event body so the daemon can extract
 * whichever fields are populated for this Copilot version without us
 * having to track schema drift per release.
 */
export async function main() {
  await sendEvent('error-occurred', (input) => ({
    type: 'error_occurred',
    payload: input.raw,
  }));
}

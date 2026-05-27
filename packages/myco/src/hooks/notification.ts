import { sendEvent } from './send-event.js';

/**
 * Copilot's `notification` hook — fires when the agent emits a
 * user-facing notification (status message, warning, info banner,
 * "needs attention" prompt, etc.). Copilot's hook contract allows
 * returning `additionalContext` to trigger further agent processing,
 * but Myco's current architecture treats notifications as capture
 * signal only — we record them as session activity for later analysis
 * without trying to inject responses back at the agent.
 *
 * Wired as capture-only for that reason. If a future Canopy/Mycelium
 * pattern surfaces (e.g., "agent paused waiting for input → inject a
 * Myco-suggested next step"), this is the right place to add it.
 */
export async function main() {
  await sendEvent('notification', (input) => ({
    type: 'notification',
    payload: input.raw,
  }));
}

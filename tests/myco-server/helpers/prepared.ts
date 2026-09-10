import type { PrepareOutcome, PreparedDispatch } from '@myco-server-worker/core/harness.js';

/**
 * The dispatch a prepare produced, narrowed through the outcome's own
 * discriminant. A refusal throws with the refusal in the message, so a test
 * that expected a prepared dispatch names what it got instead.
 */
export function prepared(outcome: PrepareOutcome): PreparedDispatch {
  if (!outcome.ok) {
    throw new Error(`prepareDispatch refused: ${JSON.stringify(outcome)}`);
  }
  return outcome.prepared;
}

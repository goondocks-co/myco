import { VECTOR_DELETE_CONFIRM_MS, VECTOR_DELETE_RETRY_MS } from './provider.js';

/** Receipt lifecycle states; calibration can requeue an indexed receipt but never a deletion claim. */
export const RECEIPT = { journaled: 0, ready: 1, deletionSent: -1, deletionFailed: -2 } as const;

/** Calibration members are settled, joining the set, or leaving it. */
export const HUBNESS_MEMBER = { settled: 0, joining: 1, leaving: 2 } as const;

/** Deletion claims become due after their state-specific confirmation or retry wait. */
export const DELETION_RETRIES = [
  { state: RECEIPT.deletionSent, waitMs: VECTOR_DELETE_CONFIRM_MS },
  { state: RECEIPT.deletionFailed, waitMs: VECTOR_DELETE_RETRY_MS },
] as const;

export const deletionRetryDue = (ready: number, updatedAt: number, now: number): boolean =>
  DELETION_RETRIES.some(({ state, waitMs }) => ready === state && updatedAt <= now - waitMs);

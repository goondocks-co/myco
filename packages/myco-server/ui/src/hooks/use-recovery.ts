import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchJson } from '../lib/api';

/** What the last recovery attempt did. */
export interface LatestAttempt {
  attempt: number;
  stage: string;
  startedAt: number | null;
  /** The producer's own refusal classifier, where the attempt failed: a fixed word, not a message. */
  failure: string | null;
}

/**
 * What recovery data the Deployment holds.
 *
 * `staged` is deliberately not "recoverable": a staging becomes a recovery artifact only once an operator
 * materializes and verifies it, and the panel says so rather than implying a finished backup exists.
 */
export type RecoveryAvailability =
  | { state: 'none' }
  | { state: 'incomplete'; attempt: number; stage: string }
  | { state: 'staged'; attempt: number; prefix: string; needs: string };

export interface RecoverySchedule {
  supported: boolean;
  configured: boolean;
  /** False when a binding or credential this Deployment's recovery needs is absent; `idleBecause` says which. */
  ready: boolean;
  intervalHours: number | null;
  dueAt: number | null;
  due: boolean;
  latest: LatestAttempt | null;
  available: RecoveryAvailability;
  idleBecause: string | null;
}

export interface RecoveryStatus {
  attempt: number | null;
  stage: string;
  /** The schedule, or that this Deployment's settings could not be read while an export pauses its database. */
  schedule: RecoverySchedule | { unreadable: string };
}

/**
 * Whether a failed read means this Deployment runs no producer at all.
 *
 * Only the route's own refusal says that. A 401, a 503, a 7500 while an export pauses the database, and a network
 * failure each say nothing about whether a producer exists.
 */
export function unsupported(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400 && (error.detail ?? '').includes('no hosted recovery producer');
}

/**
 * The Deployment's recovery state, read only.
 *
 * A Deployment that runs no producer answers 400 for this route, which is not a dashboard error: the panel shows
 * automatic recovery as unavailable here, so the query does not retry it.
 */
export function useRecovery() {
  return useQuery({
    queryKey: ['recovery', 'exports'],
    queryFn: ({ signal }) => fetchJson<RecoveryStatus>('/api/recovery/exports', signal),
    retry: false,
  });
}

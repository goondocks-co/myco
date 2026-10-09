import type { RunnerBlockedVersion, RunnerUpdateRequest, RunnerUpdateResult, RunnerUpdateState } from './runner-update.js';

export type RunnerDisplay = 'Busy' | 'Online' | 'Offline' | 'Never contacted' | 'Paused' | 'Removed' | 'Not ready';
export type RunnerAvailability = 'ready' | 'settling' | 'user_active' | 'incompatible' | 'unknown';
export interface FleetRun {
  runId: string; projectId: string; projectName: string | null; task: string | null;
  at: number; status: string;
}
export interface RunnerFleetRecord {
  id: string; name: string; state: 'enabled' | 'paused' | 'removed'; revision: number;
  createdAt: number; createdBy: string | null; removedAt: number | null;
  lastSeenAt: number | null; updateAvailable?: boolean; awaitingReplacement?: boolean; updateMetadataUnavailable?: boolean; connected: boolean; display: RunnerDisplay;
  busy: (FleetRun & { leaseExpiresAt: number }) | null;
  lastAttempted: FleetRun | null; lastCompleted: FleetRun | null; lastFailed: FleetRun | null;
  offers: Array<{ id: string; authenticated: boolean; profile?: { model: string; efforts: readonly string[] } }> | null;
  offersObservedAt: number | null;
  capabilities: string[] | null; labels: string[] | null; preference: string | null;
  os: string | null; arch: string | null; version: string | null;
  readiness: { state: RunnerAvailability; code?: RunnerAvailability | 'not_signed_in' | 'updating' | 'registration'; reason: string; observedAt: number | null };
  lastReason: string | null;
  models: Array<{ harness: string; source: string | null; fetchedAt: number; receivedAt: number; fresh: boolean; available: boolean }>;
  channel: 'stable' | 'beta' | 'alpha' | null; latestVersion: string | null; lastCheckAt: number | null;
  lastResult: RunnerUpdateResult | null; blockedVersion: RunnerBlockedVersion | null;
  updateState: RunnerUpdateState | null; updateRequest: RunnerUpdateRequest | null;
}

export type QueueReason = 'capacity' | 'no_runner' | 'model_profile' | 'settling' | 'dispatch_ceiling' | 'not_signed_in' | 'updating' | 'paused' | 'registration' | 'ready' | 'unavailable';
export interface FleetQueue {
  observedAt: number; count: number; oldestAt: number | null;
  reasons: Array<{ reason: QueueReason; count: number }>;
  nativeNeedsRunner: boolean;
}

/** A live assignment and explicit controls take precedence over reported readiness and contact. */
export function runnerDisplay(row: Pick<RunnerFleetRecord, 'state' | 'busy' | 'lastSeenAt' | 'connected' | 'readiness'>): RunnerDisplay {
  if (row.state === 'removed') return 'Removed';
  if (row.state === 'paused') return 'Paused';
  if (row.busy !== null) return 'Busy';
  if (row.lastSeenAt === null) return 'Never contacted';
  if (!row.connected) return 'Offline';
  return row.readiness.state === 'ready' ? 'Online' : 'Not ready';
}

export const QUEUE_REASON_WORDS: Readonly<Record<QueueReason, string>> = {
  capacity: 'Waiting for capacity.',
  no_runner: 'No recently seen runner can currently take this work.',
  model_profile: 'Waiting for a machine with the agent and model this work needs.',
  settling: 'Waiting for machines to settle after waking.',
  dispatch_ceiling: 'The work limit is holding this work; the next server check will decide again.',
  not_signed_in: 'Sign in to a coding agent on a runner to take this work.',
  updating: 'Waiting for a machine to finish updating.',
  paused: 'Resume a paused machine to take this work.',
  registration: 'Approve replacement registration so a machine can take this work.',
  ready: 'A machine can take this work on its next check.',
  unavailable: 'Readiness is unavailable; the last report cannot establish which machine can take this work.',
};

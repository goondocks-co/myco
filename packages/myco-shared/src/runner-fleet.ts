import { HARNESS_CREDENTIALS } from './harness-providers.js';
import type { RunnerBlockedVersion, RunnerUpdateRequest, RunnerUpdateResult, RunnerUpdateState } from './runner-update.js';

export type RunnerCredentialChoice = 'own' | 'stored';
export type RunnerCredentialChoices = Readonly<Record<string, RunnerCredentialChoice>>;
/** Null marks a persisted source this build cannot use. */
export type StoredRunnerCredentialChoices = Readonly<Record<string, RunnerCredentialChoice | null>>;

/** Input choices name only supported agents and explicit sign-in sources. */
export function parseRunnerCredentialChoices(text: string): RunnerCredentialChoices {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([agent, choice]) => !Object.hasOwn(HARNESS_CREDENTIALS, agent) || (choice !== 'own' && choice !== 'stored'))) throw new Error('invalid runner sign-in choices');
  return value as RunnerCredentialChoices;
}

/** Persisted choices for agents absent from this build do not participate in selection. */
export function storedRunnerCredentialChoices(text: string): StoredRunnerCredentialChoices {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid runner sign-in choices');
  return Object.fromEntries(Object.entries(value).filter(([agent]) => Object.hasOwn(HARNESS_CREDENTIALS, agent))
    .map(([agent, choice]) => [agent, choice === 'own' || choice === 'stored' ? choice : null]));
}

/** Stored sign-in admits a reported agent independently of its machine's authentication status. */
export function runnerAgentLoginReady(offer: { id: string; authenticated: boolean; installed?: boolean }, choices?: StoredRunnerCredentialChoices, storedAvailable?: Readonly<Record<string, boolean>>): boolean {
  return offer.installed !== false && choices?.[offer.id] !== null && (choices?.[offer.id] === 'stored' ? storedAvailable === undefined || storedAvailable[offer.id] === true : offer.authenticated);
}

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
  offers: Array<{ id: string; installed?: boolean; authenticated: boolean; profile?: { model: string; efforts: readonly string[] } }> | null;
  offersObservedAt: number | null;
  credentialChoices?: StoredRunnerCredentialChoices;
  capabilities: string[] | null; labels: string[] | null; preference: string | null;
  os: string | null; arch: string | null; version: string | null;
  readiness: { state: RunnerAvailability; code?: RunnerAvailability | 'not_signed_in' | 'credential_unavailable' | 'updating' | 'registration'; reason: string; observedAt: number | null };
  lastReason: string | null;
  models: Array<{ harness: string; source: string | null; fetchedAt: number; receivedAt: number; fresh: boolean; available: boolean }>;
  channel: 'stable' | 'beta' | 'alpha' | null; latestVersion: string | null; lastCheckAt: number | null;
  lastResult: RunnerUpdateResult | null; blockedVersion: RunnerBlockedVersion | null;
  updateState: RunnerUpdateState | null; updateRequest: RunnerUpdateRequest | null;
}

export type QueueReason = 'capacity' | 'no_runner' | 'model_profile' | 'credential_unavailable' | 'settling' | 'dispatch_ceiling' | 'not_signed_in' | 'updating' | 'paused' | 'registration' | 'ready' | 'unavailable';
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
  credential_unavailable: 'The chosen stored key is unavailable for this agent. Add a usable key in Settings or change its sign-in on Runners.',
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

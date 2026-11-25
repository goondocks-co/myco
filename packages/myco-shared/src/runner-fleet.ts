import type { StoredKeyFailure } from './run-diagnostic.js';
import { HARNESS_CREDENTIALS } from './harness-providers.js';
import { secretSlotLabel, type SecretSlotName } from './secret-slots.js';
import type { RunnerBlockedVersion, RunnerUpdateRequest, RunnerUpdateResult, RunnerUpdateState } from './runner-update.js';

export const RUNNER_CREDENTIAL_CHOICES = ['own', 'stored', 'stored-first'] as const;
export type RunnerCredentialChoice = typeof RUNNER_CREDENTIAL_CHOICES[number];
export type RunnerSignInSource = 'own' | 'stored';
export type RunnerFallbackReason = StoredKeyFailure | 'no_key';
export const RUNNER_KEY_RECHECK_MS = 60 * 60_000;

export interface RunPayer {
  payer: RunnerSignInSource;
  fallbackReason?: RunnerFallbackReason;
}
export function paidByWords(payer: RunPayer): string {
  return `Paid by ${RUNNER_SIGN_IN_WORDS[payer.payer]}${payer.fallbackReason === undefined ? '' : `: ${runnerFallbackReasonWords(payer.fallbackReason)}`}`;
}
export const RUNNER_PAYER_LABELS: Readonly<Record<RunnerCredentialChoice, string>> = {
  own: 'Each runner’s own sign-in',
  stored: 'A stored key',
  'stored-first': 'A stored key first, then the runner’s own sign-in',
};
export const RUNNER_SIGN_IN_WORDS: Readonly<Record<RunnerSignInSource, string>> = {
  own: 'the runner’s own sign-in', stored: 'the stored key',
};
export const agentHasStoredKey = (agent: string): boolean => {
  const manifest = HARNESS_CREDENTIALS[agent];
  return manifest?.slot != null && manifest.variables.length > 0;
};
export const isRunnerCredentialChoice = (value: unknown): value is RunnerCredentialChoice =>
  RUNNER_CREDENTIAL_CHOICES.some(choice => choice === value);
export const runnerCredentialChoiceAllowed = (agent: string, choice: unknown): choice is RunnerCredentialChoice =>
  Object.hasOwn(HARNESS_CREDENTIALS, agent) && isRunnerCredentialChoice(choice)
    && (choice !== 'stored-first' || agentHasStoredKey(agent));
export type RunnerCredentialChoices = Readonly<Record<string, RunnerCredentialChoice>>;
/** Null marks a persisted source this build cannot use. */
export type StoredRunnerCredentialChoices = Readonly<Record<string, RunnerCredentialChoice | null>>;

/** Input choices name only supported agents and explicit sign-in sources. */
export function parseRunnerCredentialChoices(text: string): RunnerCredentialChoices {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([agent, choice]) => !runnerCredentialChoiceAllowed(agent, choice))) throw new Error('invalid runner sign-in choices');
  return value as RunnerCredentialChoices;
}

/** Persisted choices for agents absent from this build do not participate in selection. */
export function storedRunnerCredentialChoices(text: string): StoredRunnerCredentialChoices {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid runner sign-in choices');
  return Object.fromEntries(Object.entries(value).filter(([agent]) => Object.hasOwn(HARNESS_CREDENTIALS, agent))
    .map(([agent, choice]) => [agent, runnerCredentialChoiceAllowed(agent, choice) ? choice : null]));
}

/** Whether a runner's reported offer names `agent` as installed on its machine: the rule claims and sign-in choices share. */
export const offersAgentInstalled = (offer: { id: string; installed?: boolean }, agent: string): boolean => offer.id === agent && offer.installed !== false;

export const runnerOwnSignInReady = (offer: { authenticated: boolean; unavailableReason?: 'login_missing' }): boolean =>
  offer.authenticated && offer.unavailableReason !== 'login_missing';

/** Stored sign-in admits a reported agent independently of its machine's authentication status. */
export function runnerAgentLoginReady(offer: { id: string; authenticated: boolean; installed?: boolean; unavailableReason?: 'login_missing' }, choices?: StoredRunnerCredentialChoices, storedAvailable?: Readonly<Record<string, boolean>>): boolean {
  const choice = choices?.[offer.id];
  if (!offersAgentInstalled(offer, offer.id) || choice === null) return false;
  const own = runnerOwnSignInReady(offer);
  const stored = storedAvailable === undefined || storedAvailable[offer.id] === true;
  if (choice === 'stored-first') return own || stored;
  return offer.unavailableReason !== 'login_missing' && (choice === 'stored' ? stored : own);
}

export interface HarnessSignInFailure {
  name: string;
  hint: string;
  source: RunnerSignInSource;
}

export const STORED_SIGN_IN_HINT = 'Update this agent’s stored key in Settings → Connections.';

/** Contact diagnostics retain bounded agent labels and remedies, never harness output. */
export function parseHarnessSignInFailure(value: unknown): HarnessSignInFailure | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { name, hint, source } = value as Record<string, unknown>;
  if (typeof name !== 'string' || name.length === 0 || name.length > 128
    || typeof hint !== 'string' || hint.length === 0 || hint.length > 512
    || (source !== 'own' && source !== 'stored')) return undefined;
  return { name, hint, source };
}

/** The failed agent and the remedy reported by its runner. */
export function harnessSignInFailureWords(offer: { unavailableReason?: 'login_missing'; signInFailure?: HarnessSignInFailure }): string | null {
  return offer.unavailableReason !== 'login_missing' ? null
    : `${offer.signInFailure?.name ?? 'An agent'} could not sign in at launch. ${offer.signInFailure?.hint ?? 'Check its sign-in settings.'}`;
}

export type RunnerDisplay = 'Busy' | 'Online' | 'Offline' | 'Never contacted' | 'Paused' | 'Removed' | 'Not ready';
export type RunnerAvailability = 'ready' | 'settling' | 'user_active' | 'incompatible' | 'unknown';
export interface FleetRun {
  runId: string; projectId: string; projectName: string | null; task: string | null;
  at: number; status: string;
}
export interface RunnerFleetRecord {
  id: string; name: string; state: 'enabled' | 'paused' | 'removed'; revision: number;
  /** The machine id the runner last reported, the one a member sign-in on the same machine claims; null when it reported none. */
  machineId: string | null;
  createdAt: number; createdBy: string | null; removedAt: number | null;
  lastSeenAt: number | null; updateAvailable?: boolean; awaitingReplacement?: boolean; updateMetadataUnavailable?: boolean; connected: boolean; display: RunnerDisplay;
  busy: (FleetRun & { leaseExpiresAt: number }) | null;
  lastAttempted: FleetRun | null; lastCompleted: FleetRun | null; lastFailed: FleetRun | null;
  offers: Array<{ id: string; installed?: boolean; authenticated: boolean; unavailableReason?: 'login_missing'; signInFailure?: HarnessSignInFailure; profile?: { model: string; efforts: readonly string[] } }> | null;
  offersObservedAt: number | null;
  credentialChoices?: StoredRunnerCredentialChoices;
  credentialChoiceTimes?: Record<string, number>;
  storedKeyFailures?: StoredKeyFailureNotice[];
  fallbackNotices?: RunnerFallbackNotice[];
  capabilities: string[] | null; labels: string[] | null; preference: string | null;
  os: string | null; arch: string | null; version: string | null;
  readiness: { state: RunnerAvailability; code?: RunnerAvailability | StoredKeyFailure | 'not_signed_in' | 'credential_unavailable' | 'updating' | 'registration'; reason: string; observedAt: number | null };
  lastReason: string | null;
  models: Array<{ harness: string; source: string | null; fetchedAt: number; receivedAt: number; fresh: boolean; available: boolean }>;
  channel: 'stable' | 'beta' | 'alpha' | null; latestVersion: string | null; lastCheckAt: number | null;
  lastResult: RunnerUpdateResult | null; blockedVersion: RunnerBlockedVersion | null;
  updateState: RunnerUpdateState | null; updateRequest: RunnerUpdateRequest | null;
}

export interface StoredKeyFailureNotice { agent: string; slot: SecretSlotName; failure: RunnerFallbackReason; since?: number }
export interface RunnerFallbackNotice { agent: string; slot: SecretSlotName; reason: RunnerFallbackReason; since: number }

export function runnerFallbackReasonWords(reason: RunnerFallbackReason): string {
  return reason === 'no_key' ? 'no usable key is stored' : reason === 'out_of_credit' ? 'the stored key ran out of API credit' : 'the stored key was rejected';
}

export function runnerFallbackWords(reason: RunnerFallbackReason, slot: SecretSlotName): string {
  const key = reason === 'no_key' ? `No usable ${secretSlotLabel(slot)} key is stored` : storedKeyFailureTitle(reason, slot);
  return `${key}. Work continues on the runner’s own sign-in and returns to the key when it works again.`;
}

export function runnerFallbackSince(since: number): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(since);
}

export function storedKeyFailureTitle(failure: RunnerFallbackReason, slot?: SecretSlotName): string {
  const key = slot === undefined ? 'The stored key' : `The ${secretSlotLabel(slot)} key`;
  if (failure === 'no_key') return `${key} is missing or unusable`;
  return failure === 'out_of_credit' ? `${key} ran out of API credit` : `${key} was rejected`;
}

export function storedKeyFailureWords(failure: RunnerFallbackReason, slot?: SecretSlotName, runEnded = false): string {
  const next = failure === 'no_key' ? 'Add a usable key in Settings or' : failure === 'out_of_credit' ? 'Add credit with the provider, replace the key in Settings, or' : 'Replace the key in Settings or';
  const remedy = `${next} set the runner apart to use its own sign-in on its machine page.`;
  const outcome = runEnded ? 'This run ended.' : 'Work that needs this key waits.';
  return `${storedKeyFailureTitle(failure, slot)}. ${outcome} ${remedy}${runEnded ? ' Start a new run when ready.' : ''}`;
}

export type QueueReason = StoredKeyFailure | 'capacity' | 'no_runner' | 'model_profile' | 'credential_unavailable' | 'settling' | 'dispatch_ceiling' | 'not_signed_in' | 'updating' | 'paused' | 'registration' | 'ready' | 'unavailable' | 'admission_building' | 'queue_building';
export interface FleetQueue {
  state?: 'building';
  observedAt: number; count: number | null; oldestAt: number | null;
  reasons: Array<{ reason: QueueReason; count: number | null; keySlot?: SecretSlotName }>;
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
  out_of_credit: storedKeyFailureWords('out_of_credit'),
  invalid_key: storedKeyFailureWords('invalid_key'),
  capacity: 'Waiting for capacity.',
  no_runner: 'No recently seen runner can currently take this work.',
  credential_unavailable: 'The chosen stored key is unavailable for this agent. Add a usable key in Settings or change who pays in Settings › Models.',
  model_profile: 'Waiting for a machine with the agent and model this work needs.',
  settling: 'Waiting for machines to settle after waking.',
  dispatch_ceiling: 'The work limit is holding this work; the next server check will decide again.',
  not_signed_in: 'Sign in to a coding agent on a runner to take this work.',
  updating: 'Waiting for a machine to finish updating.',
  paused: 'Resume a paused machine to take this work.',
  registration: 'Approve replacement registration so a machine can take this work.',
  ready: 'A machine can take this work on its next check.',
  unavailable: 'Readiness is unavailable; the last report cannot establish which machine can take this work.',
  admission_building: 'Measuring recent spend.',
  queue_building: 'Waiting for the work queue to be ready.',
};

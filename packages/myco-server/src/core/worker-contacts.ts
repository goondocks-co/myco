import { contactAuthorityIndex, workerContactUpsert, runnerContactUpsert } from '../db/runs/contact-writes.js';
import { commit, type Bound } from '../db/index.js';
import { parseHarnessSignInFailure, harnessSignInFailureWords, runnerAgentLoginReady, storedRunnerCredentialChoices, type HarnessSignInFailure, type StoredRunnerCredentialChoices } from '@goondocks/myco-shared/runner-fleet';
/**
 * What each worker last reported about itself, and what the Deployment makes of it.
 *
 * The one writer and the one reader of `worker_contacts`. The claim records
 * contact whatever it answers, a lease renewal refreshes the liveness of the
 * report already held, the fleet read joins both against the leases that
 * decide busy, and the machine read takes each machine's latest explicit offers and contact.
 *
 * It holds only what the claim already carries: the harnesses a worker reports,
 * whether it reports each logged in, the capabilities it names, and the outcome
 * its last claim answered. A reported login is the worker's own probe of its
 * machine and is never evidence that a provider accepts a request.
 *
 * It decides nothing about scheduling or selection, merges no two credentials
 * into one worker, and stores no token, no credential environment and no part
 * of a request body beyond those parsed fields.
 */
import type { ContentStore, RelationalStore } from './adapters.js';
import { CONTACT_THROTTLE_MS, WORKER_LEASE_MS } from '../constants.js';
import { asMemberRole, isAdmin } from '../auth/roles.js';
import { renewingLeaseAuthority } from '../db/runners/lease-authority.js';
import type { LeaseHolder } from './worker-lease.js';
import { contactedMachineHeads, machineHead } from '../db/runners/heads.js';
import { lastContactAt, recentCapabilityRows, recentReportRows, retireWorkerContacts, runnerObservationWrite, workerContactRow, type WorkerContactRow } from '../db/runners/contacts.js';
import { fleetRows, removedRunnerRows, type MemberFleetRow, type RunnerFleetRow } from '../db/runners/fleet-rows.js';
import { runnerDisplay, type RunnerFleetRecord, type FleetRun, type RunnerAvailability } from '@goondocks/myco-shared/runner-fleet';
import { MODEL_CATALOG_FRESH_MS, parseModelCatalog } from '@goondocks/myco-shared/execution-profile';
import { isRunnerUpdateText, RUNNER_UPDATE_RESULTS } from '@goondocks/myco-shared/runner-update';
import semver from 'semver';
import type { ProfileCapability } from '@goondocks/myco-shared/execution-profile';

/** A harness a worker reports, as it reports it. `authenticated` is the worker's own probe, not a provider check. */
export interface ReportedHarness {
  id: string;
  installed?: boolean;
  authenticated: boolean;
  unavailableReason?: 'login_missing';
  signInFailure?: HarnessSignInFailure;
  profile?: ProfileCapability;
}

/** Why the worker's last claim took no run, in the claim's own vocabulary; null when it took one. */
const CONTACT_OUTCOMES = ['claimed', 'no_work', 'no_harness', 'at_limit', 'lost_race', 'paused'] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

/** Whether a stored value belongs to the contact outcome vocabulary. */
export const isContactOutcome = (value: string): value is ContactOutcome => (CONTACT_OUTCOMES as readonly string[]).includes(value);

/** How much of a worker's report is kept, so one poll can never grow the row without bound. */
const MAX_OFFERS = 16;
const MAX_CAPABILITIES = 16;
const MAX_ID = 64;
const MAX_METADATA = 128;

/**
 * How recently a worker must have been heard from to count as attached. The
 * lease is the Deployment's own statement of how long a worker may go quiet
 * while still holding work, so it is the same bound here; nothing guesses at a
 * second, longer threshold for a worker that has stopped.
 */
export const CONTACT_RECENT_MS = WORKER_LEASE_MS;

/**
 * How long a worker's last observation is kept once nothing is heard from it.
 * A fixed horizon, not a setting: this is a diagnostic trace, and an owner who
 * wants a worker gone stops running it.
 */
export const WORKER_CONTACT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A worker's stored observation, as read back. */
interface WorkerContact {
  credentialId: string;
  machineId: string | null;
  /** Null when the stored report cannot be read; an empty list is a worker reporting none. */
  offers: ReportedHarness[] | null;
  capabilities: string[] | null;
  lastReason: ContactOutcome | null;
  lastSeenAt: number;
}

/** One attached-or-remembered worker, as the status surface reports it. `credentialId` is a legacy worker's member credential, or a runner's id. */
export interface WorkerFleetRow extends WorkerContact {
  /** The runner this row reports, or null for a legacy worker presenting a member credential. */
  runnerDetails?: RunnerFleetRecord;
  runner: { id: string; name: string; state: 'enabled' | 'paused' | 'removed' } | null;
  /** Held from a live lease, which decides busy; a stored claim reason never does. */
  busy: { runId: string; projectId: string; task: string | null; leaseExpiresAt: number } | null;
  /** Whether a claim from this credential would be admitted now: the worker route's own rule, credential and role together. */
  eligible: boolean;
  /** Whether the last contact is inside `CONTACT_RECENT_MS`. */
  recent: boolean;
}

function boundedOffers(offers: readonly ReportedHarness[]): ReportedHarness[] {
  return offers.slice(0, MAX_OFFERS).map((offer) => ({
    id: offer.id.slice(0, MAX_ID), ...(offer.installed === undefined ? {} : { installed: offer.installed === true }), authenticated: offer.authenticated === true,
    ...(offer.unavailableReason === 'login_missing' ? { unavailableReason: offer.unavailableReason, signInFailure: parseHarnessSignInFailure(offer.signInFailure) } : {}),
    ...(offer.profile === undefined ? {} : { profile: offer.profile }),
  }));
}

function boundedCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.slice(0, MAX_CAPABILITIES).map((capability) => capability.slice(0, MAX_ID));
}

/** Stored evidence that cannot be read answers null: a reader states that it does not know, and never an empty report. */
export function parseOffers(raw: unknown): ReportedHarness[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const offers: ReportedHarness[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object' || typeof (entry as ReportedHarness).id !== 'string') return null;
      const offer = entry as ReportedHarness;
      const profile = offer.profile;
      const validProfile = profile !== null && typeof profile === 'object'
        && (profile.model === 'flag' || profile.model === 'config' || profile.model === 'none')
        && Array.isArray(profile.efforts) && profile.efforts.every((effort) => typeof effort === 'string');
      offers.push({ id: offer.id, ...(offer.installed === undefined ? {} : { installed: offer.installed === true }), authenticated: offer.authenticated === true,
        ...(offer.unavailableReason === 'login_missing' ? { unavailableReason: offer.unavailableReason, signInFailure: parseHarnessSignInFailure(offer.signInFailure) } : {}), ...(validProfile ? { profile } : {}) });
    }
    return offers;
  } catch {
    return null;
  }
}

function parseCapabilities(raw: unknown): string[] | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.every((entry) => typeof entry === 'string') ? parsed as string[] : null;
  } catch {
    return null;
  }
}

/** Whether two observations say the same thing, so an unchanged one can wait for the throttle. */
function unchanged(stored: WorkerContact | null, offers: readonly ReportedHarness[], capabilities: readonly string[], reason: ContactOutcome | null): boolean {
  if (stored === null || stored.offers === null || stored.capabilities === null) return false;
  if (stored.lastReason !== reason) return false;
  return sameOffers(stored.offers, offers) && stored.capabilities.length === capabilities.length
    && stored.capabilities.every((capability, i) => capability === capabilities[i]);
}

function sameOffers(left: readonly ReportedHarness[], right: readonly ReportedHarness[]): boolean {
  return left.length === right.length && left.every((offer, i) => offer.id === right[i]?.id
    && JSON.stringify(offer.signInFailure) === JSON.stringify(right[i]?.signInFailure) && offer.unavailableReason === right[i]?.unavailableReason && offer.installed === right[i]?.installed && offer.authenticated === right[i]?.authenticated && JSON.stringify(offer.profile) === JSON.stringify(right[i]?.profile));
}

function contactOf(row: WorkerContactRow): WorkerContact {
  return { credentialId: row.credential_id, machineId: row.machine_id, offers: parseOffers(row.offers), capabilities: parseCapabilities(row.capabilities),
    lastReason: row.last_reason as ContactOutcome | null, lastSeenAt: row.last_seen_at };
}

/**
 * Record this credential's contact, with what it reports.
 *
 * Called on an authenticated claim — including one answered `no_work` — and on
 * a lease renewal, which is the only contact a busy worker makes. A renewal
 * names no outcome and no offer of its own: it refreshes the liveness of what
 * the worker last reported rather than erasing it. An unchanged observation
 * inside `CONTACT_THROTTLE_MS` is skipped while the machine's latest offers agree. Explicit offers advance a monotonic
 * revision in `updated_at`; renewals preserve unsupplied fields and advance only liveness. A throttled contact answers null.
 */
export async function workerContactWrite(
  db: RelationalStore,
  contact: { credentialId: string; machineId: string | null; offers?: readonly ReportedHarness[]; capabilities?: readonly string[]; reason?: ContactOutcome; now: number },
  lease?: { projectId: string; runId: string; attemptId?: string },
): Promise<Bound | null> {
  const row = await workerContactRow(db, contact.credentialId);
  const stored = row === null ? null : contactOf(row);
  // Only a claim supplies a report. A renewal refreshes the liveness of the one
  // already held and leaves an absent or unreadable one as it stands: null is
  // stored, and a reader answers unknown.
  const offers = contact.offers === undefined ? (stored?.offers ?? null) : boundedOffers(contact.offers);
  const capabilities = contact.capabilities === undefined ? (stored?.capabilities ?? null) : boundedCapabilities(contact.capabilities);
  const reason = contact.reason ?? stored?.lastReason ?? null;
  let skipRevision: number | null = null;
  if (offers !== null && capabilities !== null
    && unchanged(stored, offers, capabilities, reason) && contact.now - stored!.lastSeenAt < CONTACT_THROTTLE_MS) {
    if (contact.offers === undefined) return null;
    const machineId = contact.machineId ?? stored!.machineId;
    if (machineId === null) return null;
    const head = await machineHead(db, machineId);
    const heldOffers = head === null ? null : parseOffers(head.offers);
    if (head !== null && heldOffers !== null && sameOffers(heldOffers, offers)) skipRevision = head.revision;
  }
  const authority = lease === undefined ? null : renewingLeaseAuthority({ kind: 'member', tokenId: contact.credentialId }, contact.now, lease.attemptId);
  return workerContactUpsert[authority === null ? 0 : contactAuthorityIndex('member',lease?.attemptId)]!.bind(contact.credentialId, contact.machineId, offers === null ? null : JSON.stringify(offers), capabilities === null ? null : JSON.stringify(capabilities), reason, contact.now, contact.offers === undefined ? 0 : 1, contact.capabilities === undefined ? 0 : 1, contact.reason === undefined ? 0 : 1, skipRevision, ...(authority === null ? [] : [lease!.projectId, lease!.runId, ...authority.params]));
}

/**
 * Record a runner's contact under its stable id, with whatever it reports: machine, system and version metadata, its
 * offers and capabilities on a claim, and the claim's outcome. Unsupplied fields keep what is held. An unchanged
 * observation inside `CONTACT_THROTTLE_MS` writes nothing. Given a lease, the write lands only while that runner
 * holds it.
 */
export function runnerContactWrite(
  db: RelationalStore,
  contact: { runnerId: string; machineId?: string | null; os?: string | null; version?: string | null; offers?: readonly ReportedHarness[]; capabilities?: readonly string[]; reason?: ContactOutcome; now: number },
  lease?: { projectId: string; runId: string; attemptId?: string },
  worker?: LeaseHolder,
): Bound {
  const offers = contact.offers === undefined ? null : JSON.stringify(boundedOffers(contact.offers));
  const capabilities = contact.capabilities === undefined ? null : JSON.stringify(boundedCapabilities(contact.capabilities));
  const explicitOffers = contact.offers === undefined ? 0 : 1;
  const explicitCapabilities = contact.capabilities === undefined ? 0 : 1;
  const authority = lease === undefined || worker === undefined ? null : renewingLeaseAuthority(worker, contact.now, lease.attemptId);
  const text = (value: string | null | undefined, bound: number): string | null => (value == null ? null : value.slice(0, bound));
  return runnerContactUpsert[authority === null ? 0 : contactAuthorityIndex(worker!.kind,lease?.attemptId)]!.bind(contact.runnerId, text(contact.machineId, MAX_ID), text(contact.os, MAX_METADATA), text(contact.version, MAX_ID), offers, capabilities, contact.reason ?? null, contact.now, contact.now, ...(authority === null ? [] : [lease!.projectId, lease!.runId, ...authority.params]), explicitOffers, explicitCapabilities, explicitOffers, CONTACT_THROTTLE_MS, explicitOffers, explicitCapabilities);
}

/** Record one contact through the same statement used by atomic worker operations. */
export async function recordWorkerContact(db: RelationalStore, contact: Parameters<typeof workerContactWrite>[1]): Promise<boolean> {
  const statement = await workerContactWrite(db, contact);
  if (statement === null) return false;
  const [result] = await commit(db, statement);
  return result.results.length > 0;
}

/**
 * The legacy workers worth listing and every active runner, with the run each is driving. A machine's rotated
 * credentials add no legacy rows: each machine lists its latest contact, plus anyone heard from recently or holding a lease.
 *
 * Busy comes from the lease, never from a stored reason: a worker whose claim last answered `no_work` and then took a
 * run through another path is still busy, and a worker that holds a lease but has no contact row at all still appears,
 * as busy, with no contact time.
 */
export async function readWorkerFleet(db: RelationalStore, now: number, includeSignIn = false): Promise<WorkerFleetRow[]> {
  const [memberRows, runnerRows] = await fleetRows(db, now, now - CONTACT_RECENT_MS);
  const members = memberRows.map((row): WorkerFleetRow => memberFleetRow(row, now));
  const heardAt = (row: WorkerFleetRow): number => (row.lastSeenAt > 0 ? row.lastSeenAt : row.busy?.leaseExpiresAt ?? 0);
  return [...members, ...runnerRows.map(row => runnerFleetRow(row, now, includeSignIn))].sort((left, right) => heardAt(right) - heardAt(left));
}

function memberFleetRow(row: MemberFleetRow, now: number): WorkerFleetRow {
  const lastSeenAt = row.last_seen_at ?? 0;
  const expired = row.expires_at !== null && row.expires_at <= now;
  // The claim route admits an administrator whose member row the Deployment
  // still holds. Eligibility answers the same question with the same rule.
  const role = asMemberRole(row.member_role);
  const admits = row.member_revoked_at === null && role !== null && isAdmin(role);
  return {
    credentialId: row.credential_id,
    machineId: row.contact_machine_id ?? row.credential_machine_id,
    offers: parseOffers(row.offers),
    capabilities: parseCapabilities(row.capabilities),
    lastReason: row.last_reason as ContactOutcome | null,
    lastSeenAt,
    busy: row.run_id === null ? null : { runId: row.run_id, projectId: String(row.project_id), task: row.task, leaseExpiresAt: row.lease_expires_at ?? 0 },
    eligible: row.revoked_at === null && !expired && admits,
    recent: lastSeenAt > 0 && now - lastSeenAt <= CONTACT_RECENT_MS,
    runner: null,
  };
}

type UpdateMetadata = Pick<RunnerFleetRecord, 'lastResult' | 'blockedVersion' | 'updateState'>;
const emptyUpdateMetadata = (): UpdateMetadata => ({ lastResult: null, blockedVersion: null, updateState: null });
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One unreadable update report affects only its runner; all other fleet facts remain readable. */
function storedUpdateMetadata(raw: unknown): { metadata: UpdateMetadata; unavailable: boolean } {
  if (raw == null) return { metadata: emptyUpdateMetadata(), unavailable: false };
  let parsed: unknown;
  try { parsed = JSON.parse(String(raw)); } catch { return { metadata: emptyUpdateMetadata(), unavailable: true }; }
  if (!isRecord(parsed)) return { metadata: emptyUpdateMetadata(), unavailable: true };
  const wrapped = 'lastResult' in parsed || 'updateState' in parsed || 'blockedVersion' in parsed;
  const result = wrapped ? parsed.lastResult : parsed;
  const block = wrapped ? parsed.blockedVersion : null;
  const state = wrapped ? parsed.updateState : null;
  if ((result != null && (!isRecord(result) || !isRunnerUpdateText(result.fromVersion, 64) || !isRunnerUpdateText(result.toVersion, 64)
      || !RUNNER_UPDATE_RESULTS.includes(result.result as typeof RUNNER_UPDATE_RESULTS[number]) || !Number.isSafeInteger(result.at)
      || (result.requestId !== undefined && !isRunnerUpdateText(result.requestId, 64))
      || (result.attemptId !== undefined && !isRunnerUpdateText(result.attemptId, 64))
      || (result.reason !== undefined && typeof result.reason !== 'string')))
    || (block != null && (!isRecord(block) || !isRunnerUpdateText(block.version, 64) || !Number.isSafeInteger(block.until)
      || typeof block.reason !== 'string')) || (state != null && !isRecord(state))
    || (state != null && (state.phase !== 'updating' && state.phase !== 'probation' && state.phase !== 'cleanup_pending'))
    || (state != null && (typeof state.since !== 'number' || !Number.isSafeInteger(state.since)))) {
    return { metadata: emptyUpdateMetadata(), unavailable: true };
  }
  return { metadata: { lastResult: result as UpdateMetadata['lastResult'], blockedVersion: block as UpdateMetadata['blockedVersion'],
    updateState: state as UpdateMetadata['updateState'] }, unavailable: false };
}

/** Runtime and admin readiness includes chosen sources; other readers use machine sign-in only. */
function runnerReadiness(row: { availability: string | null; readiness_reason: string | null; observed_at: number | null; updated_at: number | null; credential_choices: string }, offers: ReportedHarness[] | null, credentialed: boolean,
  updateState: UpdateMetadata['updateState'], now: number, includeSignIn = true): RunnerFleetRecord['readiness'] {
  if (!credentialed) return { state: 'unknown', code: 'registration', reason: 'No current authority to take new work. Approve replacement registration on this machine.', observedAt: now };
  if (updateState?.phase === 'updating' || updateState?.phase === 'probation')
    return { state: 'unknown', code: 'updating', reason: 'An update is holding new work until machine health is confirmed.', observedAt: updateState.since };
  const explicit = row.availability as RunnerAvailability | null;
  if (explicit !== null && explicit !== 'ready')
    return { state: explicit, code: explicit, reason: String(row.readiness_reason), observedAt: row.observed_at };
  if (offers === null) return { state: 'unknown', code: 'unknown', reason: 'Agent sign-in and execution profiles are unavailable.',
    observedAt: row.updated_at };
  const choices = includeSignIn ? storedRunnerCredentialChoices(row.credential_choices) : undefined;
  const signInFailure = offers.map(harnessSignInFailureWords).filter(Boolean).join(' ');
  if (!offers.some(offer => runnerAgentLoginReady(offer, choices))) return { state: 'unknown', code: 'not_signed_in',
    reason: signInFailure || 'Reported no signed-in eligible agent.', observedAt: row.updated_at };
  const readyReason = includeSignIn ? 'Reports an agent with a chosen sign-in; provider access is untested.' : 'Reports a signed-in eligible agent; provider access is untested.';
  return { state: 'ready', code: 'ready', reason: [readyReason, signInFailure].filter(Boolean).join(' '), observedAt: row.updated_at };
}

const fleetRun = (value: string | null): FleetRun | null => value === null ? null : JSON.parse(value) as FleetRun;

/**
 * One registered runner, keyed by its stable id: a rotation never makes a second row. A runner is eligible while it is
 * enabled and holds a credential of its current epoch. Its catalogs appear as metadata; bodies are read on their own.
 */
function runnerFleetRow(row: RunnerFleetRow, now: number, includeSignIn: boolean): WorkerFleetRow {
  const lastSeenAt = row.last_seen_at ?? 0;
  const state = row.state as RunnerFleetRecord['state'];
  const offers = parseOffers(row.offers);
  const capabilities = parseCapabilities(row.capabilities);
  const busy = row.run_id === null ? null : { runId: row.run_id, projectId: String(row.project_id), projectName: row.project_name, task: row.task, at: Number(row.started_at), status: 'running', leaseExpiresAt: Number(row.lease_expires_at) };
  const { metadata, unavailable: updateMetadataUnavailable } = storedUpdateMetadata(row.last_result);
  const readiness = runnerReadiness(row, offers, row.credentialed === 1, metadata.updateState, now, includeSignIn);
  const lastAttempted = fleetRun(row.last_attempted);
  const displaySeenAt = Math.max(lastSeenAt, row.last_contact_at ?? 0, lastAttempted?.at ?? 0);
  const connected = state !== 'removed' && lastSeenAt > 0 && now - lastSeenAt <= CONTACT_RECENT_MS;
  const models = JSON.parse(row.models) as Array<{ harness: string; source: string | null; available: number; fetchedAt: number; receivedAt: number }>;
  const details: RunnerFleetRecord = {
    id: row.id, name: row.name, state, revision: row.revision, createdAt: row.created_at, createdBy: row.created_by_member, removedAt: row.removed_at,
    lastSeenAt: displaySeenAt || null, connected, busy, display: 'Never contacted',
    awaitingReplacement: row.replacement_pending === 1, updateMetadataUnavailable,
    lastAttempted, lastCompleted: fleetRun(row.last_completed), lastFailed: fleetRun(row.last_failed),
    ...(includeSignIn ? { credentialChoices: storedRunnerCredentialChoices(row.credential_choices) } : {}),
    offers, offersObservedAt: offers === null ? null : row.updated_at,
    capabilities, labels: parseCapabilities(row.labels), preference: null, os: row.os, arch: row.arch, version: row.version, readiness, lastReason: row.last_reason,
    models: models.map(model => ({ harness: model.harness, source: model.source, fetchedAt: model.fetchedAt, receivedAt: model.receivedAt,
      fresh: model.receivedAt >= now - MODEL_CATALOG_FRESH_MS, available: model.available === 1 })),
    channel: row.channel as RunnerFleetRecord['channel'],
    latestVersion: row.latest_version,
    updateAvailable: row.version !== null && row.latest_version !== null && semver.valid(row.version) !== null && semver.valid(row.latest_version) !== null && semver.gt(row.latest_version, row.version),
    lastCheckAt: row.last_check_at, ...metadata,
    updateRequest: row.update_request_id === null ? null : { id: row.update_request_id, requestedAt: Number(row.requested_at), clearBlock: true },
  };
  details.display = runnerDisplay(details);
  return {
    credentialId: details.id, machineId: row.machine_id, offers, capabilities, lastReason: details.lastReason as ContactOutcome | null, lastSeenAt: displaySeenAt, busy,
    eligible: state === 'enabled' && row.credentialed === 1, recent: connected, runner: { id: details.id, name: details.name, state }, runnerDetails: details,
  };
}

const REMOVED_PAGE_MAX = 200;

/** Removed runners, newest removal first: the separate view the active fleet no longer carries. */
export async function readRemovedRunners(db: RelationalStore, now: number, limit: number, after: { removedAt: number; id: string } | null): Promise<{ runners: RunnerFleetRecord[]; cursor: { removedAt: number; id: string } | null }> {
  const bounded = Math.min(Math.max(1, limit), REMOVED_PAGE_MAX);
  const rows = await removedRunnerRows(db, now, bounded + 1, after);
  const runners = rows.slice(0, bounded).map(row => runnerFleetRow(row, now, false).runnerDetails!);
  const last = runners.at(-1);
  return { runners, cursor: rows.length > bounded && last !== undefined ? { removedAt: last.removedAt!, id: last.id } : null };
}

/** Record bounded, non-secret machine readiness from the supervisor's own contact loop. */
export const runnerObservation = (runnerId: string, observation: { arch: string | null; state: RunnerAvailability; reason: string }, now: number): Bound =>
  runnerObservationWrite(runnerId, observation, now);

/** Fresh reports share control, capacity and readiness admission across every preview. */
export function fleetReports(fleet: readonly WorkerFleetRow[], includeBusy = false) {
  return fleet.filter(row => row.recent && row.eligible && (includeBusy || row.busy === null)
    && (row.runnerDetails === undefined || (row.runnerDetails.readiness.state === 'ready' || row.runnerDetails.readiness.code === 'credential_unavailable')))
    .map(row => ({ credentialId: row.credentialId, machineId: row.machineId, offers: row.offers ?? [], capabilities: row.capabilities ?? [], runner: row.runner !== null, credentialChoices: row.runnerDetails?.credentialChoices }));
}

/**
 * Each machine's latest readable offer report, from its stable head. Unknown reports preserve the latest explicit
 * observation; a machine with only unknown reports answers null, and a machine with no contact is absent from the map.
 */
export async function readMachineOffers(db: RelationalStore): Promise<Map<string, ReportedHarness[] | null>> {
  return new Map((await contactedMachineHeads(db)).map(head => [head.machine_id, parseOffers(head.offers)]));
}

/** The latest instant any worker reported in, or null when none ever has. */
export const lastWorkerContactAt = (db: RelationalStore): Promise<number | null> => lastContactAt(db);

/** The capabilities every worker heard from within `CONTACT_RECENT_MS` of `now` reported, one list per worker. */
export async function recentWorkerCapabilities(db: RelationalStore, now: number): Promise<string[][]> {
  return (await recentCapabilityRows(db, now - CONTACT_RECENT_MS)).map((row) => parseCapabilities(row.capabilities) ?? []);
}

/** Recent offers and repository capabilities describe a task's fleet profile gap. */
export async function recentWorkerReports(db: RelationalStore, now: number): Promise<Array<{ credentialId: string; machineId: string | null; offers: ReportedHarness[]; capabilities: string[]; runner: boolean; credentialChoices?: StoredRunnerCredentialChoices }>> {
  const [members, runners] = await recentReportRows(db, now - CONTACT_RECENT_MS, now);
  const memberReports = members.map(row => ({ credentialId: row.credential_id, machineId: row.machine_id, offers: parseOffers(row.offers) ?? [], capabilities: parseCapabilities(row.capabilities) ?? [], runner: false }));
  const runnerReports = runners.flatMap(row => {
    const offers = parseOffers(row.offers);
    const { metadata } = storedUpdateMetadata(row.last_result);
    if (runnerReadiness(row, offers, true, metadata.updateState, now).state !== 'ready') return [];
    return [{ credentialId: row.runner_id, machineId: row.machine_id, offers: offers ?? [], capabilities: parseCapabilities(row.capabilities) ?? [], runner: true, credentialChoices: storedRunnerCredentialChoices(row.credential_choices) }];
  });
  return [...memberReports, ...runnerReports];
}

/**
 * Retire worker contacts not heard from for `olderThanMs`, keeping any that hold a live lease. Bounded to `batch` rows per
 * call, taken by the sweep that already ends a worker's lease; a contact's export is stored before its row goes.
 */
export const pruneWorkerContacts = (store: ContentStore, now: number, olderThanMs: number, batch: number): Promise<number> => retireWorkerContacts(store, now, olderThanMs, batch);


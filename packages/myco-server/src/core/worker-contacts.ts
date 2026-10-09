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
import type { PreparedStatement, RelationalStore } from './adapters.js';
import { WORKER_HEARTBEAT_MS, WORKER_LEASE_MS } from '../constants.js';
import { asMemberRole, isAdmin } from '../auth/roles.js';
import { runParentLive } from '../auth/runners.js';
import { renewingLeaseAuthority, type LeaseHolder } from './worker-lease.js';
import { runnerDisplay, type RunnerFleetRecord, type FleetRun, type RunnerAvailability } from '@goondocks/myco-shared/runner-fleet';
import { MODEL_CATALOG_FRESH_MS, parseModelCatalog } from '@goondocks/myco-shared/execution-profile';
import { isRunnerUpdateText, RUNNER_UPDATE_RESULTS } from '@goondocks/myco-shared/runner-update';
import semver from 'semver';
import type { ProfileCapability } from '@goondocks/myco-shared/execution-profile';

/** A harness a worker reports, as it reports it. `authenticated` is the worker's own probe, not a provider check. */
export interface ReportedHarness {
  id: string;
  authenticated: boolean;
  profile?: ProfileCapability;
}

/** Why the worker's last claim took no run, in the claim's own vocabulary; null when it took one. */
export const CONTACT_OUTCOMES = ['claimed', 'no_work', 'no_harness', 'at_limit', 'lost_race', 'paused'] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

/** Whether a stored value belongs to the contact outcome vocabulary. */
export const isContactOutcome = (value: string): value is ContactOutcome => (CONTACT_OUTCOMES as readonly string[]).includes(value);

/** How much of a worker's report is kept, so one poll can never grow the row without bound. */
const MAX_OFFERS = 16;
const MAX_CAPABILITIES = 16;
const MAX_ID = 64;
const MAX_METADATA = 128;

/**
 * How long an unchanged observation may go unwritten: half the heartbeat, so a
 * worker renewing a lease always refreshes between two writes, while an idle
 * worker polling every `WORKER_POLL_IDLE_MS` writes once per throttle rather
 * than thirty times a minute. A material change — a different offer, a
 * different outcome — is written at once regardless.
 */
export const CONTACT_THROTTLE_MS = WORKER_HEARTBEAT_MS / 2;

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
export interface WorkerContact {
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
    id: offer.id.slice(0, MAX_ID), authenticated: offer.authenticated === true,
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
      offers.push({ id: offer.id, authenticated: offer.authenticated === true, ...(validProfile ? { profile } : {}) });
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
    && offer.authenticated === right[i]?.authenticated && JSON.stringify(offer.profile) === JSON.stringify(right[i]?.profile));
}

/** One worker's stored observation, or null when it has never been recorded. */
export async function readWorkerContact(db: RelationalStore, credentialId: string): Promise<WorkerContact | null> {
  const row = await db.prepare(
    `SELECT credential_id, machine_id, offers, capabilities, last_reason, last_seen_at FROM worker_contacts WHERE credential_id = ?`,
  ).bind(credentialId).first<Record<string, unknown>>();
  if (row == null) return null;
  return {
    credentialId: String(row.credential_id),
    machineId: row.machine_id == null ? null : String(row.machine_id),
    offers: parseOffers(row.offers),
    capabilities: parseCapabilities(row.capabilities),
    lastReason: row.last_reason == null ? null : String(row.last_reason) as ContactOutcome,
    lastSeenAt: Number(row.last_seen_at ?? 0),
  };
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
export async function workerContactStatement(
  db: RelationalStore,
  contact: { credentialId: string; machineId: string | null; offers?: readonly ReportedHarness[]; capabilities?: readonly string[]; reason?: ContactOutcome; now: number },
  lease?: { projectId: string; runId: string; attemptId?: string },
): Promise<PreparedStatement | null> {
  const stored = await readWorkerContact(db, contact.credentialId);
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
    const { results } = await machineContactsStatement(db).all<Record<string, unknown>>();
    const machineId = contact.machineId ?? results.find((row) => row.credential_id === contact.credentialId)?.machine_id;
    if (machineId == null) return null;
    const observation = machineOfferObservationsOf(results).get(String(machineId));
    if (observation !== undefined && observation.offers !== null && sameOffers(observation.offers, offers)) skipRevision = observation.revision;
  }
  const authority = lease === undefined ? null : renewingLeaseAuthority({ kind: 'member', tokenId: contact.credentialId }, contact.now, lease.attemptId);
  return db.prepare(
    `WITH observation AS (
       SELECT ? AS credential_id, ? AS machine_id, ? AS offers, ? AS capabilities, ? AS reason, ? AS seen_at,
              ? AS explicit_offers, ? AS explicit_capabilities, ? AS explicit_reason, ? AS skip_revision
     ), machine_revision AS (
       SELECT COALESCE(MAX(w.updated_at), 0) AS revision
         FROM worker_contacts w CROSS JOIN member_credentials c ON c.id = w.credential_id CROSS JOIN observation o
        WHERE COALESCE(w.machine_id, c.machine_id) IS COALESCE(o.machine_id, (SELECT machine_id FROM member_credentials WHERE id = o.credential_id))
     )
     INSERT INTO worker_contacts (credential_id, machine_id, offers, capabilities, last_reason, last_seen_at, updated_at)
     SELECT credential_id, machine_id, offers, capabilities, reason, seen_at,
            CASE WHEN explicit_offers = 1 THEN MAX(seen_at, revision + 1) ELSE seen_at END
       FROM observation CROSS JOIN machine_revision
      WHERE (skip_revision IS NULL OR revision != skip_revision)${authority === null ? '' : ` AND EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ? AND ${authority.sql})`}
     ON CONFLICT (credential_id) DO UPDATE SET
       machine_id = excluded.machine_id,
       offers = CASE WHEN (SELECT explicit_offers FROM observation) = 1 THEN excluded.offers ELSE worker_contacts.offers END,
       capabilities = CASE WHEN (SELECT explicit_capabilities FROM observation) = 1 THEN excluded.capabilities ELSE worker_contacts.capabilities END,
       last_reason = CASE WHEN (SELECT explicit_reason FROM observation) = 1 THEN excluded.last_reason ELSE worker_contacts.last_reason END,
       last_seen_at = MAX(worker_contacts.last_seen_at, excluded.last_seen_at),
       updated_at = CASE WHEN (SELECT explicit_offers FROM observation) = 1 THEN excluded.updated_at ELSE worker_contacts.updated_at END`,
  ).bind(
    contact.credentialId, contact.machineId, offers === null ? null : JSON.stringify(offers), capabilities === null ? null : JSON.stringify(capabilities),
    reason, contact.now, contact.offers === undefined ? 0 : 1, contact.capabilities === undefined ? 0 : 1,
    contact.reason === undefined ? 0 : 1, skipRevision,
    ...(authority === null ? [] : [lease!.projectId, lease!.runId, ...authority.params]),
  );
}

/**
 * Record a runner's contact under its stable id, with whatever it reports: machine, system and version metadata, its
 * offers and capabilities on a claim, and the claim's outcome. Unsupplied fields keep what is held. An unchanged
 * observation inside `CONTACT_THROTTLE_MS` writes nothing. Given a lease, the write lands only while that runner
 * holds it.
 */
export function runnerContactStatement(
  db: RelationalStore,
  contact: { runnerId: string; machineId?: string | null; os?: string | null; version?: string | null; offers?: readonly ReportedHarness[]; capabilities?: readonly string[]; reason?: ContactOutcome; now: number },
  lease?: { projectId: string; runId: string; attemptId?: string },
  worker?: LeaseHolder,
): PreparedStatement {
  const offers = contact.offers === undefined ? null : JSON.stringify(boundedOffers(contact.offers));
  const capabilities = contact.capabilities === undefined ? null : JSON.stringify(boundedCapabilities(contact.capabilities));
  const explicitOffers = contact.offers === undefined ? 0 : 1;
  const explicitCapabilities = contact.capabilities === undefined ? 0 : 1;
  const authority = lease === undefined || worker === undefined ? null : renewingLeaseAuthority(worker, contact.now, lease.attemptId);
  const text = (value: string | null | undefined, bound: number): string | null => (value == null ? null : value.slice(0, bound));
  return db.prepare(
    `INSERT INTO runner_contacts (runner_id, machine_id, os, version, offers, capabilities, last_reason, last_seen_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1${authority === null ? '' : ` AND EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ? AND ${authority.sql})`}
     ON CONFLICT (runner_id) DO UPDATE SET
       machine_id = COALESCE(excluded.machine_id, runner_contacts.machine_id),
       os = COALESCE(excluded.os, runner_contacts.os),
       version = COALESCE(excluded.version, runner_contacts.version),
       offers = CASE WHEN ${explicitOffers} = 1 THEN excluded.offers ELSE runner_contacts.offers END,
       capabilities = CASE WHEN ${explicitCapabilities} = 1 THEN excluded.capabilities ELSE runner_contacts.capabilities END,
       last_reason = COALESCE(excluded.last_reason, runner_contacts.last_reason),
       last_seen_at = MAX(runner_contacts.last_seen_at, excluded.last_seen_at),
       updated_at = CASE WHEN ${explicitOffers} = 1 THEN MAX(excluded.updated_at, runner_contacts.updated_at + 1) ELSE runner_contacts.updated_at END
     WHERE excluded.last_seen_at - runner_contacts.last_seen_at >= ?
       OR (${explicitOffers} = 1 AND excluded.offers IS NOT runner_contacts.offers)
       OR (${explicitCapabilities} = 1 AND excluded.capabilities IS NOT runner_contacts.capabilities)
       OR (excluded.last_reason IS NOT NULL AND excluded.last_reason IS NOT runner_contacts.last_reason)
       OR (excluded.machine_id IS NOT NULL AND excluded.machine_id IS NOT runner_contacts.machine_id)
       OR (excluded.version IS NOT NULL AND excluded.version IS NOT runner_contacts.version)`,
  ).bind(
    contact.runnerId, text(contact.machineId, MAX_ID), text(contact.os, MAX_METADATA), text(contact.version, MAX_ID), offers, capabilities,
    contact.reason ?? null, contact.now, contact.now,
    ...(authority === null ? [] : [lease!.projectId, lease!.runId, ...authority.params]),
    CONTACT_THROTTLE_MS,
  );
}

/** Record one contact through the same statement used by atomic worker operations. */
export async function recordWorkerContact(db: RelationalStore, contact: Parameters<typeof workerContactStatement>[1]): Promise<boolean> {
  const statement = await workerContactStatement(db, contact);
  return statement !== null && (await statement.run()).meta.changes > 0;
}

/**
 * Every worker this Deployment has heard from, with the run each is driving.
 *
 * Busy comes from the lease, never from a stored reason: a worker whose claim
 * last answered `no_work` and then took a run through another path is
 * still busy, and a worker that holds a lease but has no contact row at all —
 * an older client, or one recorded before this table existed — still appears,
 * as busy, with no contact time.
 */
export async function readWorkerFleet(db: RelationalStore, now: number): Promise<WorkerFleetRow[]> {
  const { results: memberRows } = await db.prepare(
    `WITH inventory AS (
       SELECT credential_id FROM worker_contacts
       UNION SELECT leased_by AS credential_id FROM agent_runs INDEXED BY idx_fleet_legacy_leases
         WHERE status = 'running' AND lease_expires_at > ? AND leased_by IS NOT NULL
     )
     SELECT c.id AS credential_id, c.machine_id AS credential_machine_id, c.revoked_at, c.expires_at,
            m.role AS member_role, m.revoked_at AS member_revoked_at,
            w.machine_id AS contact_machine_id, w.offers, w.capabilities, w.last_reason, w.last_seen_at,
            r.id AS run_id, r.project_id, r.task, r.lease_expires_at
       FROM inventory i
       CROSS JOIN member_credentials c ON c.id = i.credential_id
       LEFT JOIN members m ON m.id = c.member_id
       LEFT JOIN worker_contacts w ON w.credential_id = c.id
       LEFT JOIN agent_runs r INDEXED BY idx_agent_runs_lease ON r.leased_by = c.id AND r.status = 'running' AND r.lease_expires_at > ?`,
  ).bind(now, now).all<Record<string, unknown>>();
  const members = (memberRows ?? []).map((row): WorkerFleetRow => {
    const lastSeenAt = row.last_seen_at == null ? 0 : Number(row.last_seen_at);
    const revoked = row.revoked_at != null;
    const expired = row.expires_at != null && Number(row.expires_at) <= now;
    // The claim route admits an administrator whose member row the Deployment
    // still holds. Eligibility answers the same question with the same rule.
    const role = asMemberRole(row.member_role);
    const admits = row.member_revoked_at == null && role !== null && isAdmin(role);
    return {
      credentialId: String(row.credential_id),
      machineId: (row.contact_machine_id ?? row.credential_machine_id) == null ? null : String(row.contact_machine_id ?? row.credential_machine_id),
      offers: parseOffers(row.offers),
      capabilities: parseCapabilities(row.capabilities),
      lastReason: row.last_reason == null ? null : String(row.last_reason) as ContactOutcome,
      lastSeenAt,
      busy: row.run_id == null ? null : {
        runId: String(row.run_id),
        projectId: String(row.project_id),
        task: row.task == null ? null : String(row.task),
        leaseExpiresAt: Number(row.lease_expires_at ?? 0),
      },
      eligible: !revoked && !expired && admits,
      recent: lastSeenAt > 0 && now - lastSeenAt <= CONTACT_RECENT_MS,
      runner: null,
    };
  });
  const heardAt = (row: WorkerFleetRow): number => (row.lastSeenAt > 0 ? row.lastSeenAt : row.busy?.leaseExpiresAt ?? 0);
  return [...members, ...await readRunnerFleet(db, now)].sort((left, right) => heardAt(right) - heardAt(left));
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

/** The claim path and fleet view use the same readiness admission without reading run history. */
function runnerReadiness(row: Record<string, unknown>, offers: ReportedHarness[] | null, credentialed: boolean,
  updateState: UpdateMetadata['updateState'], now: number): RunnerFleetRecord['readiness'] {
  if (!credentialed) return { state: 'unknown', code: 'registration', reason: 'No current authority to take new work. Approve replacement registration on this machine.', observedAt: now };
  if (updateState?.phase === 'updating' || updateState?.phase === 'probation')
    return { state: 'unknown', code: 'updating', reason: 'An update is holding new work until machine health is confirmed.', observedAt: updateState.since };
  const explicit = row.availability == null ? null : String(row.availability) as RunnerAvailability;
  if (explicit !== null && explicit !== 'ready')
    return { state: explicit, code: explicit, reason: String(row.readiness_reason), observedAt: Number(row.observed_at) };
  if (offers === null) return { state: 'unknown', code: 'unknown', reason: 'Agent sign-in and execution profiles are unavailable.',
    observedAt: row.updated_at == null ? null : Number(row.updated_at) };
  if (!offers.some(offer => offer.authenticated)) return { state: 'unknown', code: 'not_signed_in', reason: 'Reported no signed-in eligible agent.',
    observedAt: row.updated_at == null ? null : Number(row.updated_at) };
  return { state: 'ready', code: 'ready', reason: 'Reports a signed-in agent; provider access is untested.',
    observedAt: row.updated_at == null ? null : Number(row.updated_at) };
}

/**
 * Every registered runner, keyed by its stable id: a rotation never makes a second row. A
 * runner is eligible while it is enabled and holds a credential of its current epoch.
 */
async function readRunnerFleet(db: RelationalStore, now: number): Promise<WorkerFleetRow[]> {
  const latestAttempt = (condition: string, order: string) => `(SELECT json_object('runId', h.run_id, 'projectId', h.project_id,
    'projectName', (SELECT name FROM projects WHERE project_id = h.project_id),
    'task', (SELECT task FROM agent_runs WHERE project_id = h.project_id AND id = h.run_id),
    'at', ${order}, 'status', 'attempted') FROM agent_run_attempts h
    WHERE h.runner_id = r.id ${condition} ORDER BY ${order} DESC, h.attempt_id DESC LIMIT 1)`;
  const latestTerminal = (status: string) => `(SELECT json_object('runId', h.id, 'projectId', h.project_id,
    'projectName', (SELECT name FROM projects WHERE project_id = h.project_id), 'task', h.task,
    'at', h.completed_at, 'status', h.status) FROM agent_runs h INDEXED BY idx_runner_run_terminal
    WHERE h.leased_runner_id = r.id AND h.status = '${status}'
      AND EXISTS (SELECT 1 FROM agent_run_attempts t WHERE t.project_id = h.project_id AND t.run_id = h.id AND t.attempt_id = h.dispatched_by AND t.runner_id = r.id)
    ORDER BY h.completed_at DESC, h.id DESC LIMIT 1)`;
  const { results } = await db.prepare(
    `SELECT r.id, r.name, r.state, r.revision, r.created_at, r.created_by_member, r.removed_at, r.labels,
            r.last_contact_at, r.replacement_pending,
            w.machine_id, w.os, COALESCE(u.current_version, w.version) AS version,
            w.offers, w.capabilities, w.last_reason, w.last_seen_at, w.updated_at,
            o.arch, o.availability, o.reason AS readiness_reason, o.observed_at,
            a.id AS run_id, a.project_id, (SELECT name FROM projects WHERE project_id = a.project_id) AS project_name,
            a.task, a.started_at, a.lease_expires_at,
            u.channel, u.latest_version, u.last_check_at, u.last_result,
            q.id AS update_request_id, q.requested_at,
            ${latestAttempt('', 'h.claimed_at')} AS last_attempted,
            ${latestTerminal('completed')} AS last_completed,
            ${latestTerminal('failed')} AS last_failed,
            (SELECT json_group_array(json_object('harness', mc.harness, 'catalog', mc.catalog,
              'fetchedAt', mc.fetched_at, 'receivedAt', mc.received_at)) FROM runner_model_catalogs mc WHERE mc.runner_id = r.id) AS models,
            EXISTS (SELECT 1 FROM runner_credentials c WHERE c.runner_id = r.id AND c.epoch = r.credential_epoch
              AND c.revoked_at IS NULL AND c.expires_at > ?) AS credentialed
       FROM runners r
       LEFT JOIN runner_contacts w ON w.runner_id = r.id
       LEFT JOIN runner_observations o ON o.runner_id = r.id
       LEFT JOIN runner_update_reports u ON u.runner_id = r.id
       LEFT JOIN runner_update_requests q ON q.runner_id = r.id
       LEFT JOIN agent_runs a INDEXED BY idx_agent_runs_runner_lease ON a.leased_runner_id = r.id AND a.status = 'running' AND a.lease_expires_at > ?
         AND ${runParentLive('a')}
       ORDER BY r.created_at DESC, r.id`,
  ).bind(now, now).all<Record<string, unknown>>();
  return results.map((row) => {
    const lastSeenAt = row.last_seen_at == null ? 0 : Number(row.last_seen_at);
    const historicalContactAt = row.last_contact_at == null ? 0 : Number(row.last_contact_at);
    const state = String(row.state) as RunnerFleetRecord['state'];
    const offers = parseOffers(row.offers);
    const capabilities = parseCapabilities(row.capabilities);
    const busy = row.run_id == null ? null : {
      runId: String(row.run_id), projectId: String(row.project_id), projectName: row.project_name == null ? null : String(row.project_name),
      task: row.task == null ? null : String(row.task), at: Number(row.started_at), status: 'running', leaseExpiresAt: Number(row.lease_expires_at),
    };
    const { metadata, unavailable: updateMetadataUnavailable } = storedUpdateMetadata(row.last_result);
    const readiness = runnerReadiness(row, offers, Number(row.credentialed) === 1, metadata.updateState, now);
    const terminal = (value: unknown): FleetRun | null => value == null ? null : JSON.parse(String(value)) as FleetRun;
    const lastAttempted = terminal(row.last_attempted);
    const displaySeenAt = Math.max(lastSeenAt, historicalContactAt, lastAttempted?.at ?? 0);
    const connected = state !== 'removed' && lastSeenAt > 0 && now - lastSeenAt <= CONTACT_RECENT_MS;
    const details: RunnerFleetRecord = {
      id: String(row.id), name: String(row.name), state, revision: Number(row.revision),
      createdAt: Number(row.created_at), createdBy: row.created_by_member == null ? null : String(row.created_by_member),
      removedAt: row.removed_at == null ? null : Number(row.removed_at),
      lastSeenAt: displaySeenAt || null, connected, busy, display: 'Never contacted',
      awaitingReplacement: Number(row.replacement_pending) === 1, updateMetadataUnavailable,
      lastAttempted, lastCompleted: terminal(row.last_completed), lastFailed: terminal(row.last_failed),
      offers, offersObservedAt: offers === null || row.updated_at == null ? null : Number(row.updated_at),
      capabilities, labels: parseCapabilities(row.labels), preference: null,
      os: row.os == null ? null : String(row.os), arch: row.arch == null ? null : String(row.arch),
      version: row.version == null ? null : String(row.version), readiness,
      lastReason: row.last_reason == null ? null : String(row.last_reason),
      models: (JSON.parse(String(row.models)) as Array<{ harness: string; catalog: string; fetchedAt: number; receivedAt: number }>).map(model => {
        let value: unknown;
        try { value = JSON.parse(model.catalog); } catch { value = null; }
        const catalog = parseModelCatalog(value);
        return { harness: model.harness, source: catalog?.source.command ?? null,
          fetchedAt: model.fetchedAt, receivedAt: model.receivedAt, fresh: model.receivedAt >= now - MODEL_CATALOG_FRESH_MS,
          available: catalog !== null };
      }),
      channel: row.channel == null ? null : row.channel as RunnerFleetRecord['channel'],
      latestVersion: row.latest_version == null ? null : String(row.latest_version),
      updateAvailable: typeof row.version === 'string' && typeof row.latest_version === 'string'
        && semver.valid(row.version) !== null && semver.valid(row.latest_version) !== null
        && semver.gt(row.latest_version, row.version),
      lastCheckAt: row.last_check_at == null ? null : Number(row.last_check_at), ...metadata,
      updateRequest: row.update_request_id == null ? null : { id: String(row.update_request_id), requestedAt: Number(row.requested_at), clearBlock: true },
    };
    details.display = runnerDisplay(details);
    return {
      credentialId: details.id, machineId: row.machine_id == null ? null : String(row.machine_id), offers, capabilities,
      lastReason: details.lastReason as ContactOutcome | null, lastSeenAt: displaySeenAt, busy,
      eligible: state === 'enabled' && Number(row.credentialed) === 1,
      recent: connected, runner: { id: details.id, name: details.name, state }, runnerDetails: details,
    };
  });
}

/** Record bounded, non-secret machine readiness from the supervisor's own contact loop. */
export function runnerObservationStatement(db: RelationalStore, runnerId: string, observation: { arch: string | null; state: RunnerAvailability; reason: string }, now: number): PreparedStatement {
  return db.prepare(`INSERT INTO runner_observations(runner_id,arch,availability,reason,observed_at) VALUES (?,?,?,?,?)
    ON CONFLICT(runner_id) DO UPDATE SET arch = COALESCE(excluded.arch, runner_observations.arch),
      availability = excluded.availability, reason = excluded.reason, observed_at = excluded.observed_at
    WHERE excluded.observed_at >= runner_observations.observed_at AND (runner_observations.availability <> excluded.availability OR runner_observations.reason <> excluded.reason
      OR runner_observations.arch IS NOT COALESCE(excluded.arch, runner_observations.arch)
      OR runner_observations.observed_at <= excluded.observed_at - ${CONTACT_THROTTLE_MS})`)
    .bind(runnerId, observation.arch, observation.state, observation.reason, now);
}

/** A replacement must report its own contact and readiness before it is considered connected. */
export function invalidateRunnerContacts(db: RelationalStore, runnerId: string): PreparedStatement[] {
  return ['runner_contacts', 'runner_observations'].map(table => db.prepare(`DELETE FROM ${table} WHERE runner_id = ?`).bind(runnerId));
}

/** Fresh reports share control, capacity and readiness admission across every preview. */
export function fleetReports(fleet: readonly WorkerFleetRow[], includeBusy = false) {
  return fleet.filter(row => row.recent && row.eligible && (includeBusy || row.busy === null)
    && (row.runnerDetails === undefined || row.runnerDetails.readiness.state === 'ready'))
    .map(row => ({ credentialId: row.credentialId, machineId: row.machineId, offers: row.offers ?? [], capabilities: row.capabilities ?? [], runner: row.runner !== null }));
}

/** A machine's latest explicit offers, contact and run. */
export interface MachineContact {
  /** The harnesses the latest readable explicit report offered. */
  offers: ReportedHarness[] | null;
  lastSeenAt: number;
  /** When a run leased by any credential the machine reported from last started; null when none has. */
  lastRunAt: number | null;
}

/**
 * Every worker report with the machine it came from, newest first: the machine the worker named, or else the one its
 * credential joined as, ordered by contact time or explicit offer revision. Each carries the latest start of a run its
 * credential leased, sought down the lease index by that one credential; the index is named, as statistics that see
 * every run unleased would walk the runs instead.
 */
export function machineContactsStatement(db: RelationalStore, order: 'contact' | 'offers' = 'contact'): PreparedStatement {
  return db.prepare(
    `SELECT COALESCE(w.machine_id, c.machine_id) AS machine_id, w.credential_id, w.offers, w.updated_at AS offer_revision, w.last_seen_at,
            (SELECT MAX(r.started_at) FROM agent_runs r INDEXED BY idx_agent_runs_lease WHERE r.leased_by = w.credential_id) AS last_run_at
       FROM worker_contacts w
      CROSS JOIN member_credentials c ON c.id = w.credential_id
      ORDER BY ${order === 'offers' ? 'w.updated_at' : 'w.last_seen_at'} DESC`,
  );
}

interface MachineOfferObservation {
  offers: ReportedHarness[] | null;
  revision: number;
  explicitRevision: number;
}

/** Machine liveness is independent of the revision of its latest readable offer report. */
function machineOfferObservationsOf(rows: readonly unknown[]): Map<string, MachineOfferObservation> {
  const observations = new Map<string, MachineOfferObservation>();
  for (const row of rows as Record<string, unknown>[]) {
    if (row.machine_id == null) continue;
    const machineId = String(row.machine_id);
    const revision = Number(row.offer_revision);
    const offers = parseOffers(row.offers);
    const held = observations.get(machineId);
    if (held === undefined) observations.set(machineId, { offers, revision, explicitRevision: offers === null ? -Infinity : revision });
    else {
      held.revision = Math.max(held.revision, revision);
      if (offers !== null && revision > held.explicitRevision) {
        held.offers = offers;
        held.explicitRevision = revision;
      }
    }
  }
  return observations;
}

/** Each machine's latest offers, contact and run, from what `machineContactsStatement` answers. */
export function machineContactsOf(rows: readonly unknown[]): Map<string, MachineContact> {
  const offers = machineOfferObservationsOf(rows);
  const contacts = new Map<string, MachineContact>();
  for (const row of rows as Record<string, unknown>[]) {
    if (row.machine_id == null) continue;
    const machineId = String(row.machine_id);
    const run = row.last_run_at == null ? null : Number(row.last_run_at);
    const seen = Number(row.last_seen_at);
    const held = contacts.get(machineId);
    if (held === undefined) contacts.set(machineId, { offers: offers.get(machineId)!.offers, lastSeenAt: seen, lastRunAt: run });
    else {
      held.lastSeenAt = Math.max(held.lastSeenAt, seen);
      if (run !== null && (held.lastRunAt === null || run > held.lastRunAt)) held.lastRunAt = run;
    }
  }
  return contacts;
}

/**
 * Each machine's latest readable offer report. Unknown reports preserve the latest explicit observation; a machine
 * with only unknown reports answers null, and a machine with no contact is absent from the map.
 */
export async function readMachineOffers(db: RelationalStore): Promise<Map<string, ReportedHarness[] | null>> {
  const { results } = await machineContactsStatement(db).all<Record<string, unknown>>();
  return new Map(Array.from(machineOfferObservationsOf(results), ([machineId, observation]) => [machineId, observation.offers]));
}

/** The latest instant any worker reported in, or null when none ever has. */
export async function lastWorkerContactAt(db: RelationalStore): Promise<number | null> {
  const row = await db.prepare(`SELECT MAX(at) AS at FROM (SELECT MAX(last_seen_at) AS at FROM worker_contacts UNION ALL SELECT MAX(last_seen_at) FROM runner_contacts)`).first<{ at: number | null }>();
  return row?.at ?? null;
}

/** The capabilities every worker heard from within `CONTACT_RECENT_MS` of `now` reported, one list per worker. */
export async function recentWorkerCapabilities(db: RelationalStore, now: number): Promise<string[][]> {
  const { results } = await db.prepare(`SELECT capabilities FROM worker_contacts WHERE last_seen_at >= ?
    UNION ALL SELECT w.capabilities FROM runner_contacts w JOIN runners r ON r.id = w.runner_id WHERE w.last_seen_at >= ? AND r.state = 'enabled'`)
    .bind(now - CONTACT_RECENT_MS, now - CONTACT_RECENT_MS).all<{ capabilities: unknown }>();
  return (results ?? []).map((row) => parseCapabilities(row.capabilities) ?? []);
}

/** Recent offers and repository capabilities describe a task's fleet profile gap. */
export async function recentWorkerReports(db: RelationalStore, now: number): Promise<Array<{ credentialId: string; machineId: string | null; offers: ReportedHarness[]; capabilities: string[]; runner: boolean }>> {
  const since = now - CONTACT_RECENT_MS;
  const [{ results: members }, { results: runners }] = await Promise.all([
    db.prepare(`SELECT w.credential_id, COALESCE(w.machine_id, c.machine_id) AS machine_id, w.offers, w.capabilities
      FROM worker_contacts w INDEXED BY idx_worker_contacts_seen
      JOIN member_credentials c ON c.id = w.credential_id
      JOIN members m ON m.id = c.member_id
      WHERE w.last_seen_at >= ? AND c.revoked_at IS NULL AND c.expires_at > ? AND m.revoked_at IS NULL AND m.role = 'admin'`)
      .bind(since, now).all<Record<string, unknown>>(),
    db.prepare(`SELECT w.runner_id, w.machine_id, w.offers, w.capabilities, w.updated_at,
        o.availability, o.reason AS readiness_reason, o.observed_at, u.last_result
      FROM runner_contacts w INDEXED BY idx_runner_contacts_seen
      JOIN runners r ON r.id = w.runner_id
      LEFT JOIN runner_observations o ON o.runner_id = r.id
      LEFT JOIN runner_update_reports u ON u.runner_id = r.id
      WHERE w.last_seen_at >= ? AND r.state = 'enabled' AND EXISTS (
        SELECT 1 FROM runner_credentials c WHERE c.runner_id = r.id AND c.epoch = r.credential_epoch
          AND c.revoked_at IS NULL AND c.expires_at > ?)`)
      .bind(since, now).all<Record<string, unknown>>(),
  ]);
  const memberReports = members.map(row => ({ credentialId: String(row.credential_id),
    machineId: row.machine_id == null ? null : String(row.machine_id), offers: parseOffers(row.offers) ?? [],
    capabilities: parseCapabilities(row.capabilities) ?? [], runner: false }));
  const runnerReports = runners.flatMap(row => {
    const offers = parseOffers(row.offers);
    const { metadata } = storedUpdateMetadata(row.last_result);
    if (runnerReadiness(row, offers, true, metadata.updateState, now).state !== 'ready') return [];
    return [{ credentialId: String(row.runner_id), machineId: row.machine_id == null ? null : String(row.machine_id),
      offers: offers ?? [], capabilities: parseCapabilities(row.capabilities) ?? [], runner: true }];
  });
  return [...memberReports, ...runnerReports];
}

/**
 * Forget revoked workers not heard from for `olderThanMs`, keeping any that
 * hold a live lease. Unrevoked legacy contacts remain in the migration inventory. Bounded to `batch` rows per call, taken by the sweep that already ends
 * a worker's lease.
 */
export async function pruneWorkerContacts(db: RelationalStore, now: number, olderThanMs: number, batch: number): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM worker_contacts
      WHERE credential_id IN (
        SELECT credential_id FROM worker_contacts
         WHERE last_seen_at < ?
           AND credential_id IN (SELECT c.id FROM member_credentials c LEFT JOIN members m ON m.id = c.member_id WHERE c.revoked_at IS NOT NULL OR m.revoked_at IS NOT NULL)
           AND credential_id NOT IN (SELECT leased_by FROM agent_runs WHERE leased_by IS NOT NULL AND status = 'running' AND lease_expires_at > ?)
         ORDER BY last_seen_at
         LIMIT ?)`,
  ).bind(now - olderThanMs, now, batch).run();
  const runners = await db.prepare(
    `DELETE FROM runner_contacts
      WHERE runner_id IN (
        SELECT runner_id FROM runner_contacts
         WHERE last_seen_at < ?
           AND runner_id NOT IN (SELECT leased_runner_id FROM agent_runs INDEXED BY idx_agent_runs_runner_lease
             WHERE leased_runner_id IS NOT NULL AND status = 'running' AND lease_expires_at > ?)
         ORDER BY last_seen_at
         LIMIT ?)`,
  ).bind(now - olderThanMs, now, batch).run();
  return (result.meta.changes ?? 0) + (runners.meta.changes ?? 0);
}

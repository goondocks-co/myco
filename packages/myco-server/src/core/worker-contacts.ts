/**
 * What each worker last said about itself, and what the Deployment makes of it.
 *
 * A lease is a fact about a busy worker. An attached idle worker left no trace
 * at all, so an idle worker and no worker read alike (`workerLiveness`). This
 * module is the one writer and the one reader of that missing trace: the claim
 * records contact even when it answers `no_work`, a lease renewal refreshes it
 * for a worker driving a run, which stops polling while it does, and the
 * fleet read joins both against the leases that are the authority on busy.
 *
 * What it records is only what the existing claim contract already carries: the
 * harnesses a worker reports offering, whether it reports each as logged in,
 * the capabilities it names, and the outcome of its last claim. Those are the
 * worker's own report of its local probes — never a test that a provider would
 * accept a request — and every surface built on them says so.
 *
 * What it does not do: it decides nothing about scheduling or selection, it
 * merges no two credentials into one worker, and it stores no token, no
 * credential environment and no part of a request body beyond the fields the
 * claim route already parses.
 */
import type { RelationalStore } from './adapters.js';
import { WORKER_HEARTBEAT_MS, WORKER_LEASE_MS } from '../constants.js';

/** A harness a worker reports, as it reports it. `authenticated` is the worker's own probe, not a provider check. */
export interface ReportedHarness {
  id: string;
  authenticated: boolean;
}

/** Why the worker's last claim took no run, in the claim's own vocabulary; null when it took one. */
export type ContactOutcome = 'claimed' | 'no_work' | 'no_harness' | 'at_limit' | 'lost_race';

/** How much of a worker's report is kept, so one poll can never grow the row without bound. */
const MAX_OFFERS = 16;
const MAX_CAPABILITIES = 16;
const MAX_ID = 64;

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
  offers: ReportedHarness[];
  capabilities: string[];
  lastReason: ContactOutcome | null;
  lastSeenAt: number;
}

/** One attached-or-remembered worker, as the status surface reports it. */
export interface WorkerFleetRow extends WorkerContact {
  /** Held from a live lease, which is the authority on busy — never inferred from the last claim reason. */
  busy: { runId: string; projectId: string; task: string | null; leaseExpiresAt: number } | null;
  /** Whether the credential may still take new work; a revoked or expired one may not. */
  eligible: boolean;
  /** Whether the last contact is inside `CONTACT_RECENT_MS`. */
  recent: boolean;
}

function boundedOffers(offers: readonly ReportedHarness[]): ReportedHarness[] {
  return offers.slice(0, MAX_OFFERS).map((offer) => ({ id: offer.id.slice(0, MAX_ID), authenticated: offer.authenticated === true }));
}

function boundedCapabilities(capabilities: readonly string[]): string[] {
  return capabilities.slice(0, MAX_CAPABILITIES).map((capability) => capability.slice(0, MAX_ID));
}

function parseOffers(raw: unknown): ReportedHarness[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is ReportedHarness => entry !== null && typeof entry === 'object'
        && typeof (entry as ReportedHarness).id === 'string').map((entry) => ({ id: entry.id, authenticated: entry.authenticated === true }))
      : [];
  } catch {
    return [];
  }
}

function parseCapabilities(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** Whether two observations say the same thing, so an unchanged one can wait for the throttle. */
function unchanged(stored: WorkerContact | null, offers: readonly ReportedHarness[], capabilities: readonly string[], reason: ContactOutcome | null): boolean {
  if (stored === null) return false;
  if (stored.lastReason !== reason) return false;
  if (stored.offers.length !== offers.length || stored.capabilities.length !== capabilities.length) return false;
  return stored.offers.every((offer, i) => offer.id === offers[i]?.id && offer.authenticated === offers[i]?.authenticated)
    && stored.capabilities.every((capability, i) => capability === capabilities[i]);
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
 * inside `CONTACT_THROTTLE_MS` is skipped; a changed one is written at once.
 * Answers whether a row is written.
 */
export async function recordWorkerContact(
  db: RelationalStore,
  contact: { credentialId: string; machineId: string | null; offers?: readonly ReportedHarness[]; capabilities?: readonly string[]; reason?: ContactOutcome; now: number },
): Promise<boolean> {
  const stored = await readWorkerContact(db, contact.credentialId);
  // A lease renewal carries no offer of its own; it refreshes the liveness of
  // what the worker last reported rather than erasing it.
  const offers = boundedOffers(contact.offers ?? stored?.offers ?? []);
  const capabilities = boundedCapabilities(contact.capabilities ?? stored?.capabilities ?? []);
  const reason = contact.reason ?? stored?.lastReason ?? null;
  if (unchanged(stored, offers, capabilities, reason) && contact.now - stored!.lastSeenAt < CONTACT_THROTTLE_MS) return false;
  await db.prepare(
    `INSERT INTO worker_contacts (credential_id, machine_id, offers, capabilities, last_reason, last_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (credential_id) DO UPDATE SET
       machine_id = excluded.machine_id, offers = excluded.offers, capabilities = excluded.capabilities,
       last_reason = excluded.last_reason, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at`,
  ).bind(
    contact.credentialId, contact.machineId, JSON.stringify(offers), JSON.stringify(capabilities),
    reason, contact.now, contact.now,
  ).run();
  return true;
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
  const { results } = await db.prepare(
    `SELECT c.id AS credential_id, c.machine_id AS credential_machine_id, c.revoked_at, c.expires_at,
            w.machine_id AS contact_machine_id, w.offers, w.capabilities, w.last_reason, w.last_seen_at,
            r.id AS run_id, r.project_id, r.task, r.lease_expires_at
       FROM member_credentials c
       LEFT JOIN worker_contacts w ON w.credential_id = c.id
       LEFT JOIN agent_runs r ON r.leased_by = c.id AND r.status = 'running' AND r.lease_expires_at > ?
      WHERE w.credential_id IS NOT NULL OR r.id IS NOT NULL
      ORDER BY COALESCE(w.last_seen_at, r.lease_expires_at) DESC`,
  ).bind(now).all<Record<string, unknown>>();
  return (results ?? []).map((row) => {
    const lastSeenAt = row.last_seen_at == null ? 0 : Number(row.last_seen_at);
    const revoked = row.revoked_at != null;
    const expired = row.expires_at != null && Number(row.expires_at) <= now;
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
      eligible: !revoked && !expired,
      recent: lastSeenAt > 0 && now - lastSeenAt <= CONTACT_RECENT_MS,
    };
  });
}

/**
 * Forget workers not heard from for `olderThanMs`, keeping any that still hold
 * a live lease. One row per credential and a fixed horizon: there is no
 * retention framework here and no scheduler of its own — the maintenance pass
 * that already sweeps expired credentials calls this.
 */
export async function pruneWorkerContacts(db: RelationalStore, now: number, olderThanMs: number): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM worker_contacts
      WHERE last_seen_at < ?
        AND credential_id NOT IN (SELECT leased_by FROM agent_runs WHERE leased_by IS NOT NULL AND status = 'running' AND lease_expires_at > ?)`,
  ).bind(now - olderThanMs, now).run();
  return result.meta.changes ?? 0;
}

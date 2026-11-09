import type { BlobStore, ContentStore, RelationalStore } from '../../core/adapters.js';
import { CONTACT_THROTTLE_MS } from '../../constants.js';
import { emit, classify } from '../../telemetry.js';
import { sha256Hex } from '../../hash.js';
import { commit, commitNamed, first, read, readSet, write, type Bound } from '../index.js';
import { jsonKeys } from '../ddl.js';

export interface WorkerContactRow {
  credential_id: string;
  machine_id: string | null;
  offers: string | null;
  capabilities: string | null;
  last_reason: string | null;
  last_seen_at: number;
}

const contactRead = read<[credential: string], WorkerContactRow>({ name: 'runners.workerContact', sql:
  'SELECT credential_id, machine_id, offers, capabilities, last_reason, last_seen_at FROM worker_contacts WHERE credential_id = ?1' });
export const workerContactRow = (db: RelationalStore, credentialId: string): Promise<WorkerContactRow | null> => first(db, contactRead.bind(credentialId));

const lastContact = read<[], { at: number | null }>({ name: 'runners.lastContact', sql:
  'SELECT MAX(at) AS at FROM (SELECT MAX(last_seen_at) AS at FROM worker_contacts UNION ALL SELECT MAX(last_seen_at) FROM runner_contacts)' });
/** The latest instant any worker reported in, or null when none ever has. */
export const lastContactAt = async (db: RelationalStore): Promise<number | null> => (await first(db, lastContact.bind()))?.at ?? null;

const recentCapabilitiesRead = read<[since: number], { capabilities: string | null }>({ name: 'runners.recentCapabilities', sql:
  `SELECT capabilities FROM worker_contacts WHERE last_seen_at >= ?1
    UNION ALL SELECT w.capabilities FROM runner_contacts w JOIN runners r ON r.id = w.runner_id WHERE w.last_seen_at >= ?1 AND r.state = 'enabled'` });
export const recentCapabilityRows = async (db: RelationalStore, since: number) => (await readSet(db, recentCapabilitiesRead.bind(since)))[0];

export interface RecentMemberReport { credential_id: string; machine_id: string | null; offers: string | null; capabilities: string | null }
export interface RecentRunnerReport {
  runner_id: string;
  machine_id: string | null;
  offers: string | null;
  capabilities: string | null;
  updated_at: number;
  credential_choices: string;
  availability: string | null;
  readiness_reason: string | null;
  observed_at: number | null;
  last_result: string | null;
}

const recentMembers = read<[since: number, now: number], RecentMemberReport>({ name: 'runners.recentMemberReports', sql:
  `SELECT w.credential_id, COALESCE(w.machine_id, c.machine_id) AS machine_id, w.offers, w.capabilities
    FROM worker_contacts w INDEXED BY idx_worker_contacts_seen
    JOIN member_credentials c ON c.id = w.credential_id
    JOIN members m ON m.id = c.member_id
    WHERE w.last_seen_at >= ?1 AND c.revoked_at IS NULL AND c.expires_at > ?2 AND m.revoked_at IS NULL AND m.role = 'admin'` });
const recentRunners = read<[since: number, now: number], RecentRunnerReport>({ name: 'runners.recentRunnerReports', sql:
  `SELECT w.runner_id, w.machine_id, w.offers, w.capabilities, w.updated_at, r.credential_choices,
      o.availability, o.reason AS readiness_reason, o.observed_at, u.last_result
    FROM runner_contacts w INDEXED BY idx_runner_contacts_seen
    JOIN runners r ON r.id = w.runner_id
    LEFT JOIN runner_observations o ON o.runner_id = r.id
    LEFT JOIN runner_update_reports u ON u.runner_id = r.id
    WHERE w.last_seen_at >= ?1 AND r.state = 'enabled' AND EXISTS (
      SELECT 1 FROM runner_credentials c WHERE c.runner_id = r.id AND c.epoch = r.credential_epoch
        AND c.revoked_at IS NULL AND c.expires_at > ?2)` });
/** Workers heard from at or after the given instant that may still claim, in one snapshot. */
export const recentReportRows = (db: RelationalStore, since: number, now: number) => readSet(db, recentMembers.bind(since, now), recentRunners.bind(since, now));

const upsertObservation = write<[runner: string, arch: string | null, state: string, reason: string, now: number]>({ name: 'runners.observation', sql:
  `INSERT INTO runner_observations(runner_id,arch,availability,reason,observed_at) VALUES (?1,?2,?3,?4,?5)
    ON CONFLICT(runner_id) DO UPDATE SET arch = COALESCE(excluded.arch, runner_observations.arch),
      availability = excluded.availability, reason = excluded.reason, observed_at = excluded.observed_at
    WHERE excluded.observed_at >= runner_observations.observed_at AND (runner_observations.availability <> excluded.availability OR runner_observations.reason <> excluded.reason
      OR runner_observations.arch IS NOT COALESCE(excluded.arch, runner_observations.arch)
      OR runner_observations.observed_at <= excluded.observed_at - ${CONTACT_THROTTLE_MS})` });
export const runnerObservationWrite = (runnerId: string, observation: { arch: string | null; state: string; reason: string }, now: number): Bound =>
  upsertObservation.bind(runnerId, observation.arch, observation.state, observation.reason, now);

const clearRunnerContact = write<[runner: string]>({ name: 'runners.clearContact', sql: 'DELETE FROM runner_contacts WHERE runner_id = ?1' });
const clearRunnerObservation = write<[runner: string]>({ name: 'runners.clearObservation', sql: 'DELETE FROM runner_observations WHERE runner_id = ?1' });
/** A replacement must report its own contact and readiness before it is considered connected. */
export const runnerContactInvalidations = (runnerId: string): readonly Bound[] => [clearRunnerContact.bind(runnerId), clearRunnerObservation.bind(runnerId)];

const EXPORT_FORMAT = 'myco-legacy-worker-contacts/1';
const EXPORT_PREFIX = 'exports/legacy-worker-contacts/';

interface LegacyContactRow extends WorkerContactRow { updated_at: number; last_claim_at: number | null }

/** Contacts past the horizon no live lease holds, oldest first. `?3` keeps a page bounded on the seen index. */
const expiredContacts = read<[cutoff: number, now: number, batch: number], LegacyContactRow>({ name: 'runners.expiredWorkerContacts', sql:
  `SELECT w.credential_id, w.machine_id, w.offers, w.capabilities, w.last_reason, w.last_seen_at, w.updated_at, w.last_claim_at
    FROM worker_contacts w INDEXED BY idx_worker_contacts_seen
    WHERE w.last_seen_at < ?1
      AND NOT EXISTS (SELECT 1 FROM agent_runs r INDEXED BY idx_agent_runs_lease WHERE r.leased_by = w.credential_id AND r.status = 'running' AND r.lease_expires_at > ?2)
    ORDER BY w.last_seen_at LIMIT ?3` });

const recordExport = write<[key: string, digest: string, rows: number, now: number]>({ name: 'runners.recordContactExport', sql:
  `INSERT INTO legacy_contact_exports(object_key,sha256,row_count,exported_at) VALUES (?1,?2,?3,?4) ON CONFLICT(object_key) DO NOTHING` });
const deleteExported = write<[keys: string, now: number, key: string], { credential_id: string }>({ name: 'runners.deleteExportedContacts', sql:
  `DELETE FROM worker_contacts WHERE (credential_id, last_seen_at) IN (${jsonKeys(['credential_id', 'last_seen_at'])})
    AND EXISTS (SELECT 1 FROM legacy_contact_exports e WHERE e.object_key = ?3)
    AND NOT EXISTS (SELECT 1 FROM agent_runs r INDEXED BY idx_agent_runs_lease WHERE r.leased_by = worker_contacts.credential_id AND r.status = 'running' AND r.lease_expires_at > ?2)
    RETURNING credential_id` });

/** Stores one page of contacts as a verified export object and answers its key; `null` when the store did not keep it. */
async function exportContacts(blobs: BlobStore, contacts: readonly LegacyContactRow[], now: number): Promise<{ key: string; digest: string } | null> {
  const body = JSON.stringify({ format: EXPORT_FORMAT, exportedAt: now, contacts });
  const digest = await sha256Hex(body);
  const key = `${EXPORT_PREFIX}${digest}.json`;
  const bytes = new TextEncoder().encode(body);
  await blobs.put(key, new Response(bytes).body, { httpMetadata: { contentType: 'application/json' } });
  const stored = await blobs.head(key);
  return stored?.size === bytes.byteLength ? { key, digest } : null;
}

/**
 * Retires one page of worker contacts unheard from past the horizon: their rows are written to an export object, the
 * object is confirmed stored, and only then does one commit record it and delete exactly those rows, unchanged and unleased.
 * A failed export deletes nothing, and the page is taken again on the next sweep.
 */
async function retireExpiredWorkerContacts(store: ContentStore, now: number, cutoff: number, batch: number): Promise<number> {
  const contacts = (await readSet(store.db, expiredContacts.bind(cutoff, now, batch)))[0];
  if (contacts.length === 0) return 0;
  let exported: { key: string; digest: string } | null;
  try { exported = await exportContacts(store.blobs, contacts, now); }
  catch (error) { emit({ kind: 'legacy_contact_export_failed', errorClass: classify(error) }); return 0; }
  if (exported === null) { emit({ kind: 'legacy_contact_export_failed', errorClass: 'unverified' }); return 0; }
  const { deleted } = await commitNamed(store.db, {
    recorded: recordExport.bind(exported.key, exported.digest, contacts.length, now),
    deleted: deleteExported.bind(JSON.stringify(contacts.map(row => [row.credential_id, row.last_seen_at])), now, exported.key),
  });
  return deleted.results.length;
}

const pruneRunners = write<[cutoff: number, now: number, batch: number], { runner_id: string }>({ name: 'runners.pruneRunnerContacts', sql:
  `DELETE FROM runner_contacts WHERE runner_id IN (
    SELECT runner_id FROM runner_contacts WHERE last_seen_at < ?1
      AND runner_id NOT IN (SELECT leased_runner_id FROM agent_runs INDEXED BY idx_agent_runs_runner_lease WHERE leased_runner_id IS NOT NULL AND status = 'running' AND lease_expires_at > ?2)
    ORDER BY last_seen_at LIMIT ?3) RETURNING runner_id` });

/** The bounded contact sweep: worker contacts past the horizon go through their export, and runner contacts are forgotten. */
export async function retireWorkerContacts(store: ContentStore, now: number, olderThanMs: number, batch: number): Promise<number> {
  const workers = await retireExpiredWorkerContacts(store, now, now - olderThanMs, batch);
  const [runners] = await commit(store.db, pruneRunners.bind(now - olderThanMs, now, batch));
  return workers + runners.results.length;
}

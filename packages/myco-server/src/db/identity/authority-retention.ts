import type { RelationalStore } from '../../core/adapters.js';
import { trigger, changed } from '../ddl.js';
import { commitNamed, first, read, write } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long a spent, expired or revoked invitation is kept. A finished authority is audit material, not a credential:
 * `used_at` and `used_by_runtime` say which runtime spent which invitation, worth having while a join is still recent
 * enough to be questioned. The join it authorised is recorded on the credential itself, so nothing resolves through it.
 */
export const ENROLLMENT_RETENTION_MS = 30 * DAY_MS;
/** How long a finished identity link key, and the receipt of its redemption, are kept. */
export const IDENTITY_LINK_RETENTION_MS = 7 * DAY_MS;

const FINISHED_COLUMNS = ['used_at', 'revoked_at', 'expires_at'];
const RETENTION_PROJECTION = 'authority_retention';

/** The instant a row of an authority table is due: its first terminal fact (spent or revoked), or its expiry, plus retention. */
const dueAt = (row: string, retentionMs: number): string => `(CASE WHEN ${row}.used_at IS NOT NULL OR ${row}.revoked_at IS NOT NULL
  THEN MIN(COALESCE(${row}.used_at,${row}.revoked_at),COALESCE(${row}.revoked_at,${row}.used_at))
  ELSE ${row}.expires_at END+${retentionMs})`;

/** An authority past its reclaim deadline reads as finished to every redemption, whether or not the job has reached it yet. */
export const notDueForReclaim = (row: string, now: string): string => `(${row}.reclaim_at IS NULL OR ${row}.reclaim_at>${now})`;

const authorityRetention = (table: string, retentionMs: number, phase: string, name: string) => {
  const index = `idx_${table}_reclaim`;
  const source = { table, columns: ['id'], unique: true };
  return {
    table, index, phase, retentionMs,
    /** The due page and the delete are one statement, so a row leaves only on its own deadline as it stands in this commit. */
    reclaim: write<[now: number, limit: number], { id: string }>({
      name: `identity.reclaim${name}`,
      sql: `DELETE FROM ${table} WHERE id IN (
        SELECT id FROM ${table} INDEXED BY ${index}
         WHERE reclaim_at<=?1 AND ${dueAt(table, retentionMs)}<=?1
         ORDER BY reclaim_at,id LIMIT ?2) RETURNING id`,
    }),
    source,
    reconcile: write<[keys: string]>({
      name: `identity.reconcile${name}Deadlines`,
      sql: `UPDATE ${table} SET reclaim_at=${dueAt(table, retentionMs)}
        WHERE id IN (SELECT json_extract(value,'$[0]') FROM json_each(?1)) AND reclaim_at IS NOT ${dueAt(table, retentionMs)}`,
    }),
    triggers: () => [
      trigger(`${table}_reclaim_insert`, table, 'INSERT', `UPDATE ${table} SET reclaim_at=${dueAt('NEW', retentionMs)} WHERE id=NEW.id`),
      trigger(`${table}_reclaim_update`, table, `UPDATE OF ${FINISHED_COLUMNS.join(',')}`,
        `UPDATE ${table} SET reclaim_at=${dueAt('NEW', retentionMs)} WHERE id=NEW.id`, changed(FINISHED_COLUMNS)),
    ],
    seed: `INSERT INTO projection_catchup(projection,phase,done) SELECT '${RETENTION_PROJECTION}','${phase}',
      NOT EXISTS(SELECT 1 FROM ${table} WHERE reclaim_at IS NULL) ON CONFLICT DO NOTHING`,
  };
};

const ENROLLMENT = authorityRetention('enrollment_authorities', ENROLLMENT_RETENTION_MS, 'enrollmentAuthorityDeadlines', 'Enrollment');
const IDENTITY_LINK = authorityRetention('identity_link_authorities', IDENTITY_LINK_RETENTION_MS, 'identityLinkDeadlines', 'IdentityLink');

/** Every authority written before these deadlines existed takes the deadline the triggers give a new one. */
export const AUTHORITY_RETENTION_CATCHUP = {
  projection: RETENTION_PROJECTION,
  phases: {
    [ENROLLMENT.phase]: { source: ENROLLMENT.source, reconcile: [ENROLLMENT.reconcile] },
    [IDENTITY_LINK.phase]: { source: IDENTITY_LINK.source, reconcile: [IDENTITY_LINK.reconcile] },
  },
} as const satisfies CatchupFamily;

/** The step's frozen text: triggers that move each deadline in the commit that finishes the row, and the two catch-up phases. */
export function authorityRetentionSchemaStatements(): string[] {
  return [
    ...ENROLLMENT.triggers().map(({ sql }) => sql),
    ...IDENTITY_LINK.triggers().map(({ sql }) => sql),
    ENROLLMENT.seed,
    IDENTITY_LINK.seed,
  ];
}

const reclaimReceipts = write<[cutoff: number, limit: number], { key_hash: string }>({
  name: 'identity.reclaimLinkRedemptions',
  sql: `DELETE FROM identity_link_redemptions WHERE key_hash IN (
    SELECT key_hash FROM identity_link_redemptions INDEXED BY idx_identity_link_redemptions_decided
     WHERE decided_at<=?1 ORDER BY decided_at,key_hash LIMIT ?2) RETURNING key_hash`,
});
const reclaimPendingDevices = write<[now: number, limit: number], { id: string }>({
  name: 'identity.reclaimPendingDevices',
  sql: `DELETE FROM device_requests WHERE id IN (
    SELECT id FROM device_requests WHERE decision IS NULL AND expires_at<=?1 ORDER BY expires_at LIMIT ?2) RETURNING id`,
});
const reclaimDecidedDevices = write<[cutoff: number, limit: number], { id: string }>({
  name: 'identity.reclaimDecidedDevices',
  sql: `DELETE FROM device_requests WHERE id IN (
    SELECT id FROM device_requests WHERE decision IS NOT NULL AND expires_at<=?1 ORDER BY expires_at LIMIT ?2) RETURNING id`,
});

/**
 * One bounded page of everything that has finished: invitations and link keys past their own deadlines, link receipts
 * past retention, undecided device requests past their TTL and decided ones past retention. The `invite-expiry` job is
 * the one caller. A backlog costs a fixed slice per tick, and a live authority is never touched whatever its age.
 */
export async function reclaimFinishedAuthorities(db: RelationalStore, now: number, limit: number): Promise<{ reclaimed: number }> {
  const reclaimed = await commitNamed(db, {
    enrollment: ENROLLMENT.reclaim.bind(now, limit),
    links: IDENTITY_LINK.reclaim.bind(now, limit),
    receipts: reclaimReceipts.bind(now - IDENTITY_LINK_RETENTION_MS, limit),
    pendingDevices: reclaimPendingDevices.bind(now, limit),
    decidedDevices: reclaimDecidedDevices.bind(now - ENROLLMENT_RETENTION_MS, limit),
  });
  return { reclaimed: Object.values(reclaimed).reduce((total, { results }) => total + results.length, 0) };
}

const undecidedDevice = read<[], { pending: number }>({
  name: 'identity.undecidedDevicePending',
  sql: 'SELECT 1 AS pending FROM device_requests WHERE decision IS NULL LIMIT 1',
});
const retainedDecidedDevice = read<[cutoff: number], { pending: number }>({
  name: 'identity.decidedDeviceDue',
  sql: 'SELECT 1 AS pending FROM device_requests WHERE decision IS NOT NULL AND expires_at<=?1 LIMIT 1',
});

/** Undecided requests and decided requests past retention hold housekeeping depth until reclaimed. */
export async function deviceReclamationPending(db: RelationalStore, now: number): Promise<boolean> {
  if (await first(db, undecidedDevice.bind()) !== null) return true;
  return await first(db, retainedDecidedDevice.bind(now - ENROLLMENT_RETENTION_MS)) !== null;
}

import type { RelationalStore } from '../../core/adapters.js';
import { commit, first, read, readSet, rows, write } from '../index.js';

/** The agent row a grant writes under: its name when the grant has no label, and the source that marks it a grant's. */
export interface GrantAgentNames { fallbackName: string; source: string }

type GrantInsert = [id: string, project: string, hash: string, label: string | null, createdBy: string, now: number, expiresAt: number];

const insert = write<GrantInsert>({ name: 'externalGrants.insert', sql:
  `INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by, rotated_to)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL, NULL)` });
/** The agent row is taken from the grant row itself, so a rotation that matched no live predecessor leaves no agent behind. */
const agentOf = write<[fallback: string, source: string, now: number, grant: string]>({ name: 'externalGrants.agentRow', sql:
  `INSERT INTO agents (id, name, source, enabled, created_at, updated_at)
              SELECT id, COALESCE(label, ?1), ?2, 1, ?3, ?3 FROM external_grants WHERE id = ?4
              ON CONFLICT (id) DO NOTHING` });
const successor = write<[id: string, hash: string, actor: string, now: number, expiresAt: number, predecessor: string, project: string], { id: string }>({ name: 'externalGrants.successor', sql:
  `INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by, rotated_to)
                SELECT ?1, project_id, ?2, label, ?3, ?4, ?5, NULL, NULL, NULL, NULL FROM external_grants
                 WHERE id = ?6 AND project_id = ?7 AND revoked_at IS NULL AND expires_at > ?4 RETURNING id` });
const retirePredecessor = write<[now: number, actor: string, successor: string, predecessor: string, project: string]>({ name: 'externalGrants.retirePredecessor', sql:
  `UPDATE external_grants SET revoked_at = ?1, revoked_by = ?2, rotated_to = ?3
                 WHERE id = ?4 AND project_id = ?5 AND revoked_at IS NULL` });
const revoke = write<[now: number, actor: string, grant: string, project: string], { id: string }>({ name: 'externalGrants.revoke', sql:
  'UPDATE external_grants SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3 AND project_id = ?4 AND revoked_at IS NULL RETURNING id' });
const touch = write<[now: number, grant: string, before: number], { id: string }>({ name: 'externalGrants.touch', sql:
  'UPDATE external_grants SET last_used_at = ?1 WHERE id = ?2 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < ?3) RETURNING id' });
const expire = write<[now: number, actor: string, limit: number], { id: string }>({ name: 'externalGrants.expire', sql:
  `UPDATE external_grants SET revoked_at = COALESCE(expires_at, ?1), revoked_by = ?2
               WHERE id IN (SELECT id FROM external_grants
                             WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at <= ?1) LIMIT ?3) RETURNING id` });
const liveWindow = read<[grant: string, project: string, now: number], { created_at: number; expires_at: number }>({ name: 'externalGrants.liveWindow', sql:
  `SELECT created_at, expires_at FROM external_grants
               WHERE id = ?1 AND project_id = ?2 AND revoked_at IS NULL AND expires_at > ?3` });
const expiring = read<[now: number, by: number], { id: string; project_id: string; label: string | null; expires_at: number }>({ name: 'externalGrants.expiring', sql:
  `SELECT id, project_id, label, expires_at FROM external_grants
                WHERE revoked_at IS NULL AND expires_at > ?1 AND expires_at <= ?2 ORDER BY expires_at, id` });
const byKey = read<[hash: string], { id: string; project_id: string; revoked_at: number | null; expires_at: number | null }>({ name: 'externalGrants.byKey', sql:
  'SELECT id, project_id, revoked_at, expires_at FROM external_grants WHERE key_hash = ?1' });

/** Stores a new grant with its agent row in one batch. */
export async function insertGrantWithAgent(db: RelationalStore, grant: { id: string; project: string; keyHash: string; label: string | null; createdBy: string; now: number; expiresAt: number }, names: GrantAgentNames): Promise<void> {
  await commit(db, insert.bind(grant.id, grant.project, grant.keyHash, grant.label, grant.createdBy, grant.now, grant.expiresAt),
    agentOf.bind(names.fallbackName, names.source, grant.now, grant.id));
}

/** Writes the agent row an existing grant authors under; one row per grant, left as it stands when present. */
export async function ensureGrantAgent(db: RelationalStore, grantId: string, now: number, names: GrantAgentNames): Promise<void> {
  await commit(db, agentOf.bind(names.fallbackName, names.source, now, grantId));
}

/** The window of a live, unexpired grant of the Project, or null. */
export async function liveGrantWindow(db: RelationalStore, project: string, grant: string, now: number): Promise<{ created_at: number; expires_at: number } | null> {
  const [[row]] = await readSet(db, liveWindow.bind(grant, project, now));
  return row ?? null;
}

/**
 * Stores a successor from a live, unexpired predecessor of the Project, with its agent row, and retires the predecessor,
 * in one batch. False when no such predecessor held, in which case no successor or agent row exists.
 */
export async function rotateGrantRows(db: RelationalStore, rotation: { successor: string; keyHash: string; actor: string; now: number; expiresAt: number; predecessor: string; project: string }, names: GrantAgentNames): Promise<boolean> {
  const { successor: id, keyHash, actor, now, expiresAt, predecessor, project } = rotation;
  const [inserted] = await commit(db, successor.bind(id, keyHash, actor, now, expiresAt, predecessor, project),
    agentOf.bind(names.fallbackName, names.source, now, id), retirePredecessor.bind(now, actor, id, predecessor, project));
  return inserted.results.length === 1;
}

/** Ends a live grant of the Project; false when no live row of it matched. */
export async function revokeGrantRow(db: RelationalStore, request: { grant: string; project: string; actor: string; now: number }): Promise<boolean> {
  return await first(db, revoke.bind(request.now, request.actor, request.grant, request.project)) !== null;
}

/** Live grants whose expiry falls after `now` and at or before `by`, soonest first, across every Project. */
export async function grantsExpiringRows(db: RelationalStore, now: number, by: number): Promise<{ id: string; project_id: string; label: string | null; expires_at: number }[]> {
  const [found] = await readSet(db, expiring.bind(now, by));
  return found;
}

/** The grant a key digest names, whatever its state, or null. */
export async function grantByKeyHash(db: RelationalStore, hash: string): Promise<{ id: string; project_id: string; revoked_at: number | null; expires_at: number | null } | null> {
  const [[row]] = await readSet(db, byKey.bind(hash));
  return row ?? null;
}

/** Records use of a live grant unless it was recorded since `before`; whether a row moved. */
export async function touchGrantRow(db: RelationalStore, grant: string, now: number, before: number): Promise<boolean> {
  return await first(db, touch.bind(now, grant, before)) !== null;
}

/** Ends up to `limit` grants past their expiry, each at the instant it expired (at `now` when it carried none); the count ended. */
export async function expireGrantRows(db: RelationalStore, now: number, actor: string, limit: number): Promise<number> {
  return (await rows(db, expire.bind(now, actor, limit))).length;
}

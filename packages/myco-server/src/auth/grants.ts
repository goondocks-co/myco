/**
 * External Agent grants — the credential class an independently hosted agent
 * presents for project-scoped, read-only access.
 *
 * A grant belongs to one Project by row and is read-only by what this module
 * offers: it authenticates a bearer to a Project and nothing else. Any member
 * mints, rotates and revokes; every one of those names who. A grant has no
 * expiry; `last_used_at`, written at authentication, shows an agent that
 * stopped calling.
 */
import { toBase64Url } from '../base64.js';
import type { RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';
import type { ReadScope } from '../read/scope.js';
import { emit } from '../telemetry.js';

/** The bearer's prefix: a log line names the class, and the member-token pattern never matches it. */
export const GRANT_KEY_PREFIX = 'mycoext_';
export const GRANT_KEY_BYTES = 32;
export const GRANT_ID_PREFIX = 'eg_';
const GRANT_ID_BYTES = 12;
export const GRANT_KEY_PATTERN = new RegExp(`^${GRANT_KEY_PREFIX}[A-Za-z0-9_-]{${Math.ceil((GRANT_KEY_BYTES * 4) / 3)}}$`);
/** A label a person reads: printable, bounded. */
export const GRANT_LABEL_MAX = 80;
export const GRANT_LABEL_PATTERN = new RegExp(`^[\\x20-\\x7E]{1,${GRANT_LABEL_MAX}}$`);
/** How often `last_used_at` moves; the throttle lives in the statement. */
export const GRANT_TOUCH_INTERVAL_MS = 60_000;

export interface GrantRow {
  id: string;
  projectId: string;
  label: string | null;
  createdBy: string;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  rotatedTo: string | null;
}

export interface IssuedGrant {
  key: string;
  id: string;
}

const freshKey = (): string => `${GRANT_KEY_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(GRANT_KEY_BYTES)))}`;
const freshId = (): string => `${GRANT_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(GRANT_ID_BYTES)))}`;

/** Mints a grant for the scope's Project. The key is answered once; only its digest is stored. */
export async function issueExternalGrant(db: RelationalStore, scope: ReadScope, label: string | null, createdBy: string, nowMs: number): Promise<IssuedGrant> {
  const key = freshKey();
  const id = freshId();
  await db
    .prepare(`INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at, last_used_at, revoked_at, revoked_by, rotated_to)
              VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
    .bind(id, scope.projectId, await sha256Hex(key), label, createdBy, nowMs)
    .run();
  emit({ kind: 'grant_issued', grantId: id, projectId: scope.projectId, createdBy });
  return { key, id };
}

/** Every grant of the scope's Project, live and revoked, newest first. Never a key or its digest. */
export async function listExternalGrants(db: RelationalStore, scope: ReadScope): Promise<GrantRow[]> {
  const { results } = await db
    .prepare(`SELECT id, project_id, label, created_by, created_at, last_used_at, revoked_at, revoked_by, rotated_to
                FROM external_grants WHERE project_id = ? ORDER BY created_at DESC, id DESC`)
    .bind(scope.projectId)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    label: (r.label as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as number,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    revokedAt: (r.revoked_at as number | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    rotatedTo: (r.rotated_to as string | null) ?? null,
  }));
}

/**
 * Issues a successor and revokes the predecessor in one transaction. The
 * successor is inserted only from a live predecessor row of this Project, so a
 * grant named under another Project — or already revoked — rotates nothing and
 * leaves no successor behind.
 */
export async function rotateExternalGrant(
  db: RelationalStore, scope: ReadScope, grantId: string, actor: string, nowMs: number,
): Promise<IssuedGrant | null> {
  const key = freshKey();
  const id = freshId();
  const results = await db.batch([
    db.prepare(`INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at, last_used_at, revoked_at, revoked_by, rotated_to)
                SELECT ?, project_id, ?, label, ?, ?, NULL, NULL, NULL, NULL FROM external_grants
                 WHERE id = ? AND project_id = ? AND revoked_at IS NULL`)
      .bind(id, await sha256Hex(key), actor, nowMs, grantId, scope.projectId),
    db.prepare(`UPDATE external_grants SET revoked_at = ?, revoked_by = ?, rotated_to = ?
                 WHERE id = ? AND project_id = ? AND revoked_at IS NULL`)
      .bind(nowMs, actor, id, grantId, scope.projectId),
  ]);
  if (results[0]?.meta.changes !== 1) return null;
  emit({ kind: 'grant_rotated', grantId, successorId: id, projectId: scope.projectId, actor });
  return { key, id };
}

/** Revokes a live grant of the scope's Project, naming who. `revoked` is false when no live row of this Project matched. */
export async function revokeExternalGrant(db: RelationalStore, scope: ReadScope, grantId: string, actor: string, nowMs: number): Promise<{ revoked: boolean }> {
  const result = await db
    .prepare(`UPDATE external_grants SET revoked_at = ?, revoked_by = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL`)
    .bind(nowMs, actor, grantId, scope.projectId)
    .run();
  const revoked = result.meta.changes === 1;
  if (revoked) emit({ kind: 'grant_revoked', grantId, projectId: scope.projectId, actor });
  return { revoked };
}

/** The Project a presented bearer's digest grants read access to, or null. The row names the Project; nothing a caller sends widens it. */
export async function authenticateGrant(db: RelationalStore, keyHash: string): Promise<{ grantId: string; projectId: string } | null> {
  const row = await db
    .prepare(`SELECT id, project_id FROM external_grants WHERE key_hash = ? AND revoked_at IS NULL`)
    .bind(keyHash)
    .first<{ id: string; project_id: string }>();
  return row === null ? null : { grantId: row.id, projectId: row.project_id };
}

/** Records use of a live grant, at most once per `GRANT_TOUCH_INTERVAL_MS`; the throttle is the statement's own predicate. */
export async function touchGrant(db: RelationalStore, grantId: string, nowMs: number): Promise<{ touched: boolean }> {
  const result = await db
    .prepare(`UPDATE external_grants SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < ?)`)
    .bind(nowMs, grantId, nowMs - GRANT_TOUCH_INTERVAL_MS)
    .run();
  return { touched: result.meta.changes === 1 };
}

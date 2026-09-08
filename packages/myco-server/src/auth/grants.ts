/**
 * External Agent grants — the credential class an independently hosted agent
 * presents for project-scoped access.
 *
 * A grant belongs to one Project by row and reaches that Project alone. Any
 * member mints, rotates and revokes; every one of those names who.
 * `last_used_at`, written at authentication, shows an agent that stopped
 * calling.
 *
 * **A grant is an author, so a grant is an `agents` row.** One row per grant
 * id, minted with the grant and never deleted: a spore written over a grant
 * carries that id as both `agent_id` and `author`, and the row is what those
 * columns point at for as long as the spore lives. The row is inserted from
 * the grant row itself, so a rotation that matched no live predecessor leaves
 * no agent behind either.
 *
 * **Every grant expires.** A grant lives in someone else's configuration,
 * where expiry and revocation are the only recall. `authenticateGrant` fails
 * closed on the column — an absent expiry is refused, not honoured forever —
 * and the `grant-expiry` job (`core/jobs-run.ts`) converges a lapsed row to
 * ended without destroying it.
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

const DAY_MS = 86_400_000;
/** The window a grant lives for when the caller names none. */
export const GRANT_TTL_DAYS_DEFAULT = 90;
/** The bounds a named window is held to. */
export const GRANT_TTL_DAYS_MIN = 1;
export const GRANT_TTL_DAYS_MAX = 365;
/** What `revoked_by` names on a grant the expiry job ended; every other value in that column is a member id. */
export const GRANT_EXPIRY_ACTOR = 'expiry';
/** The `agents.source` a grant's row carries, distinguishing it from the harness's own built-in agents. */
export const GRANT_AGENT_SOURCE = 'grant';
/** The agent name a grant with no label writes under. */
export const GRANT_AGENT_FALLBACK_NAME = 'External agent';

export interface GrantRow {
  id: string;
  projectId: string;
  label: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  rotatedTo: string | null;
}

export interface IssuedGrant {
  key: string;
  id: string;
  expiresAt: number;
}

/**
 * Why a presented key authenticated as nothing. A caller is told none of this;
 * the record is. Not a `Classifier`: the answer is 401 with no wire code, and
 * nothing a member reads carries this value.
 */
export type GrantRefusal = 'revoked' | 'expired';

const freshKey = (): string => `${GRANT_KEY_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(GRANT_KEY_BYTES)))}`;
const freshId = (): string => `${GRANT_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(GRANT_ID_BYTES)))}`;

/**
 * The `agents` row a grant writes under, taken from the grant row itself.
 *
 * The name follows the grant's label, and the statement inserts nothing when
 * the grant row is absent — which is how a rotation that matched no live
 * predecessor leaves no agent row behind.
 */
const grantAgent = (db: RelationalStore, grantId: string, nowMs: number) =>
  db.prepare(`INSERT INTO agents (id, name, source, enabled, created_at, updated_at)
              SELECT id, COALESCE(label, ?), ?, 1, ?, ? FROM external_grants WHERE id = ?
              ON CONFLICT (id) DO NOTHING`)
    .bind(GRANT_AGENT_FALLBACK_NAME, GRANT_AGENT_SOURCE, nowMs, nowMs, grantId);

/** Mints a grant for the scope's Project, with its agent row. The key is answered once; only its digest is stored. */
export async function issueExternalGrant(
  db: RelationalStore, scope: ReadScope, label: string | null, createdBy: string, nowMs: number,
  ttlDays: number = GRANT_TTL_DAYS_DEFAULT,
): Promise<IssuedGrant> {
  const key = freshKey();
  const id = freshId();
  const expiresAt = nowMs + ttlDays * DAY_MS;
  await db.batch([
    db.prepare(`INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by, rotated_to)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`)
      .bind(id, scope.projectId, await sha256Hex(key), label, createdBy, nowMs, expiresAt),
    grantAgent(db, id, nowMs),
  ]);
  emit({ kind: 'grant_issued', grantId: id, projectId: scope.projectId, createdBy, expiresAt });
  return { key, id, expiresAt };
}

/** Every grant of the scope's Project, live and ended, newest first. Never a key or its digest. */
export async function listExternalGrants(db: RelationalStore, scope: ReadScope): Promise<GrantRow[]> {
  const { results } = await db
    .prepare(`SELECT id, project_id, label, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by, rotated_to
                FROM external_grants WHERE project_id = ? ORDER BY created_at DESC, id DESC`)
    .bind(scope.projectId)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    label: (r.label as string | null) ?? null,
    createdBy: r.created_by as string,
    createdAt: r.created_at as number,
    expiresAt: (r.expires_at as number | null) ?? null,
    lastUsedAt: (r.last_used_at as number | null) ?? null,
    revokedAt: (r.revoked_at as number | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    rotatedTo: (r.rotated_to as string | null) ?? null,
  }));
}

/**
 * Issues a successor and ends the predecessor in one transaction. The
 * successor is inserted only from a **live and unexpired** predecessor row of
 * this Project, so a grant named under another Project — already revoked, or
 * past its expiry — rotates nothing and leaves neither a successor nor an
 * agent row behind.
 *
 * The successor keeps the predecessor's window and starts it again: a rotation
 * moves the clock forward, and cannot widen a one-week grant into a one-year
 * one.
 */
export async function rotateExternalGrant(
  db: RelationalStore, scope: ReadScope, grantId: string, actor: string, nowMs: number,
): Promise<IssuedGrant | null> {
  const live = await db
    .prepare(`SELECT created_at, expires_at FROM external_grants
               WHERE id = ? AND project_id = ? AND revoked_at IS NULL AND expires_at > ?`)
    .bind(grantId, scope.projectId, nowMs)
    .first<{ created_at: number; expires_at: number }>();
  if (live === null) return null;
  const key = freshKey();
  const id = freshId();
  const expiresAt = nowMs + (live.expires_at - live.created_at);
  const results = await db.batch([
    db.prepare(`INSERT INTO external_grants (id, project_id, key_hash, label, created_by, created_at, expires_at, last_used_at, revoked_at, revoked_by, rotated_to)
                SELECT ?, project_id, ?, label, ?, ?, ?, NULL, NULL, NULL, NULL FROM external_grants
                 WHERE id = ? AND project_id = ? AND revoked_at IS NULL AND expires_at > ?`)
      .bind(id, await sha256Hex(key), actor, nowMs, expiresAt, grantId, scope.projectId, nowMs),
    grantAgent(db, id, nowMs),
    db.prepare(`UPDATE external_grants SET revoked_at = ?, revoked_by = ?, rotated_to = ?
                 WHERE id = ? AND project_id = ? AND revoked_at IS NULL`)
      .bind(nowMs, actor, id, grantId, scope.projectId),
  ]);
  if (results[0]?.meta.changes !== 1) return null;
  emit({ kind: 'grant_rotated', grantId, successorId: id, projectId: scope.projectId, actor });
  return { key, id, expiresAt };
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

/**
 * The Project a presented bearer's digest reaches, or null. The row names the
 * Project; nothing a caller sends widens it.
 *
 * A key that names no row, one that names a revoked row and one that names a
 * lapsed row are the same answer to the caller and three different records: a
 * refused grant emits which of the two it is, so an agent whose window closed
 * is distinguishable in the record from one presenting a withdrawn key. An
 * absent `expires_at` is refused with the lapsed ones — every row carries one.
 */
export async function authenticateGrant(db: RelationalStore, keyHash: string, nowMs: number): Promise<{ grantId: string; projectId: string } | null> {
  const row = await db
    .prepare(`SELECT id, project_id, revoked_at, expires_at FROM external_grants WHERE key_hash = ?`)
    .bind(keyHash)
    .first<{ id: string; project_id: string; revoked_at: number | null; expires_at: number | null }>();
  if (row === null) return null;
  const refusal: GrantRefusal | null = row.revoked_at !== null ? 'revoked'
    : row.expires_at === null || row.expires_at <= nowMs ? 'expired'
      : null;
  if (refusal !== null) {
    emit({ kind: 'grant_refused', grantId: row.id, projectId: row.project_id, refusal });
    return null;
  }
  return { grantId: row.id, projectId: row.project_id };
}

/** Records use of a live grant, at most once per `GRANT_TOUCH_INTERVAL_MS`; the throttle is the statement's own predicate. */
export async function touchGrant(db: RelationalStore, grantId: string, nowMs: number): Promise<{ touched: boolean }> {
  const result = await db
    .prepare(`UPDATE external_grants SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < ?)`)
    .bind(nowMs, grantId, nowMs - GRANT_TOUCH_INTERVAL_MS)
    .run();
  return { touched: result.meta.changes === 1 };
}

/**
 * Ends every grant past its expiry, up to `limit` rows a pass.
 *
 * `revoked_at` takes the instant the grant expired rather than the instant the
 * job noticed, so a second delivery of one wake writes what the first wrote
 * and the record says when the grant actually ended. A row carrying no expiry
 * at all is swept too, at the instant it is found: `authenticateGrant` already
 * refuses it, and leaving it live in the listing would make this job's
 * convergence a claim the table contradicts. The row and its agent survive: a
 * spore's `author` points at both.
 *
 * The bound is a subquery rather than `UPDATE … LIMIT`, which is a compile-time
 * SQLite option and not offered by every store this runs against.
 */
export async function expireGrants(db: RelationalStore, nowMs: number, limit: number): Promise<number> {
  const result = await db
    .prepare(`UPDATE external_grants SET revoked_at = COALESCE(expires_at, ?), revoked_by = ?
               WHERE id IN (SELECT id FROM external_grants
                             WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at <= ?) LIMIT ?)`)
    .bind(nowMs, GRANT_EXPIRY_ACTOR, nowMs, limit)
    .run();
  return result.meta.changes;
}

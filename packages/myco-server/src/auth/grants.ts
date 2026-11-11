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
import type { Page, ReadScope } from '../read/scope.js';
import { grantPage } from '../db/identity/access-pages.js';
import {
  expireGrantRows, grantByKeyHash, grantsExpiringRows, insertGrantWithAgent, liveGrantWindow, revokeGrantRow, rotateGrantRows, touchGrantRow,
  type GrantAgentNames,
} from '../db/identity/grants.js';
import { emit } from '../telemetry.js';

/** The bearer's prefix: a log line names the class, and the member-token pattern never matches it. */
const GRANT_KEY_PREFIX = 'mycoext_';
const GRANT_KEY_BYTES = 32;
const GRANT_ID_PREFIX = 'eg_';
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

interface IssuedGrant {
  key: string;
  id: string;
  expiresAt: number;
}

/**
 * Why a presented key authenticated as nothing. A caller is told none of this;
 * the record is. Not a `Classifier`: the answer is 401 with no wire code, and
 * nothing a member reads carries this value.
 */
type GrantRefusal = 'revoked' | 'expired';

const freshKey = (): string => `${GRANT_KEY_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(GRANT_KEY_BYTES)))}`;
const freshId = (): string => `${GRANT_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(GRANT_ID_BYTES)))}`;

/** The `agents` row a grant writes under is named by its label, and by this fallback when it has none. */
const GRANT_AGENT_NAMES: GrantAgentNames = { fallbackName: GRANT_AGENT_FALLBACK_NAME, source: GRANT_AGENT_SOURCE };

/** Mints a grant for the scope's Project, with its agent row. The key is answered once; only its digest is stored. */
export async function issueExternalGrant(
  db: RelationalStore, scope: ReadScope, label: string | null, createdBy: string, nowMs: number,
  ttlDays: number = GRANT_TTL_DAYS_DEFAULT,
): Promise<IssuedGrant> {
  const key = freshKey();
  const id = freshId();
  const expiresAt = nowMs + ttlDays * DAY_MS;
  await insertGrantWithAgent(db, { id, project: scope.projectId, keyHash: await sha256Hex(key), label, createdBy, now: nowMs, expiresAt }, GRANT_AGENT_NAMES);
  emit({ kind: 'grant_issued', grantId: id, projectId: scope.projectId, createdBy, expiresAt });
  return { key, id, expiresAt };
}

/** One page of the scope's Project's grants, live and ended, newest first. Never a key or its digest. */
export async function listExternalGrants(db: RelationalStore, scope: ReadScope, opts: { limit?: number; cursor?: string } = {}): Promise<Page<GrantRow>> {
  const { rows, cursor } = await grantPage(db, scope.projectId, opts);
  return {
    cursor,
    rows: rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      label: r.label,
      createdBy: r.created_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      revokedBy: r.revoked_by,
      rotatedTo: r.rotated_to,
    })),
  };
}

/** Live grants whose expiry falls after `nowMs` and at or before `byMs`, soonest first, across every Project; read on the expiry index. */
export async function grantsExpiringBy(db: RelationalStore, nowMs: number, byMs: number): Promise<{ id: string; projectId: string; label: string | null; expiresAt: number }[]> {
  const found = await grantsExpiringRows(db, nowMs, byMs);
  return found.map((r) => ({ id: r.id, projectId: r.project_id, label: r.label ?? null, expiresAt: r.expires_at }));
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
  const live = await liveGrantWindow(db, scope.projectId, grantId, nowMs);
  if (live === null) return null;
  const key = freshKey();
  const id = freshId();
  const expiresAt = nowMs + (live.expires_at - live.created_at);
  const rotated = await rotateGrantRows(db, { successor: id, keyHash: await sha256Hex(key), actor, now: nowMs, expiresAt, predecessor: grantId, project: scope.projectId }, GRANT_AGENT_NAMES);
  if (!rotated) return null;
  emit({ kind: 'grant_rotated', grantId, successorId: id, projectId: scope.projectId, actor });
  return { key, id, expiresAt };
}

/** Revokes a live grant of the scope's Project, naming who. `revoked` is false when no live row of this Project matched. */
export async function revokeExternalGrant(db: RelationalStore, scope: ReadScope, grantId: string, actor: string, nowMs: number): Promise<{ revoked: boolean }> {
  const revoked = await revokeGrantRow(db, { grant: grantId, project: scope.projectId, actor, now: nowMs });
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
  const row = await grantByKeyHash(db, keyHash);
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
  const touched = await touchGrantRow(db, grantId, nowMs, nowMs - GRANT_TOUCH_INTERVAL_MS);
  return { touched };
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
  return expireGrantRows(db, nowMs, GRANT_EXPIRY_ACTOR, limit);
}


import type { RelationalStore, PreparedStatement } from '../core/adapters.js';
import { SERVER_SCHEMA_VERSION, TOKEN_ID_BYTES, TOKEN_ID_PREFIX } from '../constants.js';
import { sha256Hex } from '../hash.js';
import { heldBytes, TOKEN_LIVE } from '../ingest/quota.js';
import { SchemaMismatchError, TokenRevokedError, type Classifier } from '../telemetry.js';

export const MEMBER_TOKEN_BYTES = 32;
export const MEMBER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The tail of a token's life in which a refresh is admitted: the last quarter of the TTL. */
export const MEMBER_TOKEN_REFRESH_WINDOW_MS = MEMBER_TOKEN_TTL_MS / 4;
/** How long a lineage of refreshed tokens runs from its root's issue; no token of the lineage expires later. */
export const MEMBER_TOKEN_MAX_LINEAGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Shape of every minted token: `MEMBER_TOKEN_BYTES` random bytes as unpadded base64url. */
export const MEMBER_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((MEMBER_TOKEN_BYTES * 4) / 3)}}$`);

export interface MemberAuth {
  projectId: string;
  tokenId: string;
  machineId: string | null;
  bytesWritten: number;
  expiresAt: number;
  /** The first token of the chain this one belongs to: its own id for an operator-minted token. */
  lineageRoot: string;
  /** The issue instant of the lineage root; every token of the chain expires no later than `lineageStartedAt + MEMBER_TOKEN_MAX_LINEAGE_MS`. */
  lineageStartedAt: number;
  /** The token this one succeeded by refresh; null for an operator-minted token. */
  predecessorId: string | null;
  /** The instant of a successor's first authenticated use; null until then, and always null for an operator-minted token. */
  firstUsedAt: number | null;
}

export interface IssuedMemberToken {
  token: string;
  tokenId: string;
  expiresAt: number;
}

/** The chain a successor joins: the token it succeeds, and the root and start it inherits from it. */
export interface TokenLineage {
  predecessorId: string;
  lineageRoot: string;
  lineageStartedAt: number;
}

/** What a refresh needs of the presented token. */
export type RefreshSubject = Pick<MemberAuth, 'projectId' | 'tokenId' | 'machineId' | 'expiresAt' | 'lineageRoot' | 'lineageStartedAt'>;

export type RefreshResult =
  | { refreshed: true; token: string; tokenId: string; expiresAt: number; refreshAfter: number }
  | { refreshed: false; code: Classifier; reason: string; refreshAfter?: number };

export const REFRESH_TOO_EARLY = 'refresh window not yet open';
export const LINEAGE_EXPIRED = 'token lineage expired';

/** The instant a token's refresh window opens: `MEMBER_TOKEN_REFRESH_WINDOW_MS` before it expires. Every `refreshAfter` on the wire is this instant for some token. */
export const windowOpensAt = (expiresAt: number): number => expiresAt - MEMBER_TOKEN_REFRESH_WINDOW_MS;

interface AuthRow {
  schema_version: string;
  id: string | null;
  project_id: string | null;
  machine_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  bytes_written: number | null;
  lineage_root: string | null;
  lineage_started_at: number | null;
  predecessor_id: string | null;
  first_used_at: number | null;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function mintMemberToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(MEMBER_TOKEN_BYTES)));
}

/** The one INSERT into member_tokens, prepared and unrun: a fresh token and id, the digest stored, `bytes_written` at 0, and the lineage columns — its own id and `nowMs` for a root, the inherited chain for a successor. The row expires one TTL from now or at the lineage ceiling, whichever is sooner. A successor's row is written only while its predecessor is still live at the instant of the insert (the statement's change count says whether it was); a root has no predecessor and always lands. */
function memberTokenInsert(
  db: RelationalStore, member: { projectId: string; machineId: string | null }, nowMs: number, lineage: TokenLineage | null, tokenId: string, digest: string,
): { statement: PreparedStatement; expiresAt: number } {
  const predecessorId = lineage === null ? null : lineage.predecessorId;
  const lineageRoot = lineage === null ? tokenId : lineage.lineageRoot;
  const lineageStartedAt = lineage === null ? nowMs : lineage.lineageStartedAt;
  const expiresAt = Math.min(nowMs + MEMBER_TOKEN_TTL_MS, lineageStartedAt + MEMBER_TOKEN_MAX_LINEAGE_MS);
  const statement = db
    .prepare(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at)
              SELECT ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL
               WHERE ? IS NULL OR ${TOKEN_LIVE}`)
    .bind(tokenId, member.projectId, member.machineId, digest, expiresAt, predecessorId, lineageRoot, lineageStartedAt, predecessorId, predecessorId);
  return { statement, expiresAt };
}

/** A fresh raw token and its id, with the insert that stores the digest. */
async function mintInsert(db: RelationalStore, member: { projectId: string; machineId: string | null }, nowMs: number, lineage: TokenLineage | null): Promise<{ statement: PreparedStatement; issued: IssuedMemberToken }> {
  const token = mintMemberToken();
  const tokenId = `${TOKEN_ID_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(TOKEN_ID_BYTES)))}`;
  const { statement, expiresAt } = memberTokenInsert(db, member, nowMs, lineage, tokenId, await sha256Hex(token));
  return { statement, issued: { token, tokenId, expiresAt } };
}

/** Sole inserter of member_tokens rows. Stores the digest; returns the raw token once. Without `lineage` the token roots a lineage of its own; with it, the token succeeds `lineage.predecessorId` and expires no later than the lineage ceiling. */
export async function issueMemberToken(
  db: RelationalStore, member: { projectId: string; machineId: string | null }, nowMs: number, lineage: TokenLineage | null = null,
): Promise<IssuedMemberToken> {
  const { statement, issued } = await mintInsert(db, member, nowMs, lineage);
  await statement.run();
  return issued;
}

/** Marks a token revoked; a revoked token never authenticates again. `revoked` is false when no live row matched the id. */
export async function revokeMemberToken(db: RelationalStore, tokenId: string, nowMs: number): Promise<{ revoked: boolean }> {
  const result = await db
    .prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(nowMs, tokenId)
    .run();
  return { revoked: result.meta.changes === 1 };
}

/** Revoke a token that belongs to one project. The unscoped form above is the break-glass path, where the operator has already named the token; anything reached through a credential scopes the write, so a caller can never revoke a token outside what it may see. */
export async function revokeProjectMemberToken(db: RelationalStore, projectId: string, tokenId: string, nowMs: number): Promise<{ revoked: boolean }> {
  const result = await db
    .prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL`)
    .bind(nowMs, tokenId, projectId)
    .run();
  return { revoked: result.meta.changes === 1 };
}

/** Revokes every live token of the lineage `tokenId` belongs to — the named token, its predecessors, and its successors — in one statement; `revoked` counts the rows that changed. */
export async function revokeMemberLineage(db: RelationalStore, tokenId: string, nowMs: number): Promise<{ revoked: number }> {
  const result = await db
    .prepare(`UPDATE member_tokens SET revoked_at = ? WHERE lineage_root = (SELECT lineage_root FROM member_tokens WHERE id = ?) AND revoked_at IS NULL`)
    .bind(nowMs, tokenId)
    .run();
  return { revoked: result.meta.changes };
}

/** The window opens at `expires_at − MEMBER_TOKEN_REFRESH_WINDOW_MS`; earlier, the answer is `refresh_too_early` with the instant it opens. A token that already expires at its lineage ceiling answers `lineage_expired`: no successor could outlive it. Past both checks, one batch revokes the live, never-used successor this token may already have and inserts the new one — expiring one TTL from now or at the ceiling, whichever is sooner — and the answer carries the successor's own window start as `refreshAfter`. Both statements act only while the presented token is still live at that instant (`TOKEN_LIVE` on each): a token revoked in between changes nothing — its banked successor stays as it is — and raises `TokenRevokedError`. The presented token stays live; the successor's first authenticated use revokes it. */
export async function refreshMemberToken(db: RelationalStore, subject: RefreshSubject, nowMs: number): Promise<RefreshResult> {
  const opensAt = windowOpensAt(subject.expiresAt);
  if (nowMs < opensAt) return { refreshed: false, code: 'refresh_too_early', reason: REFRESH_TOO_EARLY, refreshAfter: opensAt };
  if (subject.lineageStartedAt + MEMBER_TOKEN_MAX_LINEAGE_MS <= subject.expiresAt) return { refreshed: false, code: 'lineage_expired', reason: LINEAGE_EXPIRED };
  const successor = await mintInsert(db, { projectId: subject.projectId, machineId: subject.machineId }, nowMs,
    { predecessorId: subject.tokenId, lineageRoot: subject.lineageRoot, lineageStartedAt: subject.lineageStartedAt });
  const [, inserted] = await db.batch([
    db.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE predecessor_id = ? AND revoked_at IS NULL AND first_used_at IS NULL AND ${TOKEN_LIVE}`).bind(nowMs, subject.tokenId, subject.tokenId),
    successor.statement,
  ]);
  if (inserted.meta.changes !== 1) throw new TokenRevokedError(subject.tokenId);
  return { refreshed: true, ...successor.issued, refreshAfter: windowOpensAt(successor.issued.expiresAt) };
}

/** A successor's first authenticated use, as one batch: the successor takes over what its predecessor holds against the quota (`heldBytes`: the charged counter plus live blob reservations; nothing when the predecessor row is gone) and records the instant; the predecessor is revoked. Every statement guards itself, so a repeat changes nothing. */
export async function activateSuccessor(db: RelationalStore, auth: Pick<MemberAuth, 'projectId' | 'tokenId'> & { predecessorId: string }, nowMs: number): Promise<void> {
  const held = heldBytes({ projectId: auth.projectId, tokenId: auth.predecessorId, now: nowMs });
  await db.batch([
    db.prepare(`UPDATE member_tokens SET bytes_written = COALESCE(${held.sql}, 0), first_used_at = ? WHERE id = ? AND first_used_at IS NULL`).bind(...held.params, nowMs, auth.tokenId),
    db.prepare(`UPDATE member_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowMs, auth.predecessorId),
  ]);
}

/** One read: the database schema version, joined to the member row for the digest when one exists. The version must equal this build's before any token decision is made; a missing version row is a mismatch. A row without its lineage columns never authenticates. */
export async function authenticateServerMemberToken(
  db: RelationalStore, digest: string, nowMs: number,
): Promise<MemberAuth | null> {
  const row = await db
    .prepare(`SELECT s.value AS schema_version,
                     t.id, t.project_id, t.machine_id, t.expires_at, t.revoked_at, t.bytes_written,
                     t.lineage_root, t.lineage_started_at, t.predecessor_id, t.first_used_at
                FROM schema_meta s
                LEFT JOIN member_tokens t ON t.token_hash = ?
               WHERE s.key = 'version'`)
    .bind(digest)
    .first<AuthRow>();

  if (!row) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, null);
  if (row.schema_version !== String(SERVER_SCHEMA_VERSION)) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, row.schema_version);
  if (row.id === null || row.project_id === null || row.expires_at === null || row.bytes_written === null) return null;
  if (row.lineage_root === null || row.lineage_started_at === null) return null;
  if (row.revoked_at !== null) return null;
  if (row.expires_at <= nowMs) return null;
  return {
    projectId: row.project_id, tokenId: row.id, machineId: row.machine_id, bytesWritten: row.bytes_written,
    expiresAt: row.expires_at, lineageRoot: row.lineage_root, lineageStartedAt: row.lineage_started_at,
    predecessorId: row.predecessor_id, firstUsedAt: row.first_used_at,
  };
}

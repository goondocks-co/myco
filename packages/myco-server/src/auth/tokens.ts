import { toBase64Url } from '../base64.js';
import type { RelationalStore, PreparedStatement } from '../core/adapters.js';
import { SERVER_SCHEMA_VERSION, TOKEN_ID_BYTES, TOKEN_ID_PREFIX } from '../constants.js';
import { sha256Hex } from '../hash.js';
import { heldBytes, TOKEN_LIVE } from '../ingest/quota.js';
import { emit, SchemaMismatchError, TokenRevokedError, type Classifier } from '../telemetry.js';
import { MEMBER_REVOKED_BY, memberRevokedByParams } from '../db/liveness.js';

export const MEMBER_TOKEN_BYTES = 32;
export const MEMBER_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The tail of a token's life in which a refresh is admitted: the last quarter of the TTL. */
export const MEMBER_TOKEN_REFRESH_WINDOW_MS = MEMBER_TOKEN_TTL_MS / 4;
/** How long a lineage of refreshed tokens runs from its root's issue; no token of the lineage expires later. */
export const MEMBER_TOKEN_MAX_LINEAGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Shape of every minted token: `MEMBER_TOKEN_BYTES` random bytes as unpadded base64url. */
export const MEMBER_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((MEMBER_TOKEN_BYTES * 4) / 3)}}$`);

export interface MemberAuth {
  /** The member holding this credential. Server-issued; never derived from anything the runtime reports. */
  memberId: string;
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
  /** How the runtime described itself at issue. Read-only here; nothing admits or refuses on it. */
  runtime: RuntimeClaims;
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
export type RefreshSubject = Pick<MemberAuth, 'memberId' | 'tokenId' | 'machineId' | 'expiresAt' | 'lineageRoot' | 'lineageStartedAt' | 'runtime'>;

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
  member_id: string | null;
  machine_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  bytes_written: number | null;
  lineage_root: string | null;
  lineage_started_at: number | null;
  predecessor_id: string | null;
  first_used_at: number | null;
  runtime_label: string | null;
  runtime_kind: string | null;
  /** The credential's member, present only while that member is live. */
  member_live: string | null;
}

export function mintMemberToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(MEMBER_TOKEN_BYTES)));
}

/** The runtime holding a credential, as that runtime describes itself. Recorded for an operator to read; never an admission input. */
export interface RuntimeClaims {
  runtimeLabel: string | null;
  runtimeKind: string | null;
}

export const NO_RUNTIME_CLAIMS: RuntimeClaims = { runtimeLabel: null, runtimeKind: null };

/** The one INSERT into member_credentials, prepared and unrun: a fresh token and id, the digest stored, `bytes_written` at 0, the runtime claims as given, and the lineage columns — its own id and `nowMs` for a root, the inherited chain for a successor. The row expires one TTL from now or at the lineage ceiling, whichever is sooner. A successor's row is written only while its predecessor is still live at the instant of the insert (the statement's change count says whether it was); a root has no predecessor and always lands. */
function memberTokenInsert(
  db: RelationalStore, member: { memberId: string; machineId: string | null }, nowMs: number, lineage: TokenLineage | null, tokenId: string, digest: string, runtime: RuntimeClaims,
): { statement: PreparedStatement; expiresAt: number } {
  const predecessorId = lineage === null ? null : lineage.predecessorId;
  const lineageRoot = lineage === null ? tokenId : lineage.lineageRoot;
  const lineageStartedAt = lineage === null ? nowMs : lineage.lineageStartedAt;
  const expiresAt = Math.min(nowMs + MEMBER_TOKEN_TTL_MS, lineageStartedAt + MEMBER_TOKEN_MAX_LINEAGE_MS);
  const statement = db
    .prepare(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at, runtime_label, runtime_kind)
              SELECT ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, NULL, ?, ?
               WHERE ? IS NULL OR ${TOKEN_LIVE}`)
    .bind(tokenId, member.memberId, member.machineId, digest, nowMs, expiresAt, predecessorId, lineageRoot, lineageStartedAt, runtime.runtimeLabel, runtime.runtimeKind, predecessorId, predecessorId);
  return { statement, expiresAt };
}

/** A fresh raw token and its id, with the insert that stores the digest. */
async function mintInsert(db: RelationalStore, member: { memberId: string; machineId: string | null }, nowMs: number, lineage: TokenLineage | null, runtime: RuntimeClaims): Promise<{ statement: PreparedStatement; issued: IssuedMemberToken }> {
  const token = mintMemberToken();
  const tokenId = `${TOKEN_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_ID_BYTES)))}`;
  const { statement, expiresAt } = memberTokenInsert(db, member, nowMs, lineage, tokenId, await sha256Hex(token), runtime);
  return { statement, issued: { token, tokenId, expiresAt } };
}

/** Sole inserter of member_credentials rows. Stores the digest; returns the raw token once. Without `lineage` the token roots a lineage of its own; with it, the token succeeds `lineage.predecessorId` and expires no later than the lineage ceiling. */
export async function issueMemberToken(
  db: RelationalStore, member: { memberId: string; machineId: string | null }, nowMs: number, lineage: TokenLineage | null = null, runtime: RuntimeClaims = NO_RUNTIME_CLAIMS,
): Promise<IssuedMemberToken> {
  const { statement, issued } = await mintInsert(db, member, nowMs, lineage, runtime);
  await statement.run();
  return issued;
}

/**
 * Revoke a credential on behalf of a member. Membership is flat: any member may
 * revoke any credential, so the write carries no ownership predicate.
 *
 * `revokedBy` is recorded rather than checked, in the same statement that revokes
 * — a revocation and the record of who made it cannot come apart. Restricting who
 * may revoke is then a policy change on top of this record rather than a
 * re-derivation of who owns what, and until there is one, an operator can always
 * answer who ended a credential.
 */
/** The one attributed revocation of a credential, as a statement: the runner above executes and records it; the break-glass script renders it. */
export function revokeCredentialStatement(db: RelationalStore, revokedBy: string, tokenId: string, nowMs: number): PreparedStatement {
  return db
    .prepare(`UPDATE member_credentials SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(nowMs, revokedBy, tokenId);
}

export async function revokeCredentialAsMember(
  db: RelationalStore, revokedBy: string, tokenId: string, nowMs: number,
): Promise<{ revoked: boolean; revokedBy: string }> {
  const result = await revokeCredentialStatement(db, revokedBy, tokenId, nowMs).run();
  const revoked = result.meta.changes === 1;
  emit({ kind: 'credential_revoked', tokenId, revokedBy, revoked });
  return { revoked, revokedBy };
}

/**
 * Revoke a credential only when it belongs to the named member. The dispatch
 * path mints a credential for the harness member per run and releases it when
 * the run ends; a run claimed under a person's own credential carries that
 * credential in the same column, and a release must never end it.
 */
export async function revokeCredentialOfMember(
  db: RelationalStore, memberId: string, tokenId: string, nowMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE member_credentials SET revoked_at = ?, revoked_by = ? WHERE id = ? AND member_id = ? AND revoked_at IS NULL`)
    .bind(nowMs, memberId, tokenId, memberId).run();
  const revoked = result.meta.changes === 1;
  emit({ kind: 'credential_revoked', tokenId, revokedBy: memberId, revoked });
  return revoked;
}

/** Every live credential of a member, revoked and attributed in one statement — effective only once the member row itself carries this revocation, so a batch whose first statement changed nothing changes nothing here either. */
export function revokeCredentialsOfMember(db: RelationalStore, memberId: string, revokedBy: string, nowMs: number): PreparedStatement {
  return db
    .prepare(`UPDATE member_credentials SET revoked_at = ?, revoked_by = ?
               WHERE member_id = ? AND revoked_at IS NULL AND ${MEMBER_REVOKED_BY}`)
    .bind(nowMs, revokedBy, memberId, ...memberRevokedByParams(memberId, nowMs, revokedBy));
}

/** Revokes every live token of the lineage `tokenId` belongs to — the named token, its predecessors, and its successors — in one statement; `revoked` counts the rows that changed. */
export async function revokeMemberLineage(db: RelationalStore, tokenId: string, nowMs: number, revokedBy: string): Promise<{ revoked: number }> {
  const result = await db
    .prepare(`UPDATE member_credentials SET revoked_at = ?, revoked_by = ? WHERE lineage_root = (SELECT lineage_root FROM member_credentials WHERE id = ?) AND revoked_at IS NULL`)
    .bind(nowMs, revokedBy, tokenId)
    .run();
  return { revoked: result.meta.changes };
}

/** The window opens at `expires_at − MEMBER_TOKEN_REFRESH_WINDOW_MS`; earlier, the answer is `refresh_too_early` with the instant it opens. A token that already expires at its lineage ceiling answers `lineage_expired`: no successor could outlive it. Past both checks, one batch revokes the live, never-used successor this token may already have and inserts the new one — expiring one TTL from now or at the ceiling, whichever is sooner — and the answer carries the successor's own window start as `refreshAfter`. Both statements act only while the presented token is still live at that instant (`TOKEN_LIVE` on each): a token revoked in between changes nothing — its banked successor stays as it is — and raises `TokenRevokedError`. The presented token stays live; the successor's first authenticated use revokes it. */
export async function refreshMemberToken(db: RelationalStore, subject: RefreshSubject, nowMs: number): Promise<RefreshResult> {
  const opensAt = windowOpensAt(subject.expiresAt);
  if (nowMs < opensAt) return { refreshed: false, code: 'refresh_too_early', reason: REFRESH_TOO_EARLY, refreshAfter: opensAt };
  if (subject.lineageStartedAt + MEMBER_TOKEN_MAX_LINEAGE_MS <= subject.expiresAt) return { refreshed: false, code: 'lineage_expired', reason: LINEAGE_EXPIRED };
  // The successor inherits its runtime binding from the STORED predecessor row, never
  // from the refreshing request. A re-auth that re-establishes identity from what the
  // caller sends is how a device silently loses its binding and reverts to whoever
  // first authenticated it; carrying the row forward is what keeps a refresh a
  // continuation of one runtime rather than a fresh claim about which runtime it is.
  const successor = await mintInsert(db, { memberId: subject.memberId, machineId: subject.machineId }, nowMs,
    { predecessorId: subject.tokenId, lineageRoot: subject.lineageRoot, lineageStartedAt: subject.lineageStartedAt }, subject.runtime);
  const [, inserted] = await db.batch([
    db.prepare(`UPDATE member_credentials SET revoked_at = ? WHERE predecessor_id = ? AND revoked_at IS NULL AND first_used_at IS NULL AND ${TOKEN_LIVE}`).bind(nowMs, subject.tokenId, subject.tokenId),
    successor.statement,
  ]);
  if (inserted.meta.changes !== 1) throw new TokenRevokedError(subject.tokenId);
  return { refreshed: true, ...successor.issued, refreshAfter: windowOpensAt(successor.issued.expiresAt) };
}

/** A successor's first authenticated use, as one batch: the successor takes over what its predecessor holds against the quota (`heldBytes`: the charged counter plus live blob reservations; nothing when the predecessor row is gone) and records the instant; the predecessor is revoked. Every statement guards itself, so a repeat changes nothing. */
export async function activateSuccessor(db: RelationalStore, auth: Pick<MemberAuth, 'tokenId'> & { predecessorId: string }, nowMs: number): Promise<void> {
  const held = heldBytes({ tokenId: auth.predecessorId, now: nowMs });
  await db.batch([
    db.prepare(`UPDATE member_credentials SET bytes_written = COALESCE(${held.sql}, 0), first_used_at = ? WHERE id = ? AND first_used_at IS NULL`).bind(...held.params, nowMs, auth.tokenId),
    db.prepare(`UPDATE member_credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).bind(nowMs, auth.predecessorId),
  ]);
}

/** One read: the database schema version, joined to the credential row for the digest and to its member, kept only while that member is live. The version must equal this build's before any token decision is made; a missing version row is a mismatch. A row without its lineage columns, or whose member is revoked, never authenticates. */
export async function authenticateServerMemberToken(
  db: RelationalStore, digest: string, nowMs: number,
): Promise<MemberAuth | null> {
  const row = await db
    .prepare(`SELECT s.value AS schema_version,
                     t.id, t.member_id, t.machine_id, t.expires_at, t.revoked_at, t.bytes_written,
                     t.lineage_root, t.lineage_started_at, t.predecessor_id, t.first_used_at,
                     t.runtime_label, t.runtime_kind, m.id AS member_live
                FROM schema_meta s
                LEFT JOIN member_credentials t ON t.token_hash = ?
                LEFT JOIN members m ON m.id = t.member_id AND m.revoked_at IS NULL
               WHERE s.key = 'version'`)
    .bind(digest)
    .first<AuthRow>();

  if (!row) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, null);
  if (row.schema_version !== String(SERVER_SCHEMA_VERSION)) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, row.schema_version);
  if (row.id === null || row.member_id === null || row.expires_at === null || row.bytes_written === null) return null;
  if (row.lineage_root === null || row.lineage_started_at === null) return null;
  if (row.revoked_at !== null) return null;
  if (row.member_live === null) return null;
  if (row.expires_at <= nowMs) return null;
  return {
    memberId: row.member_id, tokenId: row.id, machineId: row.machine_id, bytesWritten: row.bytes_written,
    expiresAt: row.expires_at, lineageRoot: row.lineage_root, lineageStartedAt: row.lineage_started_at,
    predecessorId: row.predecessor_id, firstUsedAt: row.first_used_at,
    runtime: { runtimeLabel: row.runtime_label, runtimeKind: row.runtime_kind },
  };
}

/**
 * A presented credential that has already been superseded: its successor has been
 * activated, so the lineage has moved on and this one no longer authenticates.
 */
export interface LineageReplay {
  tokenId: string;
  memberId: string;
  lineageRoot: string;
  machineId: string | null;
  successorId: string;
  /** The instant the successor first authenticated — the instant this credential stopped working. */
  activatedAt: number;
}

/**
 * Whether a digest that failed to authenticate belongs to a credential its own
 * lineage has moved past.
 *
 * A rotation revokes the predecessor at the successor's first use, so a request
 * arriving on the predecessor afterwards is indistinguishable, by its outcome,
 * from a request on a credential an operator revoked or one that simply expired
 * — all three answer 401. That is the case worth naming: a lineage refreshed
 * from a credential that has already been superseded is either a hook that lost
 * a rotation race or a holder of a copy, and only the audit record tells an
 * operator which lineages are seeing it.
 *
 * The read runs only after authentication has already failed, so the admission
 * path stays one statement.
 */
export async function detectLineageReplay(db: RelationalStore, digest: string, nowMs: number): Promise<LineageReplay | null> {
  const row = await db
    .prepare(`SELECT p.id, p.member_id, p.lineage_root, p.machine_id, s.id AS successor_id, s.first_used_at
                FROM member_credentials p
                JOIN member_credentials s ON s.predecessor_id = p.id
               WHERE p.token_hash = ? AND p.revoked_at IS NOT NULL AND s.first_used_at IS NOT NULL
               ORDER BY s.first_used_at DESC`)
    .bind(digest)
    .first<{ id: string; member_id: string; lineage_root: string; machine_id: string | null; successor_id: string; first_used_at: number }>();
  if (row === null) return null;
  return {
    tokenId: row.id, memberId: row.member_id, lineageRoot: row.lineage_root, machineId: row.machine_id,
    successorId: row.successor_id, activatedAt: row.first_used_at,
  };
}

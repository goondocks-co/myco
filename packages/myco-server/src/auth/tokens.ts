import { commitNamed, first, read, refused, rows, type Bound } from '../db/index.js';
import { credentialInsert } from '../db/runs/claim-companions.js';
import {
  activationWrites, CREDENTIAL_NOT_REFRESHABLE, refreshableAssertion, retireBankedWrite,
  revokeLineageAsMemberWrite, revokeLineageWrite, revokeMachineAsMemberWrite,
} from '../db/identity/credentials.js';
import { MEMBER_TOKEN_REFRESH_WINDOW_MS, LINEAGE_REPLAYED_CODE } from '@goondocks/myco-shared/member-protocol';
export { MEMBER_TOKEN_REFRESH_WINDOW_MS, LINEAGE_REPLAYED_CODE };
import { toBase64Url } from '../base64.js';
import type { RelationalStore, PreparedStatement } from '../core/adapters.js';
import { HARNESS_MEMBER_ID, MEMBER_LINEAGE_IDLE_MS, MEMBER_TOKEN_TTL_MS, SERVER_SCHEMA_VERSION, TOKEN_ID_BYTES, TOKEN_ID_PREFIX } from '../constants.js';
import { sha256Hex } from '../hash.js';
import { emit, SchemaMismatchError, TokenRevokedError, type Classifier } from '../telemetry.js';
import type { DashboardMember } from './identity-link.js';
import { authorize, credentialResourceOf, machineResourcesOf, memberSubjectOf } from './authorization.js';
import { readAuthorization } from '../db/auth/authorization.js';

export const MEMBER_TOKEN_BYTES = 32;
export { MEMBER_TOKEN_TTL_MS, MEMBER_LINEAGE_IDLE_MS };

/** How long after its issue (the lineage's last refresh, or the join) a lapsed token may still refresh. Longer than the TTL, so it never bounds a live token. */
/** Shape of every minted token: `MEMBER_TOKEN_BYTES` random bytes as unpadded base64url. */
export const MEMBER_TOKEN_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((MEMBER_TOKEN_BYTES * 4) / 3)}}$`);

export interface MemberAuth {
  /** The member holding this credential. Server-issued; never derived from anything the runtime reports. */
  memberId: string;
  tokenId: string;
  machineId: string | null;
  expiresAt: number;
  /** The first token of the chain this one belongs to: its own id for an operator-minted token. */
  lineageRoot: string;
  /** The issue instant of the lineage root: when the machine joined. Carried to every successor for display; no refresh decides on it. */
  lineageStartedAt: number;
  /** The token this one succeeded by refresh; null for an operator-minted token. */
  predecessorId: string | null;
  /** The instant of a successor's first authenticated use; null until then, and always null for an operator-minted token. */
  firstUsedAt: number | null;
  /** How the runtime described itself at issue. Read-only here; nothing admits or refuses on it. */
  runtime: RuntimeClaims;
  /** Whether the issuer minted this credential to rotate. Set by the insert that minted the row; nothing the runtime sends changes it. */
  rotates: boolean;
}

interface IssuedMemberToken {
  token: string;
  tokenId: string;
  expiresAt: number;
}

/** The chain a successor joins: the token it succeeds, and the root and start it inherits from it. */
interface TokenLineage {
  predecessorId: string;
  lineageRoot: string;
  lineageStartedAt: number;
}

/** What a refresh needs of the presented token. */
type RefreshSubject = Pick<MemberAuth, 'memberId' | 'tokenId' | 'machineId' | 'expiresAt' | 'lineageRoot' | 'lineageStartedAt' | 'runtime'>;

export type RefreshResult =
  | { refreshed: true; token: string; tokenId: string; expiresAt: number; refreshAfter: number }
  | { refreshed: false; code: Classifier; reason: string; refreshAfter?: number };

const REFRESH_TOO_EARLY = 'refresh window not yet open';
/** The `revoked_by` of every row of a lineage the pipeline ended when a superseded credential of it asked to rotate: a credential used from two places, ended by no member. */
export const LINEAGE_REPLAY_REVOKER = 'lineage-replay';

const LINEAGE_INACTIVE = 'token lineage inactive';

/** The instant a token's refresh window opens: `MEMBER_TOKEN_REFRESH_WINDOW_MS` before it expires. Every `refreshAfter` on the wire is this instant for some token. */
const windowOpensAt = (expiresAt: number): number => expiresAt - MEMBER_TOKEN_REFRESH_WINDOW_MS;

interface AuthRow {
  schema_version: string;
  id: string | null;
  member_id: string | null;
  machine_id: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  lineage_root: string | null;
  lineage_started_at: number | null;
  predecessor_id: string | null;
  first_used_at: number | null;
  runtime_label: string | null;
  runtime_kind: string | null;
  rotates: number | null;
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

/**
 * What an issuer decides about a credential it mints, beyond the member and machine. `rotates: false` mints a
 * credential for a runtime that reads it from its environment: an orchestrator hands the same token to every
 * sandbox it starts, so a rotation by any one holder would revoke it under the rest, and a copy that could rotate
 * could fork the lineage. Such a credential is refused on the refresh route, lives out its TTL or a Stop, and is
 * renewed by minting another. A credential that rotates is the default; a successor always rotates.
 */
interface MintOptions {
  rotates?: boolean;
  /** A condition the insert must also meet; a caller batching it decides the outcome from the statement's returned row. */
  claim?: {write:import('../db/index.js').Statement<readonly unknown[],{id:string},'write'>;values:readonly unknown[]};
}


/** The one INSERT into member_credentials, prepared and unrun: a fresh token and id, the digest stored, `bytes_written` at 0, the runtime claims as given, whether it rotates, and the lineage columns — its own id and `nowMs` for a root, the inherited chain for a successor. The row expires one TTL from now. A successor's row always rotates, and is written only while its predecessor is still live and rotates at the instant of the insert (the statement's returned row says whether it was); a root has no predecessor. The optional claim definition conjoins its admission. */
function memberTokenInsert(
  member: { memberId: string; machineId: string | null }, nowMs: number, lineage: TokenLineage | null, tokenId: string, digest: string, runtime: RuntimeClaims,
  options: MintOptions,
): { statement: Bound<{ id: string }, 'write'>; expiresAt: number } {
  const { claim } = options;
  const predecessorId = lineage === null ? null : lineage.predecessorId;
  const lineageRoot = lineage === null ? tokenId : lineage.lineageRoot;
  const lineageStartedAt = lineage === null ? nowMs : lineage.lineageStartedAt;
  const rotates = lineage !== null || options.rotates !== false ? 1 : 0;
  const expiresAt = nowMs + MEMBER_TOKEN_TTL_MS;
  const values = [tokenId, member.memberId, member.machineId, digest, nowMs, expiresAt, predecessorId, lineageRoot, lineageStartedAt, runtime.runtimeLabel, runtime.runtimeKind, rotates, predecessorId, predecessorId, predecessorId];
  const statement = claim === undefined ? credentialInsert.bind(...values) : claim.write.bind(...values,...claim.values);
  return { statement, expiresAt };
}

export async function mintWrite(db: RelationalStore, member: {memberId:string;machineId:string|null}, nowMs:number,
  lineage:TokenLineage|null, runtime:RuntimeClaims, options:MintOptions = {}): Promise<{statement:Bound<{ id: string },'write'>;issued:IssuedMemberToken}> {
  const token=mintMemberToken();
  const tokenId=`${TOKEN_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_ID_BYTES)))}`;
  const inserted=memberTokenInsert(member,nowMs,lineage,tokenId,await sha256Hex(token),runtime,options);
  return {statement:inserted.statement,issued:{token,tokenId,expiresAt:inserted.expiresAt}};
}

/** The attributed revocation of one token row, as a statement: the break-glass script renders it for a token whose successors are known to be its owner's. */
export function revokeCredentialStatement(db: RelationalStore, revokedBy: string, tokenId: string, nowMs: number): PreparedStatement {
  return db
    .prepare(`UPDATE member_credentials SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL`)
    .bind(nowMs, revokedBy, tokenId);
}

/** Revoke an admitted credential's lineage with attribution and the caller's member scope. */
export async function revokeCredentialAsMember(
  db: RelationalStore, actor: DashboardMember, tokenId: string, nowMs: number,
): Promise<{ revoked: boolean; revokedBy: string }> {
  const revokedBy = actor.id;
  const snapshot = await readAuthorization(db, { subjectMember: actor.id, credential: tokenId });
  if (!authorize(memberSubjectOf(snapshot, actor.id, 'http'), 'edit', credentialResourceOf(snapshot, tokenId))) return { revoked: false, revokedBy };
  const revokedRows = await rows(db, revokeLineageAsMemberWrite(nowMs, actor.id, tokenId));
  const revoked = revokedRows.length > 0;
  emit({ kind: 'credential_revoked', tokenId, revokedBy, revoked, rows: revokedRows.length });
  return { revoked, revokedBy };
}

/** End every credential of a claimed machine in one attributed write. */
export async function revokeMachineCredentialsAsMember(
  db: RelationalStore, actor: DashboardMember, machineId: string, nowMs: number,
): Promise<{ revoked: number; revokedBy: string }> {
  const snapshot = await readAuthorization(db, { subjectMember: actor.id, machines: [machineId] });
  if (!authorize(memberSubjectOf(snapshot, actor.id, 'http'), 'edit', machineResourcesOf(snapshot, 'credential', [machineId])[0]!)) return { revoked: 0, revokedBy: actor.id };
  const revokedRows = await rows(db, revokeMachineAsMemberWrite(nowMs, actor.id, machineId));
  emit({ kind: 'credential_revoked', machineId, revokedBy: actor.id, revoked: revokedRows.length > 0, rows: revokedRows.length });
  return { revoked: revokedRows.length, revokedBy: actor.id };
}

/**
 * Revoke a credential only when it belongs to the named member. The dispatch
 * path mints a credential for the harness member per run and releases it when
 * the run ends; a run claimed under a person's own credential carries that
 * credential in the same column, and a release must never end it.
 */
export function revokeCredentialOfMemberStatement(
  db: RelationalStore, memberId: string, tokenId: string, nowMs: number,
  condition?: { sql: string; params: readonly unknown[] },
): PreparedStatement {
  return db.prepare(`UPDATE member_credentials SET revoked_at = ?, revoked_by = ? WHERE id = ? AND member_id = ? AND revoked_at IS NULL${condition === undefined ? '' : ` AND (${condition.sql})`} RETURNING id`)
    .bind(nowMs, memberId, tokenId, memberId, ...(condition?.params ?? []));
}

/** Revoke a member-owned credential and report whether it changed. */
export async function revokeCredentialOfMember(
  db: RelationalStore, memberId: string, tokenId: string, nowMs: number,
): Promise<boolean> {
  const result = await revokeCredentialOfMemberStatement(db, memberId, tokenId, nowMs).run();
  const revoked = result.results.length === 1;
  emit({ kind: 'credential_revoked', tokenId, revokedBy: memberId, revoked });
  return revoked;
}

/** Revokes every live token of the lineage `tokenId` belongs to — the named token, its predecessors, and its successors — in one statement; `revoked` counts the rows that changed. */
export async function revokeMemberLineage(db: RelationalStore, tokenId: string, nowMs: number, revokedBy: string): Promise<{ revoked: number }> {
  return { revoked: (await rows(db, revokeLineageWrite(nowMs, revokedBy, tokenId))).length };
}

/** The window opens at `expires_at − MEMBER_TOKEN_REFRESH_WINDOW_MS`; earlier, the answer is `refresh_too_early` with the instant it opens. It stays open past the token's own expiry: a token that lapsed with its holder offline still asks for its successor until `MEMBER_LINEAGE_IDLE_MS` after its own `issued_at` (`lineageInactive`); past that it answers `lineage_expired`, the code every member build treats as final. A lineage is never refused for its age: every successor expires one TTL from its refresh. Past both checks, one batch revokes the live, never-used successor this token may already have and inserts the new one, and the answer carries the successor's own window start as `refreshAfter`. Both statements act only while the presented token is still live at that instant (`TOKEN_LIVE` on each): a token revoked in between changes nothing — its banked successor stays as it is — and raises `TokenRevokedError`. The presented token stays live; the successor's first authenticated use revokes it. */
export async function refreshMemberToken(db: RelationalStore, subject: RefreshSubject, nowMs: number): Promise<RefreshResult> {
  const opensAt = windowOpensAt(subject.expiresAt);
  if (nowMs < opensAt) return { refreshed: false, code: 'refresh_too_early', reason: REFRESH_TOO_EARLY, refreshAfter: opensAt };
  if (subject.expiresAt <= nowMs && await lineageInactive(db, subject.tokenId, nowMs)) return { refreshed: false, code: 'lineage_expired', reason: LINEAGE_INACTIVE };
  // The successor inherits its runtime binding from the STORED predecessor row, never
  // from the refreshing request. A re-auth that re-establishes identity from what the
  // caller sends is how a device silently loses its binding and reverts to whoever
  // first authenticated it; carrying the row forward is what keeps a refresh a
  // continuation of one runtime rather than a fresh claim about which runtime it is.
  const successor = await mintWrite(db, { memberId: subject.memberId, machineId: subject.machineId }, nowMs,
    { predecessorId: subject.tokenId, lineageRoot: subject.lineageRoot, lineageStartedAt: subject.lineageStartedAt }, subject.runtime);
  let inserted: { id: string } | undefined;
  try {
    const committed = await commitNamed(db, {
      refreshable: refreshableAssertion(subject.tokenId),
      retired: retireBankedWrite(nowMs, subject.tokenId),
      successor: successor.statement,
    });
    inserted = committed.successor.results[0];
  } catch (error) {
    if (refused(error, CREDENTIAL_NOT_REFRESHABLE)) throw new TokenRevokedError(subject.tokenId);
    throw error;
  }
  if (inserted === undefined) throw new TokenRevokedError(subject.tokenId);
  return { refreshed: true, ...successor.issued, refreshAfter: windowOpensAt(successor.issued.expiresAt) };
}

/** Whether a lapsed token's lineage has gone unrefreshed for `MEMBER_LINEAGE_IDLE_MS`, read off the presented row's immutable `issued_at` — not `first_used_at`, which the pipeline stamps on this very request when it activates a never-used successor. A missing row reads as active and meets the insert's liveness gate. */
async function lineageInactive(db: RelationalStore, tokenId: string, nowMs: number): Promise<boolean> {
  const row = await first(db, credentialIssuedAt.bind(tokenId));
  return row !== null && row.issued_at + MEMBER_LINEAGE_IDLE_MS <= nowMs;
}
const credentialIssuedAt = read<[token: string], { issued_at: number }>({ name: 'credential.issuedAt', sql: 'SELECT issued_at FROM member_credentials WHERE id=?1' });

/**
 * A successor's first authenticated use atomically transfers live worker leases and stored bytes, records the instant,
 * and revokes the predecessor, all conditional on that successor still being live and unused at this commit. The attempt
 * identity and completed-run attribution stay unchanged. Answers whether this request activated it; a successor already
 * replaced activates nothing and ends nothing.
 */
export async function activateSuccessor(db: RelationalStore, auth: Pick<MemberAuth, 'tokenId'> & { predecessorId: string }, nowMs: number): Promise<boolean> {
  const { stamp } = await commitNamed(db, activationWrites(auth.tokenId, auth.predecessorId, nowMs));
  return stamp.results.length === 1;
}

/** Whether a credential past its own expiry authenticates: `live` refuses it, `lapsed` admits it — for credential routes declaring `admitsLapsed`: refresh checks lineage inactivity, and self-revocation ends the lineage. A revoked credential, or one whose member is revoked, never authenticates under either. */
export type ExpiryAdmission = 'live' | 'lapsed';

/** One read: the database schema version, joined to the credential row for the digest and to its member, kept only while that member is live. The version must equal this build's before any token decision is made; a missing version row is a mismatch. A row without its lineage columns, or whose member is revoked, never authenticates; an expired row authenticates only under `lapsed`. */
export async function authenticateServerMemberToken(
  db: RelationalStore, digest: string, nowMs: number, expiry: ExpiryAdmission = 'live',
): Promise<MemberAuth | null> {
  const row = await db
    .prepare(`SELECT s.value AS schema_version,
                     t.id, t.member_id, t.machine_id, t.expires_at, t.revoked_at,
                     t.lineage_root, t.lineage_started_at, t.predecessor_id, t.first_used_at,
                     t.runtime_label, t.runtime_kind, t.rotates, m.id AS member_live
                FROM schema_meta s
                LEFT JOIN member_credentials t ON t.token_hash = ?
                LEFT JOIN members m ON m.id = t.member_id AND m.revoked_at IS NULL
               WHERE s.key = 'version'`)
    .bind(digest)
    .first<AuthRow>();

  if (!row) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, null);
  if (row.schema_version !== String(SERVER_SCHEMA_VERSION)) throw new SchemaMismatchError(SERVER_SCHEMA_VERSION, row.schema_version);
  if (row.id === null || row.member_id === null || row.expires_at === null) return null;
  if (row.lineage_root === null || row.lineage_started_at === null) return null;
  if (row.revoked_at !== null) return null;
  if (row.member_live === null) return null;
  if (expiry === 'live' && row.expires_at <= nowMs) return null;
  return {
    memberId: row.member_id, tokenId: row.id, machineId: row.machine_id,
    expiresAt: row.expires_at, lineageRoot: row.lineage_root, lineageStartedAt: row.lineage_started_at,
    predecessorId: row.predecessor_id, firstUsedAt: row.first_used_at,
    runtime: { runtimeLabel: row.runtime_label, runtimeKind: row.runtime_kind },
    rotates: row.rotates === 1,
  };
}

/**
 * A presented credential that has already been superseded: its successor has been
 * activated, so the lineage has moved on and this one no longer authenticates.
 */
interface LineageReplay {
  tokenId: string;
  memberId: string;
  lineageRoot: string;
  machineId: string | null;
  successorId: string;
  /** The instant the successor first authenticated — the instant this credential stopped working. */
  activatedAt: number;
  /** The presented credential's own `issued_at`. */
  issuedAt: number;
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
 * A successor revoked before its first use has been passed over too
 * when its predecessor has another successor that has been used: a second
 * holder rotated the same predecessor, and the lineage moved on through theirs.
 * A successor revoked unused with no used sibling moved nothing on — an
 * operator ended it, or a later refresh by the same holder replaced it.
 *
 * The read runs only after authentication has already failed, so the admission
 * path stays one statement.
 */
export async function detectLineageReplay(db: RelationalStore, digest: string, nowMs: number): Promise<LineageReplay | null> {
  const row = await db
    .prepare(`SELECT p.id, p.member_id, p.lineage_root, p.machine_id, p.issued_at, s.id AS successor_id, s.first_used_at
                FROM member_credentials p
                JOIN member_credentials s ON s.lineage_root = p.lineage_root AND s.id <> p.id AND s.first_used_at IS NOT NULL
                 AND (s.predecessor_id = p.id OR (p.first_used_at IS NULL AND s.predecessor_id = p.predecessor_id))
               WHERE p.token_hash = ? AND p.revoked_at IS NOT NULL
               ORDER BY s.first_used_at DESC`)
    .bind(digest)
    .first<{ id: string; member_id: string; lineage_root: string; machine_id: string | null; issued_at: number; successor_id: string; first_used_at: number }>();
  if (row === null) return null;
  return {
    tokenId: row.id, memberId: row.member_id, lineageRoot: row.lineage_root, machineId: row.machine_id,
    successorId: row.successor_id, activatedAt: row.first_used_at, issuedAt: row.issued_at,
  };
}

/** Whether a digest that failed to authenticate belongs to a row a replay revocation ended (`LINEAGE_REPLAY_REVOKER`). */
export async function revokedForReplay(db: RelationalStore, digest: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS hit FROM member_credentials WHERE token_hash = ? AND revoked_by = ?`).bind(digest, LINEAGE_REPLAY_REVOKER).first<{ hit: number }>();
  return row !== null;
}

/** A release-retired credential can read its close acknowledgement until its original expiry. */
export async function releasedRunCredential(db: RelationalStore, digest: string, now: number): Promise<{ memberId: string; tokenId: string } | null> {
  return db.prepare(`SELECT t.member_id AS memberId, t.id AS tokenId FROM member_credentials t
    JOIN members m ON m.id = t.member_id AND m.revoked_at IS NULL
    WHERE t.token_hash = ? AND t.member_id = ? AND t.revoked_by = ? AND t.revoked_at IS NOT NULL AND t.expires_at > ?`)
    .bind(digest, HARNESS_MEMBER_ID, HARNESS_MEMBER_ID, now).first<{ memberId: string; tokenId: string }>();
}

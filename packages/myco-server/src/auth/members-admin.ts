import { isSystemMember, personMemberSql } from './member-kind.js';
/**
 * Members, as the dashboard administers them.
 *
 * Membership has two roles. An admin administers membership — minting and
 * revoking invitations, revoking members, revoking any member's credential — and
 * a member does everything else, including reading this list: hiding the people
 * who can revoke you from you would make the list a privilege rather than a
 * record. Every revocation names who performed it whatever their role.
 *
 * Revoking a member is one transaction — the member row first, carrying
 * the one rule that holds the Deployment open, then every live credential,
 * unspent invitation and link key of that member, each conditioned on the
 * member row having changed in this very transaction. Machine claims are
 * permanent and untouched: a departed member's history stays theirs.
 */
import type { ErrorClassifier, PreparedStatement, RelationalStore } from '../core/adapters.js';
import { emit, failureTelemetry } from '../telemetry.js';
import { nameFromLogin, GITHUB_LOGIN_KEY_PREFIX } from '../db/identity/member-naming.js';
import { recordMemberNamingFailure } from '../db/meta/member-naming-failure.js';
import { FOREIGN_LINEAGE_REVOKER, HARNESS_MEMBER_ID } from '../constants.js';
import { credentialLive, runCredential, MEMBER_REVOKED_BY, memberRevokedByParams } from '../db/liveness.js';
import { revokeInvitationsOfMember } from './enrollment.js';
import { removableAdministratorSql, deploymentOwnerSql } from '../core/ownership.js';
import { revokeLinkKeysOfMember } from './identity-link.js';
import { revokeCredentialsOfMember } from './tokens.js';
import { clearMemberUncapturedStatement } from '../ingest/uncaptured.js';
import { asMemberRole, isAdmin, type MemberRole } from './roles.js';
import { memberWriteOutcome } from './member-write-refusal.js';

export interface MemberRow {
  id: string;
  label: string | null;
  /** What this member may administer. Every member reads this list; only an admin acts on it. */
  role: MemberRole;
  effectiveRole: 'owner' | MemberRole;
  roleRevision: string;
  /** Whether a GitHub account is connected. The account itself is never listed. */
  linked: boolean;
  createdAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  /** Whether a restore from another Deployment brought this member in held: listed, unable to sign in, until the owner re-admits it by assigning a role. */
  awaitingAdmission: boolean;
  /** How many of this member's own runtimes authenticate now. Run credentials are counted under their purpose, not here. */
  liveCredentials: number;
  /** Whether this member is the Deployment's own, the account the runs it starts sign in as, rather than a person. */
  system: boolean;
}

export async function listMembers(db: RelationalStore, nowMs: number): Promise<MemberRow[]> {
  const { results } = await db
    .prepare(`SELECT m.id, m.label, m.role, m.role_revision, ${deploymentOwnerSql('m.id')} AS owner, m.github_id IS NOT NULL AS linked, m.created_at, m.revoked_at, m.revoked_by,
                     (SELECT COUNT(*) FROM member_credentials c WHERE c.member_id = m.id AND ${credentialLive('c')} AND NOT (${runCredential('c')})) AS live_credentials
                FROM members m ORDER BY m.created_at ASC, m.id ASC`)
    .bind(nowMs, HARNESS_MEMBER_ID)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: r.id as string,
    label: (r.label as string | null) ?? null,
    role: asMemberRole(r.role) ?? 'member',
    effectiveRole: Number(r.owner) === 1 ? 'owner' : asMemberRole(r.role) ?? 'member',
    roleRevision: String(r.role_revision),
    linked: Number(r.linked) === 1,
    createdAt: r.created_at as number,
    revokedAt: (r.revoked_at as number | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    awaitingAdmission: r.revoked_at !== null && r.revoked_by === FOREIGN_LINEAGE_REVOKER,
    liveCredentials: Number(r.live_credentials),
    system: isSystemMember(String(r.id)),
  }));
}

/** A GitHub login as GitHub grants one: letters, digits and single hyphens, at most 39. */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/**
 * Record the linked account's GitHub login and name a member with no name or only the first-owner placeholder.
 * A name an admin gave is never replaced. Answers the name written, or null when nothing was.
 */
export async function nameMemberFromLogin(db: RelationalStore, memberId: string, githubId: string, login: string): Promise<string | null> {
  if (!GITHUB_LOGIN.test(login)) return null;
  return nameFromLogin(db, memberId, githubId, login);
}

/** Naming is a courtesy of sign-in: a storage failure leaves authentication and approval intact, and is recorded for Attention. */
export async function tryNameMemberFromLogin(db: RelationalStore, memberId: string, githubId: string, login: string, classifyError: ErrorClassifier): Promise<string | null> {
  try {
    return await nameMemberFromLogin(db, memberId, githubId, login);
  } catch (error) {
    const failure = failureTelemetry(error, classifyError);
    emit({ kind: 'member_naming_failed', memberId, ...failure });
    try { await recordMemberNamingFailure(db, memberId, failure.error_class, Date.now()); }
    catch (recording) { emit({ kind: 'member_naming_record_failed', memberId, ...failureTelemetry(recording, classifyError) }); }
    return null;
  }
}

/** Reads the member's role, linked GitHub login and ownership within the credential's transaction. */
export function identityBehindCredentialStatement(db: RelationalStore, tokenId: string): PreparedStatement {
  return db
    .prepare(`SELECT m.role AS role,
      (SELECT value FROM schema_meta WHERE key = ? || m.github_id) AS memberLabel,
      ${deploymentOwnerSql('m.id')} AS owner
      FROM member_credentials c JOIN members m ON m.id = c.member_id WHERE c.id = ?`)
    .bind(GITHUB_LOGIN_KEY_PREFIX, tokenId);
}

/** The role a member holds, or null when the Deployment holds no such member. */
export async function memberRole(db: RelationalStore, memberId: string): Promise<MemberRole | null> {
  const row = await db.prepare(`SELECT role FROM members WHERE id = ?`).bind(memberId).first<{ role: string }>();
  return row === null ? null : asMemberRole(row.role);
}

/** Whether `memberId` is a live admin of this Deployment. */
export async function isLiveAdmin(db: RelationalStore, memberId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT role FROM members WHERE id = ? AND revoked_at IS NULL`).bind(memberId).first<{ role: string }>();
  return row !== null && isAdmin(asMemberRole(row.role) ?? 'member');
}

export type MemberState = 'absent' | 'live' | 'revoked';

export async function memberState(db: RelationalStore, memberId: string): Promise<MemberState> {
  const row = await db.prepare(`SELECT revoked_at FROM members WHERE id = ?`).bind(memberId).first<{ revoked_at: number | null }>();
  if (row === null) return 'absent';
  return row.revoked_at === null ? 'live' : 'revoked';
}

export type RevokeMemberRefusal = 'absent' | 'already_revoked' | 'last_member' | 'last_admin' | 'active_owner' | 'not_owner' | 'system_member';
export type RevokeMemberResult = { ok: true } | { ok: false; reason: RevokeMemberRefusal };

/**
 * Revokes a member and everything live that is theirs, in one transaction.
 *
 * The member statement runs first and refuses to leave the Deployment with no
 * live linked member, or with no live linked admin: the admin who can sign in
 * is who links every later member, and a Deployment left without one would
 * reopen the bootstrap a member credential links itself through. Every later
 * statement matches rows only when that first one changed the member row. A
 * refused revocation therefore changes nothing, and the read afterwards only
 * names which refusal it was.
 */
export async function revokeMember(db: RelationalStore, memberId: string, actor: string, nowMs: number): Promise<RevokeMemberResult> {
  const outcome = await memberWriteOutcome(() => db.batch([
    db.prepare(`UPDATE members SET revoked_at = ?, revoked_by = ?
                 WHERE id = ? AND revoked_at IS NULL AND ${personMemberSql('id')}
                   AND (SELECT COUNT(*) FROM members WHERE revoked_at IS NULL AND github_id IS NOT NULL AND id <> ?) >= 1
                   AND ${removableAdministratorSql('members')}
                   AND (role <> 'admin' OR ${deploymentOwnerSql('?')})
                   AND EXISTS (SELECT 1 FROM members actor WHERE actor.id = ? AND actor.role = 'admin' AND actor.revoked_at IS NULL)
                 RETURNING id`)
      .bind(nowMs, actor, memberId, memberId, actor, actor),
    revokeCredentialsOfMember(db, memberId, actor, nowMs),
    revokeInvitationsOfMember(db, memberId, actor, nowMs),
    revokeLinkKeysOfMember(db, memberId, actor, nowMs),
    clearMemberUncapturedStatement(db, memberId, actor, nowMs),
    db.prepare(`DELETE FROM schema_meta WHERE key = (
      SELECT ? || github_id FROM members WHERE id = ?) AND ${MEMBER_REVOKED_BY}`)
      .bind(GITHUB_LOGIN_KEY_PREFIX, memberId, ...memberRevokedByParams(memberId, nowMs, actor)),
  ]));
  if (outcome.admitted && outcome.value[0]?.results.length === 1) {
    emit({ kind: 'member_revoked', memberId, actor });
    return { ok: true };
  }
  if (isSystemMember(memberId)) return { ok: false, reason: 'system_member' };
  const state = await memberState(db, memberId);
  if (state !== 'live') return { ok: false, reason: state === 'absent' ? 'absent' : 'already_revoked' };
  const protectedOwner = await db.prepare('SELECT 1 FROM deployment_ownership WHERE id = 1 AND member_id = ?').bind(memberId).first();
  if (protectedOwner !== null) return { ok: false, reason: 'active_owner' };
  const targetRole = await memberRole(db, memberId);
  const actorOwner = await db.prepare(`SELECT ${deploymentOwnerSql('?')} AS admitted`).bind(actor).first<{ admitted: number }>();
  if (targetRole === 'admin' && actorOwner?.admitted !== 1) return { ok: false, reason: 'not_owner' };
  const others = await db
    .prepare(`SELECT COUNT(*) AS linked FROM members WHERE revoked_at IS NULL AND github_id IS NOT NULL AND id <> ?`)
    .bind(memberId)
    .first<{ linked: number }>();
  return { ok: false, reason: Number(others?.linked) === 0 ? 'last_member' : 'last_admin' };
}

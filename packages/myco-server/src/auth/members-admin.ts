import { isSystemMember } from './member-kind.js';
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
import type { ErrorClassifier, RelationalStore } from '../core/adapters.js';
import { emit, failureTelemetry } from '../telemetry.js';
import { nameFromLogin } from '../db/identity/member-naming.js';
import { recordMemberNamingFailure } from '../db/meta/member-naming-failure.js';
import { FOREIGN_LINEAGE_REVOKER } from '../constants.js';
import { memberPage, type MemberPageRow, type RuntimeFreshness } from '../db/identity/access-pages.js';
import { MAX_PAGE, type Page } from '../read/scope.js';
import { actsAsOwner, isOwnerMember, memberRoleRow, otherLinkedMemberCount } from '../db/identity/member-standing.js';
import { memberLinkRowOf } from '../db/identity/link.js';
import { memberRevocationWrites } from '../db/identity/member-revocation.js';
import { commitNamed } from '../db/index.js';
import { asMemberRole, type MemberRole } from './roles.js';
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
  /** How many of this member's own runtimes authenticate now, null while it is still being counted. Run credentials are counted under their purpose, not here. */
  liveCredentials: number | null;
  /** The instant `liveCredentials` describes and whether it is counted yet. */
  runtimeFreshness: RuntimeFreshness;
  /** Whether this member is the Deployment's own, the account the runs it starts sign in as, rather than a person. */
  system: boolean;
}

function memberRowOf(r: MemberPageRow, now: number, countsReady: boolean): MemberRow {
  return {
    id: r.id,
    label: r.label,
    role: asMemberRole(r.role) ?? 'member',
    effectiveRole: r.owner === 1 ? 'owner' : asMemberRole(r.role) ?? 'member',
    roleRevision: String(r.role_revision),
    linked: r.linked === 1,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
    awaitingAdmission: r.revoked_at !== null && r.revoked_by === FOREIGN_LINEAGE_REVOKER,
    liveCredentials: countsReady ? r.live_lineages : null,
    runtimeFreshness: { state: countsReady ? 'ready' : 'building', asOf: now },
    system: isSystemMember(r.id),
  };
}

/** One page of the Deployment's members, oldest first, with no total. */
export async function listMembers(db: RelationalStore, nowMs: number, opts: { limit?: number; cursor?: string } = {}): Promise<Page<MemberRow>> {
  const { rows, cursor, countsReady } = await memberPage(db, nowMs, opts);
  return { rows: rows.map((row) => memberRowOf(row, nowMs, countsReady)), cursor };
}

/** Every member, one bounded page at a time: the command-line view of a Deployment's people, which is not paged. */
export async function everyMember(db: RelationalStore, nowMs: number): Promise<MemberRow[]> {
  const members: MemberRow[] = [];
  let cursor: string | undefined;
  do {
    const next = await listMembers(db, nowMs, { limit: MAX_PAGE, cursor });
    members.push(...next.rows);
    cursor = next.cursor ?? undefined;
  } while (cursor !== undefined);
  return members;
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

/** The role a member holds, or null when the Deployment holds no such member. */
async function memberRole(db: RelationalStore, memberId: string): Promise<MemberRole | null> {
  const role = await memberRoleRow(db, memberId);
  return role === null ? null : asMemberRole(role);
}

type MemberState = 'absent' | 'live' | 'revoked';

export async function memberState(db: RelationalStore, memberId: string): Promise<MemberState> {
  const row = await memberLinkRowOf(db, memberId);
  if (row === null) return 'absent';
  return row.revoked_at === null ? 'live' : 'revoked';
}

type RevokeMemberRefusal = 'absent' | 'already_revoked' | 'last_member' | 'last_admin' | 'active_owner' | 'not_owner' | 'system_member';
type RevokeMemberResult = { ok: true } | { ok: false; reason: RevokeMemberRefusal };

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
  const outcome = await memberWriteOutcome(() => commitNamed(db, memberRevocationWrites(memberId, actor, nowMs)));
  if (outcome.admitted && outcome.value.member.results.length === 1) {
    emit({ kind: 'member_revoked', memberId, actor });
    return { ok: true };
  }
  if (isSystemMember(memberId)) return { ok: false, reason: 'system_member' };
  const state = await memberState(db, memberId);
  if (state !== 'live') return { ok: false, reason: state === 'absent' ? 'absent' : 'already_revoked' };
  if (await isOwnerMember(db, memberId)) return { ok: false, reason: 'active_owner' };
  const targetRole = await memberRole(db, memberId);
  if (targetRole === 'admin' && !await actsAsOwner(db, actor)) return { ok: false, reason: 'not_owner' };
  return { ok: false, reason: await otherLinkedMemberCount(db, memberId) === 0 ? 'last_member' : 'last_admin' };
}

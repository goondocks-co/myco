import type { Bound } from '../db/index.js';
import { commitNamed, first, rows } from '../db/index.js';
import { machineRename, memberIdentityInsert, enrollmentExplanation, enrollmentMint, enrollmentRevoke, enrollmentTargetRead } from '../db/identity/enrollment.js';
/**
 * Enrollment authorities — evidence exchanged for a member credential by the
 * shared enrollment operation, never credentials used for ordinary requests.
 *
 *   - 256 bits of entropy. Nothing rate-limits a guess into existence.
 *   - HASHED AT REST. The raw value is revealed to the enrolling machine, never
 *     persisted in the Deployment's store.
 *   - SINGLE USE, spent by an atomic conditional update that reports whether it
 *     changed a row.
 *   - EXPIRING, so an invitation left in a chat log stops working on its own.
 *   - REVOCABLE before use, and recording which runtime spent it.
 */
import { toBase64Url } from '../base64.js';
import type { RelationalStore } from '../core/adapters.js';
import { sha256Hex } from '../hash.js';
import { asMemberRole, type MemberRole } from './roles.js';
import { invitationPage } from '../db/identity/access-pages.js';
import type { Page } from '../read/scope.js';
import { authorize, enrollmentResourceOf, memberSubjectOf } from './authorization.js';
import { readAuthorization } from '../db/auth/authorization.js';

type EnrollmentIssuer = { kind: 'member'; memberId: string } | { kind: 'operator' };

/** The identity grammar for enrolled machines and their runtime labels and kinds. */
export const ENROLLMENT_IDENTITY_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class EnrollmentAuthorizationError extends Error {
  constructor() { super('enrollment authority refused'); }
}

function enrollmentIssuerMember(issuer: EnrollmentIssuer): string | null {
  if (issuer?.kind === 'operator') return null;
  if (issuer?.kind === 'member' && typeof issuer.memberId === 'string' && issuer.memberId) return issuer.memberId;
  throw new EnrollmentAuthorizationError();
}

/** Bytes of entropy in an enrollment key. 32 = 256 bits. */
export const ENROLLMENT_KEY_BYTES = 32;

/** Default lifetime of a freshly minted key. An invitation is handed over in the moment; one that outlives the conversation is a standing credential nobody remembers issuing. */
export const ENROLLMENT_TTL_MS = 60 * 60 * 1000;

export const ENROLLMENT_ID_PREFIX = 'en_';
const ENROLLMENT_ID_BYTES = 12;

/** Shape of every minted key: `ENROLLMENT_KEY_BYTES` random bytes as unpadded base64url. */
export const ENROLLMENT_KEY_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((ENROLLMENT_KEY_BYTES * 4) / 3)}}$`);

interface IssuedEnrollmentAuthority {
  key: string;
  id: string;
  expiresAt: number;
}

/**
 * The write that stores a fresh key's digest, and the instant it expires.
 *
 * `memberId` is what the key admits the joiner AS. Null means the join enrolls a
 * new person and the server names the member; a value means the key adds another
 * runtime to a member who already exists — the same human on a second machine or
 * in a sandbox, which the model requires be one identity rather than two.
 * Whichever it is, it is fixed when the key is minted: the joiner never names its
 * own member, so a stolen key cannot be redirected at somebody else's identity.
 *
 * `role` and `projectId` are fixed at the same moment and for the same reason.
 * `role` is required and grants a new member that role. An existing member keeps
 * their current role and ownership authority. `projectId` binds the key to one Project — a sandbox needs one to
 * write its registry entry, a person joining the Deployment needs none — and a
 * key that carries none is refused the binding rather than given a guess.
 */
export function enrollmentMintWrite(
  nowMs: number, ttlMs: number, issuer: EnrollmentIssuer, keyHash: string, id: string,
  grant: { role: MemberRole; memberId?: string | null; projectId?: string | null },
): { write: Bound<{ id: string }, 'write'>; expiresAt: number } {
  const expiresAt = nowMs + ttlMs;
  return {
    write: enrollmentMint.bind(enrollmentIssuerMember(issuer), grant.memberId ?? null, grant.role, id, keyHash, nowMs, expiresAt, grant.projectId ?? null),
    expiresAt,
  };
}

/** Sole enrollment minter. Stores the digest and returns the raw key once. `role` grants a new member's authority; existing members keep their authority. */
export async function issueEnrollmentAuthority(
  db: RelationalStore, nowMs: number,
  options: { role: MemberRole; issuer: EnrollmentIssuer; ttlMs?: number; memberId?: string | null; projectId?: string | null },
): Promise<IssuedEnrollmentAuthority> {
  const createdByMember = enrollmentIssuerMember(options.issuer);
  const issuer: EnrollmentIssuer = createdByMember === null ? { kind: 'operator' } : { kind: 'member', memberId: createdByMember };
  if (createdByMember !== null) {
    const target = options.memberId ?? null;
    const snapshot = await readAuthorization(db, target === null ? { subjectMember: createdByMember } : { subjectMember: createdByMember, targetMember: target });
    if (!authorize(memberSubjectOf(snapshot, createdByMember, 'http'), options.role === 'admin' ? 'owner' : 'admin', enrollmentResourceOf(snapshot, target, options.role))) throw new EnrollmentAuthorizationError();
  }
  const key = toBase64Url(crypto.getRandomValues(new Uint8Array(ENROLLMENT_KEY_BYTES)));
  const id = `${ENROLLMENT_ID_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(ENROLLMENT_ID_BYTES)))}`;
  const mint = enrollmentMintWrite(nowMs, options.ttlMs ?? ENROLLMENT_TTL_MS, issuer, await sha256Hex(key), id, options);
  if ((await rows(db, mint.write)).length !== 1) throw new EnrollmentAuthorizationError();
  const { expiresAt } = mint;
  return { key, id, expiresAt };
}

/** Why a presented key cannot be spent. */
export type EnrollmentRefusal = 'unknown' | 'already_used' | 'expired' | 'revoked' | 'no_project';

/** An existing runtime member keeps its role. */
export function ensureMemberWrite(db: RelationalStore, id: string, nowMs: number, role: MemberRole, label = id): Bound {
  return memberIdentityInsert.bind(id, label, nowMs, role);
}

/** The invitation's immutable target and granted role, or null for an absent or invalid invitation. */
export async function enrollmentTarget(db: RelationalStore, keyHash: string): Promise<{ id: string; memberId: string | null; role: MemberRole; projectId: string | null } | null> {
  const row = await first(db, enrollmentTargetRead.bind(keyHash));
  if (row === null) return null;
  const role = asMemberRole(row.role);
  return role === null ? null : { id: row.id, memberId: row.member_id, role, projectId: row.project_id };
}

/** Why a key could not be spent, or that nothing about the key refuses it. */
type SpendRefusal = { admissible: false; reason: EnrollmentRefusal } | { admissible: true };

/** Describes enrollment refusals in wire precedence order after a transaction admits no credential. */
export async function explainEnrollment(
  db: RelationalStore, presentedKey: string, nowMs: number, opts: { forProject?: boolean; memberId?: string } = {},
): Promise<SpendRefusal> {
  if (!ENROLLMENT_KEY_PATTERN.test(presentedKey)) return { admissible: false, reason: 'unknown' };
  const row = await first(db, enrollmentExplanation.bind(await sha256Hex(presentedKey)));
  if (row === null) return { admissible: false, reason: 'unknown' };
  if (row.revoked_at !== null || Number(row.voided) === 1) return { admissible: false, reason: 'revoked' };
  if (row.used_at !== null) return { admissible: false, reason: 'already_used' };
  if (row.expires_at <= nowMs) return { admissible: false, reason: 'expired' };
  if (opts.forProject === true && row.project_id === null) return { admissible: false, reason: 'no_project' };
  if (asMemberRole(row.role) === null) return { admissible: false, reason: 'revoked' };
  if (opts.memberId !== undefined && row.member_id !== null && row.member_id !== opts.memberId) return { admissible: false, reason: 'revoked' };
  return { admissible: true };
}

/** Revokes an unused key, naming who. `revoked` is false when no unused row matched the id. */
export async function revokeEnrollmentAuthority(
  db: RelationalStore, id: string, nowMs: number, revokedBy: string,
): Promise<{ revoked: boolean }> {
  return { revoked: (await rows(db, enrollmentRevoke.bind(nowMs, revokedBy, id))).length === 1 };
}

export interface InvitationRow {
  id: string;
  /** The member the invitation adds a runtime to, or null for a new member. */
  memberId: string | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  /** What the invitation grants. */
  role: MemberRole;
  /** The Project a sandbox joining on this invitation binds to, or null for a person joining the Deployment. */
  projectId: string | null;
}

/** Every live invitation: unspent, unrevoked, unexpired, and its member and minter live. Never the key or its digest. */
export async function listInvitations(db: RelationalStore, nowMs: number, opts: { limit?: number; cursor?: string } = {}): Promise<Page<InvitationRow>> {
  const { rows, cursor } = await invitationPage(db, nowMs, opts);
  return {
    cursor,
    rows: rows.map((r) => ({
      id: r.id,
      memberId: r.member_id,
      createdBy: r.created_by_member,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      role: asMemberRole(r.role) ?? 'member',
      projectId: r.project_id,
    })),
  };
}

/**
 * Records a member if the Deployment does not already hold one under `id`. Idempotent:
 * a second call for the same id changes nothing and never disturbs an existing label
 * or role. A second invitation therefore adds a runtime to a member at the role that
 * member already holds; changing a role is an administrative act, not a side effect
 * of joining again.
 *
 * Every credential carries a foreign key to `members`, so this is what has to have run
 * before one can be issued. It lives here rather than at each caller so the member row
 * and the credential row are written by the same module — a facade that opens its own
 * INSERT is the shape the read-layer gate refuses.
 */
export async function ensureMember(db: RelationalStore, id: string, nowMs: number, role: MemberRole, label = id): Promise<void> {
  await rows(db, memberIdentityInsert.bind(id, label, nowMs, role));
}

/**
 * Name a machine: one write to its claim, by an admin or the member the machine belongs to, the rule held in the
 * statement. True when the machine took the name; false for a machine that is absent or that `actor` may not rename,
 * which the caller answers alike.
 */
export async function renameMachine(db: RelationalStore, actor: { memberId: string }, machineId: string, name: string): Promise<boolean> {
  return (await rows(db, machineRename.bind(name, machineId, actor.memberId))).length === 1;
}

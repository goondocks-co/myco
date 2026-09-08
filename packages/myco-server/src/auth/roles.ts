/**
 * The two roles a member holds, and the one admission predicate every
 * admin-only surface answers to.
 *
 * A role travels on two rows and nowhere else: `members.role` is what a member
 * holds, and `enrollment_authorities.role` is what an invitation grants. The
 * second is fixed when the invitation is minted, so a stolen key admits at the
 * role its minter chose and never at one the joiner names.
 *
 * Admission is a function of the role alone. Nothing here reads a request, a
 * body or a session: a surface decides who may reach it by calling `isAdmin`
 * with the member the pipeline already resolved, so there is one answer per
 * member per request rather than one per call site.
 */

/** Every role. An admin administers membership; a member does everything else. */
export const MEMBER_ROLES = ['admin', 'member'] as const;

export type MemberRole = (typeof MEMBER_ROLES)[number];

/** The role a value names, or null when it names none. The sole parser: a stored or presented role reaches the rest of the server only through this. */
export function asMemberRole(value: unknown): MemberRole | null {
  return typeof value === 'string' && (MEMBER_ROLES as readonly string[]).includes(value) ? (value as MemberRole) : null;
}

/** The roles as a SQL list, so a statement that guards on the grammar and this module cannot drift apart. */
export const MEMBER_ROLES_SQL = MEMBER_ROLES.map((r) => `'${r}'`).join(', ');

/** Whether this role administers membership: minting and revoking invitations, revoking members, revoking any member's credential. */
export const isAdmin = (role: MemberRole): boolean => role === 'admin';

/** The one refusal an admin-only surface answers. A member reaching one is authenticated and known, so this states what it lacks rather than denying it exists. */
export const forbiddenToMember = (): Response =>
  Response.json({ error: 'not_admin', reason: 'this action is for an admin' }, { status: 403 });

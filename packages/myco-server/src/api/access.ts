import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { ENROLLMENT_TTL_MS, issueEnrollmentAuthority, listInvitations, revokeEnrollmentAuthority } from '../auth/enrollment.js';
import { ADMIN_IDENTITY_LINK_TTL_MS, issueIdentityLinkAuthority, memberLinkState } from '../auth/identity-link.js';
import { listMembers, memberState, revokeMember } from '../auth/members-admin.js';
import { revokeCredentialAsMember } from '../auth/tokens.js';
import { credentialActivity, credentialMember, listCredentials } from '../read/credentials.js';
import { projectExists } from '../read/sessions.js';
import { emit } from '../telemetry.js';
import { badRequest, notFound, ok, readJsonObject } from './scope.js';
import { HARNESS_MEMBER_ID, MEMBER_ID, MINUTE_MS } from '../constants.js';
import { asMemberRole, forbiddenToMember, isAdmin } from '../auth/roles.js';
import { isProjectId } from '../pipeline.js';
import { paging } from './sessions.js';

/** The longest invitation the dashboard mints, in minutes: one day. */
export const MAX_INVITATION_MINUTES = 1440;

export async function handleMembers(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok({ members: await listMembers(env.db, ctx.now) });
}

/** `POST /api/members/{memberId}/revoke`: flat, attributed, and never the last linked member. */
export async function handleRevokeMember(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const result = await revokeMember(env.db, ctx.params.memberId, ctx.member.id, ctx.now);
  if (result.ok) return ok({ revoked: true, revokedBy: ctx.member.id });
  if (result.reason === 'absent') return notFound();
  return Response.json({ error: result.reason }, { status: 409 });
}

/**
 * `POST /api/members/{memberId}/link-github`: an admin creates a one-time key
 * that links a GitHub account to the member they name. The member opens it,
 * signs in with GitHub, and confirms; the admin's act authorises the link and
 * the member's sign-in proves the account. Answered once. The key binds only
 * while its issuer is still a live, linked admin, and creating one withdraws the
 * member's earlier unspent keys.
 */
export async function handleIssueMemberLink(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const memberId = ctx.params.memberId;
  if (memberId === HARNESS_MEMBER_ID) return Response.json({ error: 'member_is_runtime' }, { status: 409 });
  const state = await memberLinkState(env.db, memberId);
  if (state === 'absent') return notFound();
  if (state === 'revoked') return Response.json({ error: 'member_revoked' }, { status: 409 });
  if (state === 'linked') return Response.json({ error: 'member_linked' }, { status: 409 });
  const issued = await issueIdentityLinkAuthority(env.db, memberId, ctx.now, { issuedBy: ctx.member.id, ttlMs: ADMIN_IDENTITY_LINK_TTL_MS, replaceUnspent: true });
  if (issued === null) return forbiddenToMember();
  emit({ kind: 'identity_link_issued', memberId, issuedBy: ctx.member.id });
  return Response.json({ key: issued.key, expiresAt: issued.expiresAt }, { status: 201 });
}

export async function handleInvitations(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok({ invitations: await listInvitations(env.db, ctx.now) });
}

/**
 * `POST /api/enrollment {memberId?, ttlMinutes?, role?, projectId?}`: an
 * invitation for a new member, or for another runtime of an existing one. The
 * key is answered once.
 *
 * `role` defaults to `member` on this surface, which is the safe half of the
 * grammar: an admin who wants to mint another admin says so. `projectId` binds
 * the invitation to one Project, which a sandbox requires and a person does
 * not — an invitation without one admits a person to the Deployment, and a
 * sandbox presenting it is refused rather than bound to a guess.
 */
export async function handleMintInvitation(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  let memberId: string | null = null;
  if (body.memberId !== undefined) {
    if (typeof body.memberId !== 'string' || !MEMBER_ID.test(body.memberId)) return badRequest('memberId must match the member-id grammar');
    const state = await memberState(env.db, body.memberId);
    if (state === 'absent') return notFound();
    if (state === 'revoked') return Response.json({ error: 'member_revoked' }, { status: 409 });
    memberId = body.memberId;
  }
  let ttlMs = ENROLLMENT_TTL_MS;
  if (body.ttlMinutes !== undefined) {
    if (typeof body.ttlMinutes !== 'number' || !Number.isInteger(body.ttlMinutes) || body.ttlMinutes < 1 || body.ttlMinutes > MAX_INVITATION_MINUTES) {
      return badRequest(`ttlMinutes must be an integer from 1 to ${MAX_INVITATION_MINUTES}`);
    }
    ttlMs = body.ttlMinutes * MINUTE_MS;
  }
  const role = body.role === undefined ? 'member' : asMemberRole(body.role);
  if (role === null) return badRequest('role must be admin or member');

  let projectId: string | null = null;
  if (body.projectId !== undefined) {
    if (typeof body.projectId !== 'string' || !isProjectId(body.projectId)) return badRequest('projectId must match the project-id grammar');
    if (!(await projectExists(env.db, body.projectId))) return notFound();
    projectId = body.projectId;
  }

  const issued = await issueEnrollmentAuthority(env.db, ctx.now, { role, ttlMs, createdByMember: ctx.member.id, memberId, projectId });
  emit({ kind: 'invitation_issued', invitationId: issued.id, memberId, createdBy: ctx.member.id });
  return Response.json({ key: issued.key, id: issued.id, expiresAt: issued.expiresAt, role, projectId }, { status: 201 });
}

export async function handleRevokeInvitation(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const result = await revokeEnrollmentAuthority(env.db, ctx.params.id, ctx.now, ctx.member.id);
  if (result.revoked) emit({ kind: 'invitation_revoked', invitationId: ctx.params.id, actor: ctx.member.id });
  return ok({ revoked: result.revoked, revokedBy: ctx.member.id });
}

/**
 * The Deployment's credentials, paginated, optionally narrowed to one purpose: every one to an admin, and a
 * member's own to a member. `token_hash` is never selected, so there is nothing here to redact.
 */
export async function handleCredentials(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  const purpose = ctx.url.searchParams.get('purpose');
  if (purpose !== null && purpose !== 'run' && purpose !== 'member') return badRequest('purpose must be run or member');
  const own = isAdmin(ctx.member.role) ? {} : { memberId: ctx.member.id };
  return ok(await listCredentials(env.db, ctx.now, { ...page, ...(purpose === null ? {} : { purpose }), ...own }));
}

export async function handleRevokeCredential(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok(await revokeCredentialAsMember(env.db, ctx.member, ctx.params.id, ctx.now));
}

/** What one credential wrote, across every Project: any credential's to an admin, and only a member's own to a member. */
export async function handleCredentialActivity(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  if (!isAdmin(ctx.member.role) && (await credentialMember(env.db, ctx.params.id)) !== ctx.member.id) return notFound();
  return ok(await credentialActivity(env.db, ctx.params.id, page));
}

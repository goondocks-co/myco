import { authorizeDeclaration, deploymentIdentity, memberSubject, type AuthorizationDeclaration, type AuthorizationResource, type AuthorizationSubject } from './authorization.js';
import { heldRunOfCredential } from '../api/run-admission.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { projectExists } from '../read/sessions.js';
import type { ProtocolContext, ToolContext } from '../mcp/context.js';
import type { ToolInput } from '../mcp/validate.js';

/** Principal identity and liveness are resolved from the serving store. */
export async function toolSubject(ctx: ProtocolContext): Promise<AuthorizationSubject> {
  const { db } = ctx.env;
  const principal = ctx.principal;
  if (principal.kind === 'member') {
    const subject = await memberSubject(db, principal.memberId, 'mcp');
    const credential = await db.prepare(`SELECT id FROM member_credentials
      WHERE id = ? AND member_id = ? AND revoked_at IS NULL AND expires_at > ?`)
      .bind(principal.tokenId, principal.memberId, ctx.now).first<{ id: string }>();
    return { ...subject, tokenId: principal.tokenId, live: subject.live && credential !== null };
  }
  const deploymentId = await deploymentIdentity(db);
  if (principal.kind === 'grant') {
    const grant = await db.prepare(`SELECT project_id AS projectId FROM external_grants
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`)
      .bind(principal.grantId, ctx.now).first<{ projectId: string }>();
    return { kind: 'grant', transport: 'mcp', deploymentId, projectId: grant?.projectId, live: grant !== null && grant.projectId === ctx.projectId };
  }
  const held = await heldRunOfCredential(ctx.env, { memberId: HARNESS_MEMBER_ID, tokenId: principal.tokenId }, ctx.now);
  const credential = await db.prepare(`SELECT c.id FROM member_credentials c JOIN members m ON m.id = c.member_id
    WHERE c.id = ? AND c.member_id = ? AND c.revoked_at IS NULL AND c.expires_at > ? AND m.revoked_at IS NULL`)
    .bind(principal.tokenId, HARNESS_MEMBER_ID, ctx.now).first<{ id: string }>();
  const attempt = held === null ? undefined : held.resumedAt ?? held.startedAt ?? undefined;
  return {
    kind: 'run', transport: 'mcp', deploymentId, projectId: held?.projectId, runId: principal.runId,
    tokenId: principal.tokenId, attempt: principal.attempt,
    live: credential !== null && held !== null && held.id === principal.runId && held.projectId === ctx.projectId
      && principal.attempt !== undefined && principal.attempt === attempt,
  };
}

/** The declaration selects the collection, with run evidence carried on every run-scoped resource. */
export async function toolResource(ctx: ToolContext, declaration: AuthorizationDeclaration, subject: AuthorizationSubject): Promise<AuthorizationResource> {
  const deploymentId = await deploymentIdentity(ctx.env.db);
  const project = declaration.resolver === 'project' || declaration.resolver === 'run';
  const resource: AuthorizationResource = {
    kind: declaration.resource, deploymentId,
    exists: !project || await projectExists(ctx.env.db, ctx.projectId),
    ...(project ? { projectId: ctx.projectId } : {}),
  };
  if (ctx.principal.kind !== 'run') return resource;
  const held = await heldRunOfCredential(ctx.env, { memberId: HARNESS_MEMBER_ID, tokenId: ctx.principal.tokenId }, ctx.now);
  return {
    ...resource, runId: held?.id, tokenId: held?.dispatchedBy ?? undefined,
    attempt: held === null ? undefined : held.resumedAt ?? held.startedAt ?? undefined,
    exists: resource.exists && held !== null && held.projectId === ctx.projectId && held.id === subject.runId,
  };
}

export async function authorizeTool(ctx: ToolContext, declaration: AuthorizationDeclaration | undefined, input: ToolInput): Promise<boolean> {
  if (declaration === undefined) return false;
  const subject = await toolSubject(ctx);
  const resource = await toolResource(ctx, declaration, subject);
  return authorizeDeclaration(subject, declaration, input, resource);
}

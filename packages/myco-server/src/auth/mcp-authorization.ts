import { authorizeDeclaration, memberSubjectOf, type AuthorizationDeclaration, type AuthorizationResource, type AuthorizationSubject } from './authorization.js';
import { isLiveRun } from '../api/run-admission.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { readAuthorization, type AuthorizationQuery } from '../db/auth/authorization.js';
import type { ProtocolContext, ToolContext } from '../mcp/context.js';
import type { ToolInput } from '../mcp/validate.js';

export interface ToolAuthorization {
  subject: AuthorizationSubject;
  resourceFor(declaration: AuthorizationDeclaration): AuthorizationResource;
}

function toolQuery(ctx: ProtocolContext): AuthorizationQuery {
  const { principal, now, projectId } = ctx;
  const project = projectId === null ? {} : { project: projectId };
  if (principal.kind === 'member') return { ...project, subjectMember: principal.memberId, liveCredential: { tokenId: principal.tokenId, memberId: principal.memberId, now } };
  if (principal.kind === 'grant') return { ...project, grant: { id: principal.grantId, now } };
  return { ...project, heldRuns: principal.tokenId, liveCredential: { tokenId: principal.tokenId, memberId: HARNESS_MEMBER_ID, now } };
}

/** The principal's identity, liveness and resources, read once from the serving store for this one decision. */
export async function readToolAuthorization(ctx: ProtocolContext): Promise<ToolAuthorization> {
  const snapshot = await readAuthorization(ctx.env.db, toolQuery(ctx));
  const { principal, projectId, now } = ctx;
  const { deploymentId } = snapshot;
  const liveRuns = snapshot.heldRuns.filter((run) => isLiveRun(run, now));
  const held = liveRuns.length === 1 ? liveRuns[0]! : null;
  const heldAttempt = held === null ? undefined : held.resumedAt ?? held.startedAt ?? undefined;
  let subject: AuthorizationSubject;
  if (principal.kind === 'member') {
    subject = { ...memberSubjectOf(snapshot, principal.memberId, 'mcp'), tokenId: principal.tokenId };
    subject.live = subject.live && snapshot.credentialLive;
  } else if (principal.kind === 'grant') {
    subject = { kind: 'grant', transport: 'mcp', deploymentId, projectId: snapshot.grant?.projectId, live: snapshot.grant !== null && snapshot.grant.projectId === projectId };
  } else {
    subject = {
      kind: 'run', transport: 'mcp', deploymentId, projectId: held?.projectId, runId: principal.runId,
      tokenId: principal.tokenId, attempt: principal.attempt,
      live: snapshot.credentialLive && held !== null && held.id === principal.runId && held.projectId === projectId
        && principal.attempt !== undefined && principal.attempt === heldAttempt,
    };
  }
  return {
    subject,
    resourceFor(declaration) {
      const project = declaration.resolver === 'project' || declaration.resolver === 'run';
      const resource: AuthorizationResource = {
        kind: declaration.resource, deploymentId,
        exists: !project || snapshot.projectExists,
        ...(project && projectId !== null ? { projectId } : {}),
      };
      if (principal.kind !== 'run') return resource;
      return {
        ...resource, runId: held?.id, tokenId: held?.dispatchedBy ?? undefined,
        attempt: heldAttempt,
        exists: resource.exists && held !== null && held.projectId === projectId && held.id === subject.runId,
      };
    },
  };
}

export async function authorizeTool(ctx: ToolContext, declaration: AuthorizationDeclaration | undefined, input: ToolInput): Promise<boolean> {
  if (declaration === undefined) return false;
  const { subject, resourceFor } = await readToolAuthorization(ctx);
  return authorizeDeclaration(subject, declaration, input, resourceFor(declaration));
}

import type { ServerEnv } from '../core/adapters.js';
import { RawResourceReader } from '../core/raw-resources.js';
import { parseJsonObject } from '../api/scope.js';
import { MEMBER_ID } from '../constants.js';
import { authorize, authorizeDeclaration, credentialResourceOf, declaredAction, enrollmentResourceOf, machineResourcesOf, memberSubjectOf, type AuthorizationDeclaration, type AuthorizationResource, type AuthorizationSubject } from './authorization.js';
import { readAuthorization, type AuthorizationQuery, type AuthorizationSnapshot } from '../db/auth/authorization.js';

export function httpPolicy(resource: AuthorizationDeclaration['resource'], action: AuthorizationDeclaration['action'], resolver: AuthorizationDeclaration['resolver'], subjects: AuthorizationDeclaration['subjects'] = ['member']): AuthorizationDeclaration {
  return { resource, action, resolver, subjects, transport: 'http' };
}

export const RUN_CANCEL_POLICY = httpPolicy('run', 'cancel', 'run');

export const invitationAction: AuthorizationDeclaration['action'] = {
  actions: ['admin', 'owner'],
  resolve: (input, resource) => {
    if (input.role !== undefined && input.role !== 'member' && input.role !== 'admin') return null;
    if (resource?.grantedRole === 'admin' || resource?.grantedRole === 'owner' || input.role === 'admin') return 'owner';
    return input.memberId !== undefined && resource === undefined ? null : 'admin';
  },
};

export const memberRevocationAction: AuthorizationDeclaration['action'] = {
  actions: ['admin', 'owner'], resolve: (_input, resource) => resource === undefined ? null : resource.grantedRole === 'admin' || resource.grantedRole === 'owner' ? 'owner' : 'admin',
};

export const runDispatchAction: AuthorizationDeclaration['action'] = {
  actions: ['dispatch', 'admin'], resolve: input => input.fresh === true ? 'admin' : 'dispatch',
};

/** A member's identity, read with the resource in one snapshot; a subject that is not a member arrives resolved. */
export type HttpPrincipal = AuthorizationSubject | { memberId: string };
const isResolved = (principal: HttpPrincipal): principal is AuthorizationSubject => 'kind' in principal;

/** Credential collections apply the individual read policy before pagination. */
export async function credentialListScope(env: ServerEnv, principal: HttpPrincipal): Promise<{ memberId?: string; excludedMemberId?: string }> {
  const snapshot = await readAuthorization(env.db, { ...(isResolved(principal) ? {} : { subjectMember: principal.memberId }), ownership: true });
  const subject = isResolved(principal) ? principal : memberSubjectOf(snapshot, principal.memberId, 'http');
  const resource: AuthorizationResource = { kind: 'credential', deploymentId: snapshot.deploymentId, exists: true };
  if (!authorize(subject, 'read', { ...resource, ownerMemberId: subject.memberId })) throw new Error('Credential collection access refused');
  if (!authorize(subject, 'read', resource)) return { memberId: subject.memberId };
  const owner = snapshot.ownership?.memberId;
  return owner && !authorize(subject, 'read', { ...resource, protectedOwner: true, ownerMemberId: owner }) ? { excludedMemberId: owner } : {};
}

export interface HttpResourceInput {
  params?: Record<string, string>;
  projectId?: string;
  machineId?: string;
  tokenId?: string;
  body?: string;
  run?: { id: string; projectId: string; dispatchedBy: string | null; startedAt: number | null; resumedAt: number | null };
  rawKind?: 'blob' | 'event' | 'transcript';
}

const projectOf = (declaration: AuthorizationDeclaration, input: HttpResourceInput, parsed: Record<string, unknown>) =>
  input.params?.projectId ?? input.projectId ?? (declaration.resource === 'run' && typeof parsed.projectId === 'string' ? parsed.projectId : undefined);

const enrollmentTarget = (parsed: Record<string, unknown>): string | null =>
  typeof parsed.memberId === 'string' && MEMBER_ID.test(parsed.memberId) ? parsed.memberId : null;

/** Everything this declaration decides on, for the one read-set. */
function resourceQuery(declaration: AuthorizationDeclaration, principal: HttpPrincipal, input: HttpResourceInput, parsed: Record<string, unknown>): AuthorizationQuery {
  const params = input.params ?? {};
  const { memberId } = principal;
  const action = declaredAction(declaration, parsed);
  const projectId = projectOf(declaration, input, parsed);
  const { resolver, resource } = declaration;
  const query: AuthorizationQuery = isResolved(principal) ? {} : { subjectMember: principal.memberId };
  if (resolver === 'self-enrollment') return { ...query, targetMember: memberId ?? '' };
  if (resolver === 'enrollment') {
    const target = enrollmentTarget(parsed);
    return target === null ? query : { ...query, targetMember: target };
  }
  if (resolver === 'project' && projectId !== undefined && action !== 'capture' && action !== 'append') query.project = projectId;
  if (action === 'append' && resource === 'raw') query.uploader = input.tokenId ?? '';
  if (resolver === 'machine') query.machines = [params.machineId ?? input.machineId ?? ''];
  if (resolver === 'credential') query.credential = params.id ?? input.tokenId ?? '';
  if (resolver === 'member') {
    query.targetMember = params.memberId ?? memberId ?? '';
    if (action === 'bootstrap') query.linkedAdminPresent = true;
  }
  if (resolver === 'runner') query.runner = params.runnerId ?? (isResolved(principal) ? principal.runnerId : undefined) ?? '';
  if (resolver === 'deployment' && resource === 'member') query.ownership = true;
  if (resolver === 'run' && (!isResolved(principal) || principal.kind === 'member') && projectId !== undefined && params.runId !== undefined) query.run = { projectId, runId: params.runId };
  if (resolver === 'raw' && projectId !== undefined) query.project = projectId;
  return query;
}

/** The resource these facts describe; the raw reader alone consults the store again, for the upload a blob belongs to. */
async function resourceOf(env: ServerEnv, declaration: AuthorizationDeclaration, subject: AuthorizationSubject, input: HttpResourceInput, parsed: Record<string, unknown>, snapshot: AuthorizationSnapshot): Promise<AuthorizationResource> {
  const resource: AuthorizationResource = { kind: declaration.resource, deploymentId: snapshot.deploymentId, exists: true };
  const params = input.params ?? {};
  if (declaration.resolver === 'self-enrollment') return enrollmentResourceOf(snapshot, subject.memberId ?? '', 'member');
  if (declaration.resolver === 'enrollment') return enrollmentResourceOf(snapshot, enrollmentTarget(parsed), parsed.role === 'admin' ? 'admin' : 'member');
  const action = declaredAction(declaration, parsed);
  const projectId = projectOf(declaration, input, parsed);
  if (projectId !== undefined) resource.projectId = projectId;
  if (declaration.resolver === 'project' && projectId !== undefined) {
    // Capture admission precedes the additive Project registration operation.
    resource.exists = action === 'capture' || action === 'append' ? true : snapshot.projectExists;
  }
  if (declaration.resolver === 'project' && projectId === undefined) resource.exists = false;
  if (action === 'append' && declaration.resource === 'raw') resource.ownerMemberId = snapshot.uploaderMemberId ?? undefined;
  if (declaration.resolver === 'machine') {
    Object.assign(resource, machineResourcesOf(snapshot, declaration.resource as 'machine' | 'machine-settings' | 'credential', [params.machineId ?? input.machineId ?? ''])[0]!);
  }
  if (declaration.resolver === 'credential') Object.assign(resource, credentialResourceOf(snapshot, params.id ?? input.tokenId ?? ''));
  if (declaration.resolver === 'member') {
    const row = snapshot.targetMember;
    resource.exists = row !== null;
    resource.id = row?.id;
    resource.protectedOwner = row !== null && row.id === row.owner;
    resource.ownerPending = row !== null && row.owner === null;
    resource.ownerMemberId = row?.id;
    resource.grantedRole = row?.id === row?.owner ? 'owner' : row?.role === 'admin' ? 'admin' : 'member';
    if (action === 'bootstrap') resource.bootstrapAllowed = !snapshot.linkedAdminPresent;
  }
  if (declaration.resolver === 'runner') {
    resource.exists = snapshot.runnerId !== null;
    resource.id = snapshot.runnerId ?? undefined;
  }
  if (declaration.resolver === 'deployment' && resource.kind === 'member') {
    if (snapshot.ownership === null) throw new Error('Deployment ownership record is missing');
    resource.ownerPending = snapshot.ownership.memberId === null;
  }
  if (declaration.resolver === 'deployment' && (resource.kind === 'machine' || resource.kind === 'credential')) resource.ownerMemberId = subject.memberId;
  if (declaration.resolver === 'run') {
    if (subject.kind === 'member' && projectId !== undefined && params.runId !== undefined) {
      const row = snapshot.run;
      resource.exists = row !== null;
      resource.runId = row?.id;
      const specification = parseJsonObject(row?.dispatch_spec ?? '');
      resource.requestedBy = typeof specification?.actor === 'string' ? specification.actor : undefined;
    } else {
      resource.exists = input.run !== undefined;
      resource.projectId = input.run?.projectId;
      resource.runId = input.run?.id;
      resource.tokenId = input.run?.dispatchedBy ?? undefined;
      resource.attempt = input.run?.resumedAt ?? input.run?.startedAt ?? 0;
    }
  }
  if (declaration.resolver === 'raw') {
    resource.exists = projectId !== undefined && snapshot.projectExists;
    if (projectId !== undefined && input.rawKind === 'blob') {
      resource.uploader = await new RawResourceReader(env, { projectId }, { kind: 'member', memberId: subject.memberId ?? '' }).allows({ kind: 'blob', id: params.key ?? '' }, 'read');
    }
  }
  return resource;
}

export async function authorizeHttp(env: ServerEnv, declaration: AuthorizationDeclaration | undefined, principal: HttpPrincipal, input: HttpResourceInput): Promise<boolean> {
  return (await httpAuthorizationDecision(env, declaration, principal, input)).allowed;
}

export interface HttpAuthorizationDecision {
  allowed: boolean;
  subject?: AuthorizationSubject;
  resource?: AuthorizationResource;
  action?: ReturnType<typeof declaredAction>;
}

/** Decide a request from one snapshot of identity, subject and resource. Each write path asserts its own authority in its commit. */
export async function httpAuthorizationDecision(env: ServerEnv, declaration: AuthorizationDeclaration | undefined, principal: HttpPrincipal, input: HttpResourceInput): Promise<HttpAuthorizationDecision> {
  if (declaration === undefined) return { allowed: false };
  const body = parseJsonObject(input.body ?? '') ?? {};
  const snapshot = await readAuthorization(env.db, resourceQuery(declaration, principal, input, body));
  const subject = isResolved(principal) ? principal : memberSubjectOf(snapshot, principal.memberId, 'http');
  const resource = await resourceOf(env, declaration, subject, input, body, snapshot);
  return { allowed: authorizeDeclaration(subject, declaration, body, resource), subject, resource, action: declaredAction(declaration, body, resource) };
}

import type { ServerEnv } from '../core/adapters.js';
import { RawResourceReader } from '../core/raw-resources.js';
import { projectExists } from '../read/sessions.js';
import { parseJsonObject } from '../api/scope.js';
import { linkedAdmin } from './identity-link.js';
import { authorize, authorizeDeclaration, credentialResource, declaredAction, deploymentIdentity, machineResource, type AuthorizationDeclaration, type AuthorizationResource, type AuthorizationSubject } from './authorization.js';

export function httpPolicy(resource: AuthorizationDeclaration['resource'], action: AuthorizationDeclaration['action'], resolver: AuthorizationDeclaration['resolver'], subjects: AuthorizationDeclaration['subjects'] = ['member']): AuthorizationDeclaration {
  return { resource, action, resolver, subjects, transport: 'http' };
}

export const invitationAction: AuthorizationDeclaration['action'] = {
  actions: ['admin', 'owner'],
  resolve: input => input.role === 'admin' ? 'owner' : input.role === undefined || input.role === 'member' ? 'admin' : null,
};

export const runDispatchAction: AuthorizationDeclaration['action'] = {
  actions: ['dispatch', 'admin'], resolve: input => input.fresh === true ? 'admin' : 'dispatch',
};

/** Credential collections apply the individual read policy before pagination. */
export async function credentialListScope(env: ServerEnv, subject: AuthorizationSubject): Promise<{ memberId?: string; excludedMemberId?: string }> {
  const resource: AuthorizationResource = { kind: 'credential', deploymentId: await deploymentIdentity(env.db), exists: true };
  if (!authorize(subject, 'read', { ...resource, ownerMemberId: subject.memberId })) throw new Error('Credential collection access refused');
  if (!authorize(subject, 'read', resource)) return { memberId: subject.memberId };
  const owner = await env.db.prepare('SELECT member_id FROM deployment_ownership WHERE id = 1').first<{ member_id: string | null }>();
  return owner?.member_id && !authorize(subject, 'read', { ...resource, protectedOwner: true, ownerMemberId: owner.member_id })
    ? { excludedMemberId: owner.member_id } : {};
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

/** Resource resolvers read the serving store before any operation is invoked. */
export async function resolveHttpResource(env: ServerEnv, declaration: AuthorizationDeclaration, subject: AuthorizationSubject, input: HttpResourceInput): Promise<AuthorizationResource> {
  const resource: AuthorizationResource = { kind: declaration.resource, deploymentId: await deploymentIdentity(env.db), exists: true };
  const params = input.params ?? {};
  const parsed = parseJsonObject(input.body ?? '') ?? {};
  const action = declaredAction(declaration, parsed);
  const projectId = params.projectId ?? input.projectId ?? (declaration.resource === 'run' && typeof parsed.projectId === 'string' ? parsed.projectId : undefined);
  if (projectId !== undefined) resource.projectId = projectId;
  if (declaration.resolver === 'project' && projectId !== undefined) {
    resource.exists = await projectExists(env.db, projectId);
    // Capture admission precedes the additive Project registration operation.
    if (action === 'capture' || action === 'append') resource.exists = true;
  }
  if (declaration.resolver === 'project' && projectId === undefined) resource.exists = false;
  if (action === 'append' && declaration.resource === 'raw') {
    const uploader = await env.db.prepare('SELECT member_id FROM member_credentials WHERE id = ?').bind(input.tokenId ?? '').first<{ member_id: string }>();
    resource.ownerMemberId = uploader?.member_id;
  }
  if (declaration.resolver === 'machine') {
    const machineId = params.machineId ?? input.machineId;
    Object.assign(resource, await machineResource(env.db, declaration.resource as 'machine' | 'machine-settings' | 'credential', machineId ?? ''));
  }
  if (declaration.resolver === 'credential') {
    const id = params.id ?? input.tokenId;
    Object.assign(resource, await credentialResource(env.db, id ?? ''));
  }
  if (declaration.resolver === 'member') {
    const id = params.memberId ?? subject.memberId;
    const row = await env.db.prepare('SELECT m.id, o.member_id AS owner FROM members m LEFT JOIN deployment_ownership o ON o.id = 1 WHERE m.id = ?').bind(id ?? '').first<{ id: string; owner: string | null }>();
    resource.exists = row !== null;
    resource.id = row?.id;
    resource.protectedOwner = row !== null && row.id === row.owner;
    resource.ownerMemberId = row?.id;
    if (action === 'bootstrap') {
      const linked = await env.db.prepare(`SELECT 1 FROM members la WHERE ${linkedAdmin('la')} LIMIT 1`).first();
      resource.bootstrapAllowed = linked === null;
    }
  }
  if (declaration.resolver === 'deployment' && (resource.kind === 'machine' || resource.kind === 'credential')) resource.ownerMemberId = subject.memberId;
  if (declaration.resolver === 'run') {
    if (subject.kind === 'member' && projectId !== undefined && params.runId !== undefined) {
      const row = await env.db.prepare('SELECT id, dispatch_spec FROM agent_runs WHERE project_id = ? AND id = ?')
        .bind(projectId, params.runId).first<{ id: string; dispatch_spec: string | null }>();
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
    resource.exists = projectId !== undefined && await projectExists(env.db, projectId);
    if (projectId !== undefined && input.rawKind === 'blob') {
      resource.uploader = await new RawResourceReader(env, { projectId }, { kind: 'member', memberId: subject.memberId ?? '' }).allows({ kind: 'blob', id: params.key ?? '' }, 'read');
    }
  }
  return resource;
}

export async function authorizeHttp(env: ServerEnv, declaration: AuthorizationDeclaration | undefined, subject: AuthorizationSubject, input: HttpResourceInput): Promise<boolean> {
  return (await httpAuthorizationDecision(env, declaration, subject, input)).allowed;
}

export async function httpAuthorizationDecision(env: ServerEnv, declaration: AuthorizationDeclaration | undefined, subject: AuthorizationSubject, input: HttpResourceInput): Promise<{ allowed: boolean; resource?: AuthorizationResource; action?: ReturnType<typeof declaredAction> }> {
  if (declaration === undefined) return { allowed: false };
  const resource = await resolveHttpResource(env, declaration, subject, input);
  const body = parseJsonObject(input.body ?? '') ?? {};
  return { allowed: authorizeDeclaration(subject, declaration, body, resource), resource, action: declaredAction(declaration, body) };
}

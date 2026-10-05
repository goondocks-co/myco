import type { ServerEnv } from '../core/adapters.js';
import { RawResourceReader } from '../core/raw-resources.js';
import { projectExists } from '../read/sessions.js';
import { parseJsonObject } from '../api/scope.js';
import { authorizeDeclaration, declaredAction, deploymentIdentity, type AuthorizationDeclaration, type AuthorizationResource, type AuthorizationSubject } from './authorization.js';

export function httpPolicy(resource: AuthorizationDeclaration['resource'], action: AuthorizationDeclaration['action'], resolver: AuthorizationDeclaration['resolver'], subjects: AuthorizationDeclaration['subjects'] = ['member']): AuthorizationDeclaration {
  return { resource, action, resolver, subjects, transport: 'http' };
}

export const invitationAction: AuthorizationDeclaration['action'] = {
  actions: ['admin', 'owner'],
  resolve: input => input.role === 'admin' ? 'owner' : 'admin',
};

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
  const projectId = params.projectId ?? input.projectId;
  if (projectId !== undefined) resource.projectId = projectId;
  const parsed = parseJsonObject(input.body ?? '') ?? {};
  const action = declaredAction(declaration, parsed);
  if (declaration.resolver === 'project' && projectId !== undefined) {
    resource.exists = await projectExists(env.db, projectId);
    // Capture admission precedes the additive Project registration operation.
    if (action === 'capture') resource.exists = true;
  }
  if (declaration.resolver === 'machine') {
    const machineId = params.machineId ?? input.machineId;
    const claim = await env.db.prepare('SELECT member_id FROM machine_claims WHERE machine_id = ?').bind(machineId ?? '').first<{ member_id: string }>();
    resource.exists = claim !== null;
    resource.id = machineId;
    resource.ownerMemberId = claim?.member_id;
    resource.claimantMemberId = claim?.member_id;
  }
  if (declaration.resolver === 'credential') {
    const id = params.id ?? input.tokenId;
    const row = await env.db.prepare('SELECT c.member_id, o.member_id AS owner FROM member_credentials c LEFT JOIN deployment_ownership o ON o.id = 1 WHERE c.id = ?').bind(id ?? '').first<{ member_id: string; owner: string | null }>();
    resource.exists = row !== null;
    resource.id = id;
    resource.ownerMemberId = row?.member_id;
    resource.protectedOwner = row !== null && row.member_id === row.owner;
  }
  if (declaration.resolver === 'member') {
    const id = params.memberId;
    const row = await env.db.prepare('SELECT m.id, o.member_id AS owner FROM members m LEFT JOIN deployment_ownership o ON o.id = 1 WHERE m.id = ?').bind(id ?? '').first<{ id: string; owner: string | null }>();
    resource.exists = row !== null;
    resource.id = row?.id;
    resource.protectedOwner = row !== null && row.id === row.owner;
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
  if (declaration === undefined) return false;
  const resource = await resolveHttpResource(env, declaration, subject, input);
  return authorizeDeclaration(subject, declaration, parseJsonObject(input.body ?? '') ?? {}, resource);
}

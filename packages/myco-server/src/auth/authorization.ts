import type { RelationalStore } from '../core/adapters.js';

export const SUBJECT_KINDS = ['public', 'account', 'enrollment', 'member', 'run', 'grant', 'internal'] as const;
export type SubjectKind = typeof SUBJECT_KINDS[number];
export const ACTIONS = ['read', 'enumerate', 'append', 'bootstrap', 'edit', 'status', 'admin', 'owner', 'claimant.read', 'claimant.edit', 'cancel', 'execute', 'capture', 'dispatch', 'create', 'protocol', 'never'] as const;
export type Action = typeof ACTIONS[number];
export const RESOURCE_KINDS = ['protocol', 'settings', 'secret', 'directory', 'member', 'credential', 'machine', 'machine-settings', 'project', 'processed', 'plan', 'spore', 'raw', 'raw-index', 'run', 'grant', 'enrollment', 'backup'] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];
export type Transport = 'http' | 'mcp';

export interface AuthorizationSubject {
  kind: SubjectKind;
  deploymentId: string;
  transport: Transport;
  live: boolean;
  memberId?: string;
  role?: 'owner' | 'admin' | 'member';
  projectId?: string;
  runId?: string;
  tokenId?: string;
  attempt?: number;
}

export interface AuthorizationResource {
  kind: ResourceKind;
  deploymentId: string;
  exists: boolean;
  id?: string;
  projectId?: string;
  ownerMemberId?: string;
  claimantMemberId?: string;
  requestedBy?: string;
  runId?: string;
  tokenId?: string;
  attempt?: number;
  uploader?: boolean;
  protectedOwner?: boolean;
  bootstrapAllowed?: boolean;
}

export interface AuthorizationDeclaration {
  subjects: readonly SubjectKind[];
  transport: Transport;
  resource: ResourceKind;
  resolver: 'deployment' | 'project' | 'machine' | 'credential' | 'member' | 'run' | 'raw' | 'protocol';
  action: Action | { actions: readonly Action[]; resolve(input: Record<string, unknown>): Action | null };
}

export const RESOURCE_RESOLVERS: Readonly<Record<ResourceKind, readonly AuthorizationDeclaration['resolver'][]>> = {
  protocol: ['protocol'], settings: ['deployment', 'project'], secret: ['deployment', 'project'],
  directory: ['deployment'], member: ['member', 'deployment'], credential: ['credential', 'deployment'],
  machine: ['machine', 'deployment'], 'machine-settings': ['machine'], project: ['project', 'deployment'],
  processed: ['project', 'deployment'], plan: ['project', 'deployment'], spore: ['project', 'deployment'],
  raw: ['raw', 'project', 'deployment'], 'raw-index': ['raw'], run: ['run', 'project', 'deployment'], grant: ['project'], enrollment: ['deployment'], backup: ['deployment'],
};

export const RESOURCE_ACTIONS: Readonly<Record<ResourceKind, readonly Action[]>> = {
  protocol: ['protocol', 'never'], settings: ['read', 'admin'], secret: ['admin'],
  directory: ['read'], member: ['read', 'admin', 'owner', 'bootstrap'], credential: ['read', 'edit', 'admin'],
  machine: ['read', 'edit', 'capture'], 'machine-settings': ['claimant.read', 'claimant.edit', 'capture'],
  project: ['read', 'create', 'admin'], processed: ['read', 'admin', 'capture'],
  plan: ['read', 'edit', 'status', 'capture'], spore: ['read', 'edit'], raw: ['read', 'enumerate', 'append', 'owner'], 'raw-index': ['enumerate'],
  run: ['read', 'dispatch', 'admin', 'cancel', 'execute'], grant: ['admin'], enrollment: ['protocol', 'admin', 'owner'], backup: ['admin'],
};

/** The policy receives only identities and resource evidence resolved by the serving store. */
export function authorize(subject: AuthorizationSubject, action: Action, resource: AuthorizationResource): boolean {
  if (subject.live !== true || resource.exists !== true || !subject.deploymentId || subject.deploymentId !== resource.deploymentId) return false;
  if (!SUBJECT_KINDS.includes(subject.kind) || !RESOURCE_ACTIONS[resource.kind]?.includes(action)) return false;
  if (subject.transport !== 'http' && subject.transport !== 'mcp') return false;
  if (action === 'never') return false;
  if (resource.kind === 'protocol') return action === 'protocol' && subject.kind !== 'internal';
  if (subject.kind === 'public' || subject.kind === 'account' || subject.kind === 'enrollment') return false;
  if (subject.kind === 'internal') return false;
  if (subject.kind === 'run' || subject.kind === 'grant') {
    if (!subject.projectId || subject.projectId !== resource.projectId || resource.kind === 'raw') return false;
    if (subject.kind === 'run') {
      if (!subject.runId || !subject.tokenId || subject.attempt === undefined || subject.runId !== resource.runId
        || subject.tokenId !== resource.tokenId || subject.attempt !== resource.attempt) return false;
      return (['processed', 'project', 'plan', 'spore', 'run'] as ResourceKind[]).includes(resource.kind)
        && (action === 'read' || ((resource.kind === 'plan' || resource.kind === 'spore') && action === 'edit') || (resource.kind === 'run' && action === 'execute'));
    }
    return (['processed', 'project', 'plan', 'spore'] as ResourceKind[]).includes(resource.kind)
      && (action === 'read' || (resource.kind === 'spore' && action === 'edit'));
  }
  if (!subject.memberId || !subject.role || !['owner', 'admin', 'member'].includes(subject.role)) return false;
  const admin = subject.role === 'owner' || subject.role === 'admin';
  if (action === 'owner') return subject.transport === 'http' && subject.role === 'owner';
  if (action === 'bootstrap') return subject.transport === 'http' && admin && resource.bootstrapAllowed === true && resource.ownerMemberId === subject.memberId;
  if (action === 'admin') return subject.transport === 'http' && admin && (resource.protectedOwner !== true || subject.role === 'owner');
  if (action === 'claimant.read' || action === 'claimant.edit') return resource.claimantMemberId === subject.memberId;
  if (resource.kind === 'raw-index') return action === 'enumerate';
  if (resource.kind === 'raw') return action === 'append' ? subject.transport === 'http' && resource.ownerMemberId === subject.memberId : (action === 'read' || action === 'enumerate') && resource.uploader === true;
  if (resource.kind === 'run') {
    if (action === 'execute') return false;
    if (action === 'cancel') return subject.transport === 'http' && (admin || resource.requestedBy === subject.memberId);
    if (action === 'dispatch') return subject.transport === 'http';
    return action === 'read';
  }
  if (resource.kind === 'credential' || resource.kind === 'machine') {
    if (action === 'capture') return resource.claimantMemberId === subject.memberId;
    if (resource.protectedOwner === true && subject.role !== 'owner' && resource.ownerMemberId !== subject.memberId) return false;
    return admin || resource.ownerMemberId === subject.memberId;
  }
  if (action === 'capture') return resource.kind === 'machine-settings' ? resource.claimantMemberId === subject.memberId : ['processed', 'plan'].includes(resource.kind);
  if (action === 'create') return resource.kind === 'project' && subject.transport === 'http';
  if (action === 'edit' || action === 'status') return resource.kind === 'plan' || resource.kind === 'spore';
  return action === 'read';
}

export function declaredAction(declaration: AuthorizationDeclaration, input: Record<string, unknown>): Action | null {
  if (typeof declaration.action === 'string') return ACTIONS.includes(declaration.action) ? declaration.action : null;
  const action = declaration.action.resolve(input);
  return action !== null && declaration.action.actions.includes(action) && ACTIONS.includes(action) ? action : null;
}

export function authorizeDeclaration(subject: AuthorizationSubject, declaration: AuthorizationDeclaration | undefined, input: Record<string, unknown>, resource: AuthorizationResource): boolean {
  if (declaration === undefined || declaration.transport !== subject.transport || !declaration.subjects.includes(subject.kind)
    || declaration.resource !== resource.kind || !RESOURCE_RESOLVERS[declaration.resource]?.includes(declaration.resolver)) return false;
  const action = declaredAction(declaration, input);
  return action !== null && authorize(subject, action, resource);
}

export async function deploymentIdentity(db: RelationalStore): Promise<string> {
  const row = await db.prepare("SELECT value FROM schema_meta WHERE key = 'deployment_id'").first<{ value: string }>();
  if (!row?.value) throw new Error('Deployment identity is missing');
  return row.value;
}

export async function memberSubject(db: RelationalStore, memberId: string, transport: Transport): Promise<AuthorizationSubject> {
  const deploymentId = await deploymentIdentity(db);
  const row = await db.prepare(`SELECT m.role, m.revoked_at, o.member_id AS owner FROM members m
    LEFT JOIN deployment_ownership o ON o.id = 1 WHERE m.id = ?`).bind(memberId)
    .first<{ role: string; revoked_at: number | null; owner: string | null }>();
  const role = row?.owner === memberId ? 'owner' : row?.role === 'admin' ? 'admin' : row?.role === 'member' ? 'member' : undefined;
  return { kind: 'member', deploymentId, transport, memberId, live: row !== null && row.revoked_at === null && role !== undefined, role };
}

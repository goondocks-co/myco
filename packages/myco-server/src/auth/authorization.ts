import type { RelationalStore } from '../core/adapters.js';
import { MEMBER_ROLES_SQL } from './roles.js';

export const SUBJECT_KINDS = ['public', 'account', 'enrollment', 'member', 'run', 'grant', 'runner', 'runner-registration', 'internal'] as const;
export type SubjectKind = typeof SUBJECT_KINDS[number];
export const ACTIONS = ['read', 'enumerate', 'append', 'bootstrap', 'edit', 'status', 'admin', 'owner', 'enroll.self', 'claimant.read', 'claimant.edit', 'cancel', 'execute', 'capture', 'dispatch', 'create', 'protocol', 'claim', 'lease', 'never'] as const;
export type Action = typeof ACTIONS[number];
export const RESOURCE_KINDS = ['protocol', 'settings', 'secret', 'directory', 'member', 'credential', 'machine', 'machine-settings', 'project', 'processed', 'plan', 'spore', 'raw', 'raw-index', 'run', 'grant', 'enrollment', 'backup', 'queue', 'runner', 'legacy-worker'] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];
export type Transport = 'http' | 'mcp';

/** Owner control credentials are mutable only by that owner at the SQL write. */
export const OWNER_CONTROL_CREDENTIAL_WRITE = `NOT EXISTS (SELECT 1 FROM deployment_ownership o
  WHERE o.id = 1 AND o.member_id = member_credentials.member_id AND o.member_id <> ?)`;

/** A live member edits their own resources; current administrators may edit another member's resources. */
export function memberWritePredicate(actor: string, ownedBy: string): string {
  return `EXISTS (SELECT 1 FROM members write_actor WHERE write_actor.id = ${actor}
    AND write_actor.revoked_at IS NULL AND write_actor.role IN ('admin', 'member')
    AND (write_actor.role = 'admin' OR write_actor.id = ${ownedBy}
      OR EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = write_actor.id)))`;
}

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
  /** The runner a runner credential belongs to, resolved by the serving store. */
  runnerId?: string;
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
  ownerPending?: boolean;
  bootstrapAllowed?: boolean;
  grantedRole?: 'owner' | 'admin' | 'member';
  targetRevoked?: boolean;
}

export interface AuthorizationDeclaration {
  subjects: readonly SubjectKind[];
  transport: Transport;
  resource: ResourceKind;
  resolver: 'deployment' | 'project' | 'machine' | 'credential' | 'member' | 'run' | 'raw' | 'protocol' | 'enrollment' | 'self-enrollment' | 'runner';
  action: Action | { actions: readonly Action[]; resolve(input: Record<string, unknown>, resource?: AuthorizationResource): Action | null };
}

export const RESOURCE_RESOLVERS: Readonly<Record<ResourceKind, readonly AuthorizationDeclaration['resolver'][]>> = {
  protocol: ['protocol'], settings: ['deployment', 'project'], secret: ['deployment', 'project'],
  directory: ['deployment'], member: ['member', 'deployment'], credential: ['credential', 'deployment', 'machine'],
  machine: ['machine', 'deployment'], 'machine-settings': ['machine'], project: ['project', 'deployment'],
  processed: ['project', 'deployment'], plan: ['project', 'deployment'], spore: ['project', 'deployment'],
  raw: ['raw', 'project', 'deployment'], 'raw-index': ['raw'], run: ['run', 'project', 'deployment'], grant: ['project'], enrollment: ['deployment', 'enrollment', 'self-enrollment'], backup: ['deployment'],
  queue: ['deployment'], runner: ['runner', 'deployment'], 'legacy-worker': ['deployment'],
};

export const RESOURCE_ACTIONS: Readonly<Record<ResourceKind, readonly Action[]>> = {
  protocol: ['protocol', 'never'], settings: ['read', 'admin'], secret: ['admin'],
  directory: ['read'], member: ['read', 'admin', 'owner', 'bootstrap'], credential: ['read', 'edit', 'admin'],
  machine: ['read', 'edit', 'capture'], 'machine-settings': ['claimant.read', 'claimant.edit', 'capture'],
  project: ['read', 'create', 'admin'], processed: ['read', 'admin', 'capture'],
  plan: ['read', 'edit', 'status', 'capture'], spore: ['read', 'edit'], raw: ['read', 'enumerate', 'append', 'owner'], 'raw-index': ['enumerate'],
  run: ['read', 'dispatch', 'admin', 'cancel', 'execute'], grant: ['admin'], enrollment: ['protocol', 'admin', 'owner', 'enroll.self'], backup: ['admin'],
  queue: ['claim', 'lease'], runner: ['read', 'edit', 'admin'], 'legacy-worker': ['read'],
};

/** The policy receives only identities and resource evidence resolved by the serving store. */
export function authorize(subject: AuthorizationSubject, action: Action, resource: AuthorizationResource): boolean {
  if (subject.live !== true || resource.exists !== true || !subject.deploymentId || subject.deploymentId !== resource.deploymentId) return false;
  if (!SUBJECT_KINDS.includes(subject.kind) || !RESOURCE_ACTIONS[resource.kind]?.includes(action)) return false;
  if (subject.transport !== 'http' && subject.transport !== 'mcp') return false;
  if (action === 'never') return false;
  if (resource.kind === 'protocol') return action === 'protocol' && subject.kind !== 'internal';
  if (subject.kind === 'public' || subject.kind === 'account' || subject.kind === 'enrollment' || subject.kind === 'runner-registration') return false;
  if (subject.kind === 'internal') return false;
  if (subject.kind === 'runner') {
    if (subject.transport !== 'http' || !subject.runnerId) return false;
    if (resource.kind === 'queue') return action === 'claim' || action === 'lease';
    return resource.kind === 'runner' && (action === 'read' || action === 'edit') && resource.id === subject.runnerId;
  }
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
  if (resource.kind === 'legacy-worker') return subject.transport === 'http' && admin && action === 'read';
  if (resource.kind === 'queue') return subject.transport === 'http' && admin;
  if (resource.kind === 'runner') return subject.transport === 'http' && (action === 'read' || (action === 'admin' && admin));
  if (action === 'enroll.self') return subject.transport === 'http' && resource.kind === 'enrollment'
    && resource.ownerMemberId === subject.memberId && resource.grantedRole !== undefined
    && (subject.role === 'owner' || resource.grantedRole === 'member' || resource.grantedRole === subject.role);
  if (resource.kind === 'enrollment' && (resource.grantedRole === 'owner' || resource.grantedRole === 'admin') && subject.role !== 'owner') return false;
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
    if (resource.kind === 'credential' && resource.protectedOwner === true && subject.role !== 'owner' && resource.ownerMemberId !== subject.memberId) return false;
    return admin || resource.ownerMemberId === subject.memberId;
  }
  if (action === 'capture') return resource.kind === 'machine-settings' ? resource.claimantMemberId === subject.memberId : ['processed', 'plan'].includes(resource.kind);
  if (action === 'create') return resource.kind === 'project' && subject.transport === 'http';
  if (action === 'edit' || action === 'status') return resource.kind === 'plan' || resource.kind === 'spore';
  return action === 'read';
}

export function declaredAction(declaration: AuthorizationDeclaration, input: Record<string, unknown>, resource?: AuthorizationResource): Action | null {
  if (typeof declaration.action === 'string') return ACTIONS.includes(declaration.action) ? declaration.action : null;
  const action = declaration.action.resolve(input, resource);
  return action !== null && declaration.action.actions.includes(action) && ACTIONS.includes(action) ? action : null;
}

export function authorizeDeclaration(subject: AuthorizationSubject, declaration: AuthorizationDeclaration | undefined, input: Record<string, unknown>, resource: AuthorizationResource): boolean {
  if (declaration === undefined || declaration.transport !== subject.transport || !declaration.subjects.includes(subject.kind)
    || declaration.resource !== resource.kind || !RESOURCE_RESOLVERS[declaration.resource]?.includes(declaration.resolver)) return false;
  const action = declaredAction(declaration, input, resource);
  return action !== null && authorize(subject, action, resource);
}

export async function deploymentIdentity(db: RelationalStore): Promise<string> {
  const row = await db.prepare("SELECT value FROM schema_meta WHERE key = 'deployment_id'").first<{ value: string }>();
  if (!row?.value) throw new Error('Deployment identity is missing');
  return row.value;
}

/** An existing recipient keeps its role; the ownership singleton determines owner authority. */
export async function enrollmentResource(db: RelationalStore, memberId: string | null, role: 'admin' | 'member'): Promise<AuthorizationResource> {
  const resource: AuthorizationResource = { kind: 'enrollment', deploymentId: await deploymentIdentity(db), exists: true, grantedRole: role };
  if (memberId === null) return resource;
  const row = await db.prepare(`SELECT m.role, m.revoked_at, o.member_id AS owner FROM members m
    LEFT JOIN deployment_ownership o ON o.id = 1 WHERE m.id = ?`).bind(memberId)
    .first<{ role: string; revoked_at: number | null; owner: string | null }>();
  resource.exists = row !== null && row.revoked_at === null && (row.role === 'admin' || row.role === 'member');
  resource.targetRevoked = row !== null && row.revoked_at !== null;
  resource.ownerMemberId = memberId;
  resource.grantedRole = row?.owner === memberId ? 'owner' : row?.role === 'admin' ? 'admin' : row?.role === 'member' ? 'member' : undefined;
  return resource;
}

/** Every enrollment write resolves issuer, recipient and ownership authority at SQL execution. Null issuer denotes operator issuance. */
export function enrollmentAuthorityPredicate(alias: string): string {
  return `${alias}.role IN (${MEMBER_ROLES_SQL})
    AND (${alias}.member_id IS NULL OR EXISTS (SELECT 1 FROM members recipient
      WHERE recipient.id = ${alias}.member_id AND recipient.revoked_at IS NULL AND recipient.role IN (${MEMBER_ROLES_SQL})))
    AND (${alias}.created_by_member IS NULL OR EXISTS (SELECT 1 FROM members issuer
      WHERE issuer.id = ${alias}.created_by_member AND issuer.revoked_at IS NULL AND issuer.role IN (${MEMBER_ROLES_SQL})
        AND (issuer.role = 'admin' OR (${alias}.member_id = issuer.id AND EXISTS (SELECT 1 FROM device_requests device WHERE device.id = ${alias}.id))
          OR EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = issuer.id))
        AND (EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = issuer.id)
          OR (${alias}.member_id = issuer.id AND (${alias}.role = 'member' OR ${alias}.role = issuer.role)
            AND EXISTS (SELECT 1 FROM device_requests device WHERE device.id = ${alias}.id))
          OR (${alias}.role = 'member' AND NOT EXISTS (SELECT 1 FROM members recipient
            LEFT JOIN deployment_ownership o ON o.id = 1 WHERE recipient.id = ${alias}.member_id
              AND (recipient.role = 'admin' OR recipient.id = o.member_id))))))`;
}

/** Machine claims and owner protection share one resource resolver across single and paged reads. */
export async function machineResources(db: RelationalStore, kind: 'machine' | 'machine-settings' | 'credential', machineIds: string[]): Promise<AuthorizationResource[]> {
  const deploymentId = await deploymentIdentity(db);
  const { results } = await db.prepare('SELECT mc.machine_id, mc.member_id, o.member_id AS owner FROM machine_claims mc LEFT JOIN deployment_ownership o ON o.id = 1 WHERE mc.machine_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(machineIds)).all<{ machine_id: string; member_id: string; owner: string | null }>();
  const claims = new Map(results.map((row) => [row.machine_id, row]));
  return machineIds.map((id) => {
    const row = claims.get(id);
    return { kind, deploymentId, exists: row !== undefined, id, ownerMemberId: row?.member_id, claimantMemberId: row?.member_id,
      protectedOwner: row !== undefined && row.member_id === row.owner };
  });
}

export async function machineResource(db: RelationalStore, kind: 'machine' | 'machine-settings' | 'credential', machineId: string): Promise<AuthorizationResource> {
  return (await machineResources(db, kind, [machineId]))[0]!;
}

/** A credential's recorded member and current owner protection. */
export async function credentialResource(db: RelationalStore, tokenId: string): Promise<AuthorizationResource> {
  const row = await db.prepare('SELECT c.member_id, o.member_id AS owner FROM member_credentials c LEFT JOIN deployment_ownership o ON o.id = 1 WHERE c.id = ?')
    .bind(tokenId).first<{ member_id: string; owner: string | null }>();
  return { kind: 'credential', deploymentId: await deploymentIdentity(db), exists: row !== null, id: tokenId,
    ownerMemberId: row?.member_id, protectedOwner: row !== null && row.member_id === row.owner };
}

export async function memberSubject(db: RelationalStore, memberId: string, transport: Transport): Promise<AuthorizationSubject> {
  const deploymentId = await deploymentIdentity(db);
  const row = await db.prepare(`SELECT m.role, m.revoked_at, o.member_id AS owner FROM members m
    LEFT JOIN deployment_ownership o ON o.id = 1 WHERE m.id = ?`).bind(memberId)
    .first<{ role: string; revoked_at: number | null; owner: string | null }>();
  const role = row?.owner === memberId ? 'owner' : row?.role === 'admin' ? 'admin' : row?.role === 'member' ? 'member' : undefined;
  return { kind: 'member', deploymentId, transport, memberId, live: row !== null && row.revoked_at === null && role !== undefined, role };
}

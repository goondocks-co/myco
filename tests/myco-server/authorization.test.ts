import { describe, expect, it } from 'bun:test';
import {
  ACTIONS, RESOURCE_KINDS, SUBJECT_KINDS, authorize, authorizeDeclaration, declaredAction, memberSubject,
  type Action, type AuthorizationDeclaration, type AuthorizationResource, type AuthorizationSubject,
  type ResourceKind, type Transport,
} from '@myco-server-worker/auth/authorization.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { TOOL_REGISTRY } from '@myco-server-worker/mcp/registry.js';
import { authorizeHttp, credentialListScope, resolveHttpResource } from '@myco-server-worker/auth/http-authorization.js';
import { listCredentials } from '@myco-server-worker/read/credentials.js';
import { bootstrapOwnership } from '@myco-server-worker/core/raw-claims.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteEnv } from './helpers/fixtures.js';

const DEPLOYMENT = 'deployment-a';
const MEMBER = 'member-a';
const SUBJECTS: Readonly<Record<string, AuthorizationSubject>> = {
  owner: { kind: 'member', role: 'owner', memberId: MEMBER, deploymentId: DEPLOYMENT, transport: 'http', live: true },
  admin: { kind: 'member', role: 'admin', memberId: MEMBER, deploymentId: DEPLOYMENT, transport: 'http', live: true },
  member: { kind: 'member', role: 'member', memberId: MEMBER, deploymentId: DEPLOYMENT, transport: 'http', live: true },
  run: { kind: 'run', deploymentId: DEPLOYMENT, transport: 'http', live: true, projectId: 'project-a', runId: 'run-a', tokenId: 'credential-a', attempt: 2 },
  grant: { kind: 'grant', deploymentId: DEPLOYMENT, transport: 'http', live: true, projectId: 'project-a' },
  public: { kind: 'public', deploymentId: DEPLOYMENT, transport: 'http', live: true },
  account: { kind: 'account', deploymentId: DEPLOYMENT, transport: 'http', live: true },
  enrollment: { kind: 'enrollment', deploymentId: DEPLOYMENT, transport: 'http', live: true },
  internal: { kind: 'internal', deploymentId: DEPLOYMENT, transport: 'http', live: true },
};

const resource = (kind: ResourceKind): AuthorizationResource => ({
  kind, deploymentId: DEPLOYMENT, exists: true, projectId: 'project-a', ownerMemberId: MEMBER,
  claimantMemberId: MEMBER, requestedBy: MEMBER, uploader: true, bootstrapAllowed: true,
  runId: 'run-a', tokenId: 'credential-a', attempt: 2,
});

// Each cell lists the approved actions; an omitted cell refuses every action.
const MEMBER_ACTIONS: Readonly<Partial<Record<ResourceKind, readonly Action[]>>> = {
  protocol: ['protocol'], settings: ['read'], directory: ['read'], member: ['read'],
  credential: ['read', 'edit'], machine: ['read', 'edit', 'capture'],
  'machine-settings': ['claimant.read', 'claimant.edit', 'capture'],
  project: ['read'], processed: ['read', 'capture'], plan: ['read', 'edit', 'status', 'capture'],
  spore: ['read', 'edit'], raw: ['read', 'enumerate'], 'raw-index': ['enumerate'], run: ['read'],
};
const PRIVILEGED_HTTP: Readonly<Partial<Record<ResourceKind, readonly Action[]>>> = {
  settings: ['admin'], secret: ['admin'], credential: ['admin'],
  project: ['admin'], processed: ['admin'], grant: ['admin'], enrollment: ['admin'], backup: ['admin'], run: ['admin'], member: ['admin', 'bootstrap'],
};
const OWNER_HTTP: Readonly<Partial<Record<ResourceKind, readonly Action[]>>> = {
  member: ['owner'], raw: ['owner'], enrollment: ['owner'],
};
const RUN_ACTIONS: Readonly<Partial<Record<ResourceKind, readonly Action[]>>> = {
  protocol: ['protocol'], project: ['read'], processed: ['read'], plan: ['read', 'edit'],
  spore: ['read', 'edit'], run: ['read', 'execute'],
};
const GRANT_ACTIONS: Readonly<Partial<Record<ResourceKind, readonly Action[]>>> = {
  protocol: ['protocol'], project: ['read'], processed: ['read'], plan: ['read'], spore: ['read', 'edit'],
};

function approvedActions(actor: string, transport: Transport, kind: ResourceKind): readonly Action[] {
  if (actor === 'internal') return [];
  if (actor === 'run') return RUN_ACTIONS[kind] ?? [];
  if (actor === 'grant') return GRANT_ACTIONS[kind] ?? [];
  if (['public', 'account', 'enrollment'].includes(actor)) return kind === 'protocol' ? ['protocol'] : [];
  const base = MEMBER_ACTIONS[kind] ?? [];
  if (transport === 'mcp') return base;
  return [
    ...base,
    ...(kind === 'project' ? ['create' as const] : []),
    ...(kind === 'raw' ? ['append' as const] : []),
    ...(kind === 'run' ? ['dispatch' as const, 'cancel' as const] : []),
    ...(actor === 'owner' || actor === 'admin' ? PRIVILEGED_HTTP[kind] ?? [] : []),
    ...(actor === 'owner' ? OWNER_HTTP[kind] ?? [] : []),
  ];
}

describe('Deployment authorization policy', () => {
  it('declares each device route and refuses inactive, foreign and incompatible actors', () => {
    const rows = [
      ['/auth/device/start', 'protocol', 'protocol', 'protocol', ['enrollment']],
      ['/auth/device/poll', 'protocol', 'protocol', 'protocol', ['enrollment']],
      ['/api/device/preview', 'directory', 'read', 'deployment', ['member']],
      ['/api/device/approve', 'enrollment', 'enroll.self', 'self-enrollment', ['member']],
      ['/api/device/deny', 'directory', 'read', 'deployment', ['member']],
    ] as const;
    for (const [path, kind, action, resolver, subjects] of rows) {
      const declaration = ROUTES.find(route => route.method === 'POST' && route.path === path)?.authorization;
      expect(declaration).toEqual({ resource: kind, action, resolver, subjects: [...subjects], transport: 'http' });
      for (const [actor, subject] of Object.entries(SUBJECTS)) {
        const resolved = { ...resource(kind), grantedRole: subject.role ?? 'member' };
        const expected = path.startsWith('/auth/') ? actor === 'enrollment' : ['owner', 'admin', 'member'].includes(actor);
        expect({ path, actor, allowed: authorizeDeclaration(subject, declaration, {}, resolved) }).toEqual({ path, actor, allowed: expected });
        expect(authorizeDeclaration({ ...subject, live: false }, declaration, {}, resolved)).toBe(false);
        expect(authorizeDeclaration({ ...subject, deploymentId: 'deployment-b' }, declaration, {}, resolved)).toBe(false);
        expect(authorizeDeclaration({ ...subject, transport: 'mcp' }, declaration, {}, resolved)).toBe(false);
        expect(authorizeDeclaration(subject, undefined, {}, resolved)).toBe(false);
      }
    }
  });

  it('resolves device approval to the actor and their current role despite requested identities', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_1', revision = 1 WHERE id = 1");
      e.sqlite.run("UPDATE members SET role = 'member' WHERE id = 'mem_machine_2'");
      const declaration = ROUTES.find(route => route.path === '/api/device/approve')!.authorization;
      for (const [memberId, role] of [['mem_machine_1', 'owner'], ['mem_machine_3', 'admin'], ['mem_machine_2', 'member']] as const) {
        const subject = await memberSubject(e.db, memberId, 'http');
        const resolved = await resolveHttpResource(e.serverEnv, declaration, subject, { body: JSON.stringify({ memberId: 'someone-else', role: 'owner' }) });
        expect(resolved).toMatchObject({ ownerMemberId: memberId, grantedRole: role });
        expect(authorizeDeclaration(subject, declaration, {}, resolved)).toBe(true);
        e.sqlite.query('UPDATE members SET revoked_at = ? WHERE id = ?').run(100, memberId);
        expect(await authorizeHttp(e.serverEnv, declaration, await memberSubject(e.db, memberId, 'http'), {})).toBe(false);
      }
    } finally { e.sqlite.close(); }
  });

  it('resolves every invitation target authority before selecting its finite action', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run("UPDATE deployment_ownership SET member_id = 'mem_machine_1', revision = 1 WHERE id = 1");
      e.sqlite.run("UPDATE members SET role = 'member' WHERE id = 'mem_machine_2'");
      const declaration = ROUTES.find(route => route.path === '/api/enrollment' && route.method === 'POST')!.authorization;
      const subject = await memberSubject(e.db, 'mem_machine_3', 'http');
      for (const [memberId, grantedRole] of [[undefined, 'member'], ['mem_machine_2', 'member'], ['mem_machine_3', 'admin'], ['mem_machine_1', 'owner']] as const) {
        for (const role of [undefined, 'member', 'admin'] as const) {
          const input = { ...(memberId === undefined ? {} : { memberId }), ...(role === undefined ? {} : { role }) };
          const resolved = await resolveHttpResource(e.serverEnv, declaration, subject, { body: JSON.stringify(input) });
          const effectiveRole = memberId === undefined && role === 'admin' ? 'admin' : grantedRole;
          const action = effectiveRole === 'member' && role !== 'admin' ? 'admin' : 'owner';
          expect({ grantedRole: resolved.grantedRole, action: declaredAction(declaration, input, resolved) }).toEqual({ grantedRole: effectiveRole, action });
          expect(await authorizeHttp(e.serverEnv, declaration, subject, { body: JSON.stringify(input) })).toBe(action === 'admin');
        }
      }
    } finally { e.sqlite.close(); }
  });

  it('enumerates resulting enrollment authority across every actor, action and transport', () => {
    const expected: Record<string, Partial<Record<'owner' | 'admin' | 'member', readonly Action[]>>> = {
      owner: { member: ['admin', 'owner', 'enroll.self'], admin: ['admin', 'owner', 'enroll.self'], owner: ['admin', 'owner', 'enroll.self'] },
      admin: { member: ['admin', 'enroll.self'], admin: ['enroll.self'] },
      member: { member: ['enroll.self'] },
    };
    for (const [actor, subject] of Object.entries(SUBJECTS)) {
      for (const transport of ['http', 'mcp'] as const) {
        for (const grantedRole of ['member', 'admin', 'owner'] as const) {
          for (const action of ACTIONS) {
            expect({ actor, transport, grantedRole, action, admitted: authorize({ ...subject, transport }, action, { ...resource('enrollment'), grantedRole }) })
              .toEqual({ actor, transport, grantedRole, action, admitted: transport === 'http' && (expected[actor]?.[grantedRole]?.includes(action) ?? false) });
          }
        }
      }
    }
  });

  it('self enrollment cannot target another member or exceed the live role', () => {
    for (const actor of ['owner', 'admin', 'member']) {
      expect(authorize(SUBJECTS[actor]!, 'enroll.self', { ...resource('enrollment'), ownerMemberId: 'someone-else', grantedRole: 'member' })).toBe(false);
    }
    expect(authorize(SUBJECTS.admin!, 'enroll.self', { ...resource('enrollment'), grantedRole: 'owner' })).toBe(false);
    expect(authorize(SUBJECTS.member!, 'enroll.self', { ...resource('enrollment'), grantedRole: 'admin' })).toBe(false);
  });

  it('enumerates every approved role × resource × action × transport cell independently of policy implementation', () => {
    expect(RESOURCE_KINDS.map(String).sort()).toEqual(['protocol', 'settings', 'secret', 'directory', 'member', 'credential', 'machine', 'machine-settings', 'project', 'processed', 'plan', 'spore', 'raw', 'raw-index', 'run', 'grant', 'enrollment', 'backup'].sort());
    expect(ACTIONS.map(String).sort()).toEqual(['read', 'enumerate', 'append', 'bootstrap', 'edit', 'status', 'admin', 'owner', 'enroll.self', 'claimant.read', 'claimant.edit', 'cancel', 'execute', 'capture', 'dispatch', 'create', 'protocol', 'never'].sort());
    expect(new Set(Object.values(SUBJECTS).map((s) => s.kind))).toEqual(new Set(SUBJECT_KINDS));
    for (const [actor, initial] of Object.entries(SUBJECTS)) {
      for (const transport of ['http', 'mcp'] as const) {
        for (const kind of RESOURCE_KINDS) {
          const allowed = approvedActions(actor, transport, kind);
          for (const action of ACTIONS) {
            expect({ actor, transport, kind, action, admitted: authorize({ ...initial, transport }, action, resource(kind)) })
              .toEqual({ actor, transport, kind, action, admitted: allowed.includes(action) });
          }
        }
      }
    }
  });

  it('refuses every cross-Deployment and missing identity even when the role or run evidence otherwise admits it', () => {
    for (const [actor, initial] of Object.entries(SUBJECTS)) {
      for (const kind of RESOURCE_KINDS) {
        for (const action of approvedActions(actor, 'http', kind)) {
          expect(authorize(initial, action, { ...resource(kind), deploymentId: 'deployment-b' })).toBe(false);
          expect(authorize({ ...initial, deploymentId: '' }, action, resource(kind))).toBe(false);
          expect(authorize(initial, action, { ...resource(kind), exists: false })).toBe(false);
          expect(authorize({ ...initial, live: false }, action, resource(kind))).toBe(false);
        }
      }
    }
  });

  it('keeps processed Projects shared while run and grant Projects remain bound', () => {
    for (const actor of ['owner', 'admin', 'member']) {
      expect(authorize({ ...SUBJECTS[actor], projectId: 'project-b' }, 'read', resource('processed'))).toBe(true);
    }
    for (const actor of ['run', 'grant']) {
      expect(authorize(SUBJECTS[actor], 'read', { ...resource('processed'), projectId: 'project-b' })).toBe(false);
      expect(authorize({ ...SUBJECTS[actor], projectId: undefined }, 'read', resource('processed'))).toBe(false);
    }
  });

  it('denies raw bytes to owner and admin unless immutable uploader evidence admits them', () => {
    for (const actor of ['owner', 'admin', 'member', 'run', 'grant']) {
      for (const transport of ['http', 'mcp'] as const) {
        const subject = { ...SUBJECTS[actor], transport };
        expect(authorize(subject, 'read', { ...resource('raw'), uploader: false })).toBe(false);
        expect(authorize(subject, 'enumerate', { ...resource('raw'), uploader: false })).toBe(false);
        expect(authorize(subject, 'read', { ...resource('raw'), uploader: undefined })).toBe(false);
        expect(authorize(subject, 'read', resource('raw'))).toBe(['owner', 'admin', 'member'].includes(actor));
      }
    }
  });

  it('requires the claimant for machine settings, roots, connect and capture even for owner/admin', () => {
    for (const actor of ['owner', 'admin', 'member']) {
      for (const action of ['claimant.read', 'claimant.edit', 'capture'] as const) {
        expect(authorize(SUBJECTS[actor], action, { ...resource('machine-settings'), claimantMemberId: 'member-b' })).toBe(false);
        expect(authorize(SUBJECTS[actor], action, { ...resource('machine-settings'), claimantMemberId: undefined })).toBe(false);
        expect(authorize(SUBJECTS[actor], action, resource('machine-settings'))).toBe(true);
      }
    }
  });

  it('members cancel only their requested run and ordinary roles cannot execute run controls', () => {
    for (const actor of ['owner', 'admin', 'member']) {
      expect(authorize(SUBJECTS[actor], 'cancel', { ...resource('run'), requestedBy: 'member-b' })).toBe(actor !== 'member');
      expect(authorize(SUBJECTS[actor], 'execute', resource('run'))).toBe(false);
    }
    expect(authorize(SUBJECTS.member, 'cancel', { ...resource('run'), requestedBy: undefined })).toBe(false);
  });

  it('run admission requires its credential, run, Project and authoritative attempt together', () => {
    const subject = SUBJECTS.run;
    for (const kind of ['run', 'processed', 'spore'] as const) {
      const action = kind === 'run' ? 'execute' : kind === 'spore' ? 'edit' : 'read';
      expect(authorize(subject, action, resource(kind))).toBe(true);
      for (const mismatch of [
        { projectId: 'project-b' }, { runId: 'run-b' }, { tokenId: 'credential-b' }, { attempt: 3 },
        { projectId: undefined }, { runId: undefined }, { tokenId: undefined }, { attempt: undefined },
      ]) {
        expect({ kind, mismatch, admitted: authorize(subject, action, { ...resource(kind), ...mismatch }) })
          .toEqual({ kind, mismatch, admitted: false });
      }
    }
  });

  it('admin authority does not revoke owner control credentials or alter the owner member', () => {
    for (const kind of ['member', 'credential'] as const) {
      expect(authorize(SUBJECTS.admin, 'admin', { ...resource(kind), protectedOwner: true })).toBe(false);
      expect(authorize(SUBJECTS.owner, 'admin', { ...resource(kind), protectedOwner: true })).toBe(true);
    }
    for (const role of ['owner', 'admin', 'member']) {
      expect(authorize(SUBJECTS[role], 'owner', resource('member'))).toBe(role === 'owner');
    }
  });

  it('resolves owner member and credential protections from the serving store rather than a requested identity', async () => {
    const e = sqliteEnv();
    try {
      e.sqlite.run("UPDATE members SET role = 'admin' WHERE id IN ('mem_machine_1', 'mem_machine_2')");
      await bootstrapOwnership(e.db, 'mem_machine_1', 'mem_machine_1', '0', 100);
      const credential = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, 100);
      const admin = await memberSubject(e.db, 'mem_machine_2', 'http');
      const owner = await memberSubject(e.db, 'mem_machine_1', 'http');
      expect(admin.role).toBe('admin');
      expect(owner.role).toBe('owner');
      const memberDeclaration: AuthorizationDeclaration = { subjects: ['member'], transport: 'http', resource: 'member', resolver: 'member', action: 'admin' };
      const credentialDeclaration: AuthorizationDeclaration = { subjects: ['member'], transport: 'http', resource: 'credential', resolver: 'credential', action: 'edit' };
      const memberInput = { params: { memberId: 'mem_machine_1' } };
      const credentialInput = { params: { id: credential.tokenId } };
      expect(await resolveHttpResource(e.serverEnv, memberDeclaration, admin, memberInput)).toMatchObject({ exists: true, protectedOwner: true });
      expect(await resolveHttpResource(e.serverEnv, credentialDeclaration, admin, credentialInput)).toMatchObject({ exists: true, protectedOwner: true, ownerMemberId: 'mem_machine_1' });
      expect(await authorizeHttp(e.serverEnv, memberDeclaration, admin, memberInput)).toBe(false);
      expect(await authorizeHttp(e.serverEnv, credentialDeclaration, admin, credentialInput)).toBe(false);
      expect(await authorizeHttp(e.serverEnv, { ...credentialDeclaration, action: 'read' }, admin, credentialInput)).toBe(false);
      expect(await authorizeHttp(e.serverEnv, memberDeclaration, owner, memberInput)).toBe(true);
      expect(await authorizeHttp(e.serverEnv, credentialDeclaration, owner, credentialInput)).toBe(true);
      const sibling = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, 100);
      expect((await listCredentials(e.db, 100, await credentialListScope(e.serverEnv, admin))).rows.map(row => row.id)).toEqual([sibling.tokenId]);
      expect((await listCredentials(e.db, 100, await credentialListScope(e.serverEnv, owner))).rows.map(row => row.id).sort()).toEqual([credential.tokenId, sibling.tokenId].sort());
      await expect(credentialListScope(e.serverEnv, { ...admin, live: false })).rejects.toThrow('Credential collection access refused');
      expect(await authorizeHttp(e.serverEnv, memberDeclaration, owner, { params: { memberId: 'missing' } })).toBe(false);
      expect(await authorizeHttp(e.serverEnv, credentialDeclaration, owner, { params: { id: 'missing' } })).toBe(false);
    } finally { e.sqlite.close(); }
  });

  it('refuses unknown actions, resources, subjects and undeclared or incompatible declarations', () => {
    const valid: AuthorizationDeclaration = { subjects: ['member'], transport: 'http', resource: 'processed', resolver: 'project', action: 'read' };
    expect(authorizeDeclaration(SUBJECTS.member, valid, {}, resource('processed'))).toBe(true);
    expect(authorizeDeclaration(SUBJECTS.member, undefined, {}, resource('processed'))).toBe(false);
    expect(authorizeDeclaration(SUBJECTS.member, { ...valid, transport: 'mcp' }, {}, resource('processed'))).toBe(false);
    expect(authorizeDeclaration(SUBJECTS.member, { ...valid, subjects: ['run'] }, {}, resource('processed'))).toBe(false);
    expect(authorizeDeclaration(SUBJECTS.member, valid, {}, resource('secret'))).toBe(false);
    expect(authorizeDeclaration(SUBJECTS.member, { ...valid, resolver: 'unknown' as AuthorizationDeclaration['resolver'] }, {}, resource('processed'))).toBe(false);
    for (const action of ACTIONS) {
      expect(authorize(SUBJECTS.member, action, resource('backup'))).toBe(false);
    }
    expect(authorize(SUBJECTS.owner, 'execute', resource('secret'))).toBe(false);
    expect(authorize(SUBJECTS.owner, 'unknown' as Action, resource('processed'))).toBe(false);
    expect(authorize(SUBJECTS.owner, 'read', { ...resource('processed'), kind: 'unknown' as ResourceKind })).toBe(false);
    expect(authorize({ ...SUBJECTS.owner, kind: 'unknown' as AuthorizationSubject['kind'] }, 'read', resource('processed'))).toBe(false);
  });

  it('finite dynamic action declarations refuse unresolved and undeclared resolutions', () => {
    const declaration: AuthorizationDeclaration = { subjects: ['member'], transport: 'http', resource: 'plan', resolver: 'project', action: { actions: ['read', 'edit'], resolve: (input) => input.op === 'get' ? 'read' : input.op === 'save' ? 'edit' : input.op === 'escalate' ? 'admin' : null } };
    expect(declaredAction(declaration, { op: 'get' })).toBe('read');
    expect(declaredAction(declaration, { op: 'save' })).toBe('edit');
    expect(declaredAction(declaration, { op: 'unknown' })).toBeNull();
    expect(declaredAction(declaration, { op: 'escalate' })).toBeNull();
    expect(authorizeDeclaration(SUBJECTS.member, declaration, { op: 'escalate' }, resource('plan'))).toBe(false);
  });

  it('the live HTTP and MCP tables give the same editorial/read decision for every human role', () => {
    const cases = [
      { path: '/api/projects/{projectId}/plans/{planKey}', method: 'GET', tool: 'myco_plans' as const, op: 'get', kind: 'plan' as const, input: {} },
      { path: '/api/projects/{projectId}/sessions/{sessionId}/plans/{planKey}/status', method: 'POST', tool: 'myco_plans' as const, op: 'save', kind: 'plan' as const, input: { id: 'plan-a', status: 'done' } },
      { path: '/api/projects/{projectId}/spores/{sporeId}', method: 'GET', tool: 'myco_spores' as const, op: 'get', kind: 'spore' as const, input: {} },
    ];
    for (const item of cases) {
      const route = ROUTES.find((r) => r.path === item.path && r.method === item.method);
      expect({ path: item.path, registered: route !== undefined }).toEqual({ path: item.path, registered: true });
      const httpDeclaration = (route as typeof route & { authorization: AuthorizationDeclaration }).authorization;
      const mcpDeclaration = TOOL_REGISTRY[item.tool].ops[item.op].authorization;
      expect(declaredAction(httpDeclaration, item.input)).toBe(declaredAction(mcpDeclaration, item.input));
      for (const actor of ['owner', 'admin', 'member']) {
        const viaHttp = authorizeDeclaration({ ...SUBJECTS[actor], transport: 'http' }, httpDeclaration, item.input, resource(item.kind));
        const viaMcp = authorizeDeclaration({ ...SUBJECTS[actor], transport: 'mcp' }, mcpDeclaration, item.input, resource(item.kind));
        expect({ actor, path: item.path, viaHttp, viaMcp }).toEqual({ actor, path: item.path, viaHttp: true, viaMcp: true });
      }
    }
  });
});

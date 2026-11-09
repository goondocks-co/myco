import { describe, expect, it } from 'bun:test';
import { credentialResourceOf, deploymentIdentity, memberSubject } from '@myco-server-worker/auth/authorization.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { httpAuthorizationDecision, httpPolicy } from '@myco-server-worker/auth/http-authorization.js';
import { authorizeTool } from '@myco-server-worker/auth/mcp-authorization.js';
import { revokeCredentialAsMember } from '@myco-server-worker/auth/tokens.js';
import { issueMemberToken } from './helpers/member-token.js';
import { readAuthorization } from '@myco-server-worker/db/auth/authorization.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { TOOL_REGISTRY } from '@myco-server-worker/mcp/registry.js';
import type { ToolContext } from '@myco-server-worker/mcp/context.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;

/** Runs `change` immediately after the request's authorization read has answered, before anything it decided is written. */
function afterFirstRead(db: RelationalStore, change: (store: RelationalStore) => Promise<unknown>): RelationalStore {
  let fired = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'batch') return Reflect.get(target, property, receiver);
      return async (statements: PreparedStatement[]) => {
        const results = await target.batch(statements);
        if (!fired) { fired = true; await change(target); }
        return results;
      };
    },
  });
}

async function people() {
  const fixture = sqliteEnv();
  await ensureMember(fixture.db, 'mem_owner', 1, 'admin');
  await ensureMember(fixture.db, 'mem_ada', 2, 'admin');
  await ensureMember(fixture.db, 'mem_lin', 3, 'member');
  await fixture.db.prepare("UPDATE members SET github_id = 'gh_' || id WHERE id IN ('mem_owner','mem_ada')").run();
  await fixture.db.prepare("UPDATE deployment_ownership SET member_id='mem_owner',revision=revision+1 WHERE id=1").run();
  return fixture;
}

const live = async (db: RelationalStore, tokenId: string) => (await db.prepare('SELECT revoked_at AS revoked FROM member_credentials WHERE id = ?').bind(tokenId).first<{ revoked: number | null }>())?.revoked === null;

describe('the request authorization snapshot', () => {
  it('answers identity, subject, owner and resource together', async () => {
    const { db } = await people();
    const token = await issueMemberToken(db, { memberId: 'mem_lin', machineId: 'machine_1' }, NOW);
    const snapshot = await readAuthorization(db, { subjectMember: 'mem_lin', targetMember: 'mem_owner', ownership: true, credential: token.tokenId, project: 'proj_1', liveCredential: { tokenId: token.tokenId, memberId: 'mem_lin', now: NOW } });
    expect(snapshot.deploymentId).toBe(await deploymentIdentity(db));
    expect(snapshot.subjectMember).toMatchObject({ id: 'mem_lin', role: 'member', owner: 'mem_owner' });
    expect(snapshot.targetMember?.id).toBe('mem_owner');
    expect(snapshot.ownership).toEqual({ memberId: 'mem_owner' });
    expect(snapshot.credential).toEqual({ member_id: 'mem_lin', owner: 'mem_owner' });
    expect(snapshot.credentialLive).toBe(true);
  });

  it('refuses without a Deployment identity rather than deciding on none', async () => {
    const { db } = await people();
    await db.prepare("DELETE FROM schema_meta WHERE key='deployment_id'").run();
    await expect(readAuthorization(db, {})).rejects.toThrow('Deployment identity is missing');
  });

  it('keeps an absent member and resource indistinguishable from refused', async () => {
    const { db } = await people();
    expect(await memberSubject(db, 'mem_nobody', 'http')).toMatchObject({ live: false, role: undefined });
    expect(credentialResourceOf(await readAuthorization(db, { credential: 'tok_nobody' }), 'tok_nobody')).toMatchObject({ exists: false, ownerMemberId: undefined });
  });

  it('authorizes an MCP member only while credential and member are both live, on every tool call', async () => {
    const { db, serverEnv } = await people();
    const token = await issueMemberToken(db, { memberId: 'mem_lin', machineId: 'machine_1' }, NOW);
    const ctx = (now: number, tokenId = token.tokenId): ToolContext => ({ env: serverEnv, projectId: 'proj_1', now, principal: { kind: 'member', memberId: 'mem_lin', machineId: 'machine_1', tokenId } });
    const list = TOOL_REGISTRY.myco_spores.ops.list.authorization;
    expect(await authorizeTool(ctx(NOW), list, { op: 'list' } as never)).toBe(true);
    expect(await authorizeTool(ctx(NOW, 'tok_other'), list, { op: 'list' } as never)).toBe(false);
    await db.prepare('UPDATE member_credentials SET revoked_at = ? WHERE id = ?').bind(NOW, token.tokenId).run();
    expect(await authorizeTool(ctx(NOW), list, { op: 'list' } as never)).toBe(false);
  });

  it('decides an HTTP request and returns the live subject it was decided on', async () => {
    const { db, serverEnv } = await people();
    const policy = httpPolicy('member', 'owner', 'member');
    const owner = await httpAuthorizationDecision(serverEnv, policy, { memberId: 'mem_owner' }, { params: { memberId: 'mem_lin' } });
    expect(owner).toMatchObject({ allowed: true, subject: { role: 'owner', live: true }, resource: { ownerMemberId: 'mem_lin' } });
    const member = await httpAuthorizationDecision(serverEnv, policy, { memberId: 'mem_lin' }, { params: { memberId: 'mem_ada' } });
    expect(member).toMatchObject({ allowed: false, subject: { role: 'member' } });
    await db.prepare('UPDATE members SET revoked_at=? WHERE id=?').bind(NOW, 'mem_owner').run();
    const removed = await httpAuthorizationDecision(serverEnv, policy, { memberId: 'mem_owner' }, { params: { memberId: 'mem_lin' } });
    expect(removed).toMatchObject({ allowed: false, subject: { live: false } });
  });
});

describe('a snapshot that goes stale before its write', () => {
  it('refuses a revocation by an actor removed mid-request', async () => {
    const { db } = await people();
    const target = await issueMemberToken(db, { memberId: 'mem_lin', machineId: 'machine_1' }, NOW);
    const stale = afterFirstRead(db, store => store.prepare('UPDATE members SET revoked_at = ?, revoked_by = ? WHERE id = ?').bind(NOW, 'mem_owner', 'mem_ada').run());
    const answer = await revokeCredentialAsMember(stale, { id: 'mem_ada', label: null, role: 'admin' } as never, target.tokenId, NOW);
    expect(answer.revoked).toBe(false);
    expect(await live(db, target.tokenId)).toBe(true);
  });

  it('refuses a revocation of the owner\'s credential when ownership moved mid-request', async () => {
    const { db } = await people();
    const owners = await issueMemberToken(db, { memberId: 'mem_ada', machineId: 'machine_1' }, NOW);
    // Ada is not yet the owner when the read answers; the owner's protection arrives before the write.
    const moved = afterFirstRead(db, store => store.prepare("UPDATE deployment_ownership SET member_id='mem_ada',revision=revision+1 WHERE id=1").run());
    const answer = await revokeCredentialAsMember(moved, { id: 'mem_owner', label: null, role: 'admin' } as never, owners.tokenId, NOW);
    expect(answer.revoked).toBe(false);
    expect(await live(db, owners.tokenId)).toBe(true);
  });

  it('still applies the revocation when nothing changed', async () => {
    const { db } = await people();
    const target = await issueMemberToken(db, { memberId: 'mem_lin', machineId: 'machine_1' }, NOW);
    const answer = await revokeCredentialAsMember(db, { id: 'mem_ada', label: null, role: 'admin' } as never, target.tokenId, NOW);
    expect(answer).toEqual({ revoked: true, revokedBy: 'mem_ada' });
    expect(await live(db, target.tokenId)).toBe(false);
  });
});

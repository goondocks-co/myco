import { describe, expect, it } from 'bun:test';
import { issueExternalGrant } from '@myco-server-worker/auth/grants.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';
import { grantToolContext, toolContext, unboundToolContext } from '@myco-server-worker/mcp/context.js';
import { callTool } from '@myco-server-worker/mcp/server.js';
import type { PreparedStatement } from '@myco-server-worker/core/adapters.js';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { asOwnerPatch, OWNER_ENV } from './helpers/owner.js';

const NOW = Date.now();
const MEMBER = 'mem_machine_2';
const MEMBER_MACHINE = 'machine_2';
const SAVE = { op: 'save', project: 'proj_1', type: 'gotcha', content: 'a write this principal no longer holds', agent_line: 'When probing, keep the evidence.' };
const AUTHORIZATION_READ = /FROM members m LEFT JOIN deployment_ownership o|FROM member_credentials c JOIN members m ON m\.id=c\.member_id|FROM external_grants WHERE id=\?1 AND revoked_at IS NULL/;

/** A Deployment whose store runs `change` immediately after the request's authorization read answers. */
function rig() {
  const state: { saw: boolean; change?: (fixture: ReturnType<typeof sqliteEnv>) => void; fired: boolean } = { saw: false, fired: false };
  const fixture = sqliteEnv({ onSql: sql => { if (AUTHORIZATION_READ.test(sql)) state.saw = true; } });
  const raw = fixture.env.MYCO_DB;
  fixture.env.MYCO_DB = new Proxy(raw, {
    get(target, property, receiver) {
      if (property !== 'batch') return Reflect.get(target, property, receiver);
      return async (statements: PreparedStatement[]) => {
        const results = await target.batch(statements);
        if (state.saw && state.change !== undefined && !state.fired) { state.fired = true; state.change(fixture); }
        return results;
      };
    },
  });
  return { fixture, state };
}
type Rig = ReturnType<typeof rig>;
const spores = ({ fixture }: Rig) => (fixture.sqlite.query('SELECT COUNT(*) AS n FROM spores').get() as { n: number }).n;
const memberToken = ({ fixture }: Rig) => issueMemberToken(fixture.db, { memberId: MEMBER, machineId: MEMBER_MACHINE }, NOW);
const memberCaller = (tokenId: string) => ({ projectId: 'proj_1', memberId: MEMBER, machineId: MEMBER_MACHINE, tokenId, now: NOW });

const REVOKE_CREDENTIAL = (id: string) => (f: ReturnType<typeof sqliteEnv>) => { f.sqlite.run('UPDATE member_credentials SET revoked_at = ? WHERE id = ?', [NOW, id]); };
const EXPIRE_CREDENTIAL = (id: string) => (f: ReturnType<typeof sqliteEnv>) => { f.sqlite.run('UPDATE member_credentials SET expires_at = ? WHERE id = ?', [NOW - 1, id]); };
const REMOVE_MEMBER = () => (f: ReturnType<typeof sqliteEnv>) => { f.sqlite.run('UPDATE members SET revoked_at = ? WHERE id = ?', [NOW, MEMBER]); };

describe('a tool write whose authority ended after its authorization', () => {
  for (const [name, change] of [['credential revoked', REVOKE_CREDENTIAL], ['credential expired', EXPIRE_CREDENTIAL], ['member removed', REMOVE_MEMBER]] as const) {
    it(`refuses a member's write when the ${name}, and saves nothing`, async () => {
      const r = rig();
      try {
        const token = await memberToken(r);
        r.state.change = change(token.tokenId);
        const call = callTool(toolContext(r.fixture.serverEnv, memberCaller(token.tokenId) as never), 'myco_spores', SAVE);
        await expect(call).rejects.toMatchObject({ code: 'tool_call_failed', message: expect.stringContaining('Nothing was saved') });
        expect(r.state.fired).toBe(true);
        expect(spores(r)).toBe(0);
      } finally { r.fixture.sqlite.close(); }
    });
  }

  it('saves the same write while the member still holds, including a call that names its Project', async () => {
    const r = rig();
    try {
      const token = await memberToken(r);
      await callTool(toolContext(r.fixture.serverEnv, memberCaller(token.tokenId) as never), 'myco_spores', SAVE);
      await callTool(unboundToolContext(r.fixture.serverEnv, memberCaller(token.tokenId)), 'myco_spores', { ...SAVE, content: 'a second write from before a Project is named' });
      expect(spores(r)).toBe(2);
    } finally { r.fixture.sqlite.close(); }
  });

  it('refuses a call that named its Project once the credential is revoked', async () => {
    const r = rig();
    try {
      const token = await memberToken(r);
      r.state.change = REVOKE_CREDENTIAL(token.tokenId);
      await expect(callTool(unboundToolContext(r.fixture.serverEnv, memberCaller(token.tokenId)), 'myco_spores', SAVE))
        .rejects.toMatchObject({ code: 'tool_call_failed' });
      expect(spores(r)).toBe(0);
    } finally { r.fixture.sqlite.close(); }
  });

  for (const [name, change] of [
    ['revoked', (id: string) => (f: ReturnType<typeof sqliteEnv>) => { f.sqlite.run('UPDATE external_grants SET revoked_at = ? WHERE id = ?', [NOW, id]); }],
    ['expired', (id: string) => (f: ReturnType<typeof sqliteEnv>) => { f.sqlite.run('UPDATE external_grants SET expires_at = ? WHERE id = ?', [NOW - 1, id]); }],
    ['moved to another Project', (id: string) => (f: ReturnType<typeof sqliteEnv>) => { f.sqlite.run("UPDATE external_grants SET project_id = 'proj_2' WHERE id = ?", [id]); }],
  ] as const) {
    it(`refuses a grant's write when it is ${name}, and saves nothing`, async () => {
      const r = rig();
      try {
        const grant = await issueExternalGrant(r.fixture.db, { projectId: 'proj_1' }, 'key', 'mem_machine_1', NOW);
        r.state.change = change(grant.id);
        const { project: _project, ...input } = SAVE;
        const call = callTool(grantToolContext(r.fixture.serverEnv, { projectId: 'proj_1', grantId: grant.id, now: NOW, body: '' }), 'myco_spores', input);
        await expect(call).rejects.toMatchObject({ code: 'tool_call_failed', message: expect.stringContaining('access key') });
        expect(r.state.fired).toBe(true);
        expect(spores(r)).toBe(0);
      } finally { r.fixture.sqlite.close(); }
    });
  }

  it('saves a grant\'s write while the grant still holds', async () => {
    const r = rig();
    try {
      const grant = await issueExternalGrant(r.fixture.db, { projectId: 'proj_1' }, 'key', 'mem_machine_1', NOW);
      const { project: _project, ...input } = SAVE;
      await callTool(grantToolContext(r.fixture.serverEnv, { projectId: 'proj_1', grantId: grant.id, now: NOW, body: '' }), 'myco_spores', { ...input, provenance_kind: 'commit', provenance_ref: 'abcdef1' });
      expect(spores(r)).toBe(1);
    } finally { r.fixture.sqlite.close(); }
  });
});

describe('a member route whose authority ended after its authorization', () => {
  const save = { id: 'stale-route-spore', observationType: 'gotcha', content: 'a route write this credential no longer holds', agentLine: 'When probing, keep the evidence.' };

  it('answers retryable on the credential routes, saves nothing, and the retry meets the revocation', async () => {
    const r = rig();
    try {
      const token = await memberToken(r);
      r.state.change = REVOKE_CREDENTIAL(token.tokenId);
      const response = await worker.fetch(memberPost(token.token, save, '/spores/save'), r.fixture.env);
      expect(response.status).toBe(503);
      expect(r.state.fired).toBe(true);
      expect(spores(r)).toBe(0);
      expect((await worker.fetch(memberPost(token.token, save, '/spores/save'), r.fixture.env)).status).toBe(401);
    } finally { r.fixture.sqlite.close(); }
  });

  it('creates no Project for a credential revoked after its authorization', async () => {
    const r = rig();
    try {
      const token = await memberToken(r);
      r.state.change = REVOKE_CREDENTIAL(token.tokenId);
      const before = r.fixture.sqlite.query('SELECT COUNT(*) AS n FROM projects').get() as { n: number };
      const response = await worker.fetch(memberPost(token.token, { name: 'Stale project' }, '/members/projects'), r.fixture.env);
      expect(response.status).toBe(503);
      expect(r.fixture.sqlite.query('SELECT COUNT(*) AS n FROM projects').get()).toEqual(before);
    } finally { r.fixture.sqlite.close(); }
  });

  it('refuses a dashboard member route for a member removed after its authorization', async () => {
    const r = rig();
    try {
      r.fixture.sqlite.run("INSERT OR IGNORE INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine_1','mem_machine_1',1)");
      r.state.change = f => { f.sqlite.run("UPDATE members SET revoked_at = ? WHERE id = 'mem_machine_1'", [NOW]); };
      const label = () => r.fixture.sqlite.query("SELECT label FROM machine_claims WHERE machine_id = 'machine_1'").get();
      const before = label();
      const response = await worker.fetch(await asOwnerPatch(r.fixture.db, '/api/machines/machine_1', { label: 'renamed' }), { ...r.fixture.env, ...OWNER_ENV });
      expect(response.status).toBe(403);
      expect(r.state.fired).toBe(true);
      expect(label()).toEqual(before);
    } finally { r.fixture.sqlite.close(); }
  });
});

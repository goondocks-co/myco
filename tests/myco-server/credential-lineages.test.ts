import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { authorizeTool } from '@myco-server-worker/auth/mcp-authorization.js';
import { listMembers, revokeMember } from '@myco-server-worker/auth/members-admin.js';
import { activateSuccessor, issueMemberToken, revokeCredentialStatement, revokeMemberLineage } from '@myco-server-worker/auth/tokens.js';
import { handleCredentials, handleInvitations, handleMembers } from '@myco-server-worker/api/access.js';
import { handleGrants } from '@myco-server-worker/api/grants.js';
import { issueExternalGrant } from '@myco-server-worker/auth/grants.js';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { HARNESS_MEMBER_ID, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/constants.js';
import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { pruneRevokedCredentials } from '@myco-server-worker/db/credential-retention.js';
import { catchUpProjections, resetProjectionCatchup } from '@myco-server-worker/db/projections/catchup.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { TOOL_REGISTRY } from '@myco-server-worker/mcp/registry.js';
import type { ToolContext } from '@myco-server-worker/mcp/context.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { measuredStore } from './helpers/read-budget.js';

const NOW = 1_800_000_000_000;
const stores = ['native', 'D1'] as const;
const OWNER = 'mem_owner', ADA = 'mem_ada', LIN = 'mem_lin';

async function withStore<T>(target: typeof stores[number], body: (db: RelationalStore, d1?: ReturnType<Miniflare['getD1Database']> extends Promise<infer D> ? D : never) => Promise<T>): Promise<T> {
  if (target === 'native') {
    const native = new Database(':memory:');
    try { const db = sqliteRelationalStore(native); await migrate(db); return await body(db); } finally { native.close(); }
  }
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try { const d1 = await mf.getD1Database('DB'); const db = d1 as unknown as RelationalStore; await migrate(db); return await body(db, d1); } finally { await mf.dispose(); }
}

async function migrate(db: RelationalStore) {
  for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
  await db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('deployment_id','deployment')").run();
  await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','one',1)").run();
  await ensureMember(db, OWNER, 1, 'admin');
  await ensureMember(db, ADA, 2, 'member');
  await ensureMember(db, LIN, 3, 'member');
}

/** What a head must say, recomputed from every credential row the slow way. */
async function expectHeadsExact(db: RelationalStore, label: string) {
  const { results: sources } = await db.prepare(`SELECT id,member_id,machine_id,lineage_root,lineage_started_at,predecessor_id,first_used_at,revoked_at,issued_at,expires_at FROM member_credentials WHERE member_id<>?`)
    .bind(HARNESS_MEMBER_ID).all<{ id: string; member_id: string; machine_id: string | null; lineage_root: string; lineage_started_at: number; predecessor_id: string | null; first_used_at: number | null; revoked_at: number | null; issued_at: number; expires_at: number }>();
  const roots = new Map<string, typeof sources>();
  for (const row of sources) roots.set(row.lineage_root, [...roots.get(row.lineage_root) ?? [], row]);
  const newest = (rows: typeof sources) => [...rows].sort((a, b) => b.issued_at - a.issued_at || (a.id < b.id ? 1 : -1))[0]?.id ?? null;
  const expected = [...roots.entries()].map(([root, rows]) => {
    const live = rows.filter(row => row.revoked_at === null);
    const banked = live.filter(row => row.predecessor_id !== null && row.first_used_at === null);
    return {
      lineage_root: root, member_id: rows[0]!.member_id, machine_id: rows[0]!.machine_id, started_at: rows[0]!.lineage_started_at,
      current_id: newest(live.filter(row => row.predecessor_id === null || row.first_used_at !== null)),
      banked_id: newest(banked), live_tokens: live.length, banked_tokens: banked.length,
      live_until: live.length === 0 ? 0 : Math.max(...live.map(row => row.expires_at)),
    };
  }).sort((a, b) => a.lineage_root < b.lineage_root ? -1 : 1);
  const { results: heads } = await db.prepare('SELECT lineage_root,member_id,machine_id,started_at,current_id,banked_id,live_tokens,banked_tokens,live_until FROM credential_lineages ORDER BY lineage_root').all();
  expect(heads, label).toEqual(expected);
}

const build = async (db: RelationalStore) => {
  for (let page = 0; page < 200; page += 1) {
    const { more, failures } = await catchUpProjections(db, { budget: { calls: 500, wallMs: 60_000 } });
    expect(failures).toBeUndefined();
    if (!more) return;
  }
  throw new Error('lineage heads did not finish building');
};

const countOf = async (db: RelationalStore, memberId: string, at = NOW) => (await listMembers(db, at)).rows.find(row => row.id === memberId)!;
const memberTool = (db: RelationalStore, tokenId: string, memberId: string): ToolContext => ({
  env: { db } as unknown as ServerEnv, projectId: 'proj_1', now: NOW,
  principal: { kind: 'member', memberId, machineId: 'machine_1', tokenId },
});
const LIST = TOOL_REGISTRY.myco_spores.ops.list.authorization;

describe('credential lineage heads', () => {
  it.each(stores)('match the credential rows through issue, rotation, activation, revocation and pruning on %s', async target => {
    await withStore(target, async db => {
      await expectHeadsExact(db, 'empty');
      const root = await issueMemberToken(db, { memberId: ADA, machineId: 'machine_1' }, NOW);
      await expectHeadsExact(db, 'root');
      const lineage = { predecessorId: root.tokenId, lineageRoot: root.tokenId, lineageStartedAt: NOW };
      const banked = await issueMemberToken(db, { memberId: ADA, machineId: 'machine_1' }, NOW + 10, lineage);
      await expectHeadsExact(db, 'banked successor');
      await db.prepare('UPDATE member_credentials SET revoked_at = ? WHERE id = ?').bind(NOW + 11, banked.tokenId).run();
      await expectHeadsExact(db, 'replaced banked successor');
      const second = await issueMemberToken(db, { memberId: ADA, machineId: 'machine_1' }, NOW + 12, lineage);
      await activateSuccessor(db, { tokenId: second.tokenId, predecessorId: root.tokenId }, NOW + 20);
      await expectHeadsExact(db, 'activated');
      const other = await issueMemberToken(db, { memberId: LIN, machineId: 'machine_2' }, NOW + 30);
      await expectHeadsExact(db, 'second member');
      await revokeCredentialStatement(db, LIN, other.tokenId, NOW + 31).run();
      await expectHeadsExact(db, 'single revoke');
      await revokeMemberLineage(db, second.tokenId, NOW + 40, ADA);
      await expectHeadsExact(db, 'lineage revoke');
      expect(await pruneRevokedCredentials(db, ADA, NOW + 100, 2)).toBeGreaterThan(0);
      await expectHeadsExact(db, 'partial prune');
      await pruneRevokedCredentials(db, ADA, NOW + 100, 100);
      await pruneRevokedCredentials(db, LIN, NOW + 100, 100);
      await expectHeadsExact(db, 'fully pruned');
      expect((await db.prepare('SELECT COUNT(*) AS n FROM credential_lineages').first<{ n: number }>())?.n).toBe(0);
    });
  }, 120_000);

  it('gives a run credential no head and counts it for no one', async () => {
    await withStore('native', async db => {
      await ensureMember(db, HARNESS_MEMBER_ID, 4, 'admin');
      await issueMemberToken(db, { memberId: HARNESS_MEMBER_ID, machineId: null }, NOW);
      expect((await db.prepare('SELECT COUNT(*) AS n FROM credential_lineages').first<{ n: number }>())?.n).toBe(0);
      expect((await countOf(db, HARNESS_MEMBER_ID)).liveCredentials).toBe(0);
    });
  });

  it('counts a member\'s runtimes from the heads: one per rotating lineage, ending at expiry with no write', async () => {
    await withStore('native', async db => {
      const first = await issueMemberToken(db, { memberId: ADA, machineId: 'machine_1' }, NOW);
      await issueMemberToken(db, { memberId: ADA, machineId: 'machine_1' }, NOW + 5, { predecessorId: first.tokenId, lineageRoot: first.tokenId, lineageStartedAt: NOW });
      await issueMemberToken(db, { memberId: ADA, machineId: 'machine_2' }, NOW + 1);
      const row = await countOf(db, ADA, NOW + 10);
      expect(row.liveCredentials).toBe(2);
      expect(row.runtimeFreshness).toEqual({ state: 'ready', asOf: NOW + 10 });
      const later = await countOf(db, ADA, NOW + 2 + MEMBER_TOKEN_TTL_MS);
      expect(later.liveCredentials).toBe(1);
      expect((await countOf(db, ADA, NOW + 10 + MEMBER_TOKEN_TTL_MS)).liveCredentials).toBe(0);
    });
  });

  it('tells no viewer when another member\'s credential expires', async () => {
    await withStore('native', async db => {
      const token = await issueMemberToken(db, { memberId: OWNER, machineId: 'machine_1' }, NOW);
      await issueMemberToken(db, { memberId: ADA, machineId: 'machine_2' }, NOW + 7);
      const response = await handleMembers({ db } as unknown as ServerEnv, { now: NOW + 8, url: new URL('https://s/api/members'), member: { id: LIN, role: 'member' } } as never);
      const text = await response.text();
      expect(text).not.toContain(String(token.expiresAt));
      expect(text).not.toContain(String(NOW + 7 + MEMBER_TOKEN_TTL_MS));
      expect(text).not.toContain('validUntil');
      expect((JSON.parse(text) as { members: { id: string; liveCredentials: number }[] }).members.find(member => member.id === OWNER)?.liveCredentials).toBe(1);
    });
  });

  it('reports a removed member as no runtimes', async () => {
    await withStore('native', async db => {
      await issueMemberToken(db, { memberId: LIN, machineId: 'machine_1' }, NOW);
      await db.prepare("UPDATE members SET github_id='gh-owner' WHERE id=?").bind(OWNER).run();
      await db.prepare("UPDATE members SET github_id='gh-ada', role='admin' WHERE id=?").bind(ADA).run();
      expect(await revokeMember(db, LIN, ADA, NOW + 1)).toEqual({ ok: true });
      await expectHeadsExact(db, 'member removed');
      expect((await countOf(db, LIN, NOW + 2)).liveCredentials).toBe(0);
    });
  });

  it.each(stores)('says building until existing lineages are caught up, and never changes who is authorized on %s', async target => {
    await withStore(target, async db => {
      const live = await issueMemberToken(db, { memberId: ADA, machineId: 'machine_1' }, NOW);
      const ended = await issueMemberToken(db, { memberId: LIN, machineId: 'machine_2' }, NOW);
      await revokeCredentialStatement(db, LIN, ended.tokenId, NOW).run();
      await resetProjectionCatchup(db);

      const building = await countOf(db, ADA);
      expect(building.liveCredentials).toBeNull();
      expect(building.runtimeFreshness).toEqual({ state: 'building', asOf: NOW });
      expect(await authorizeTool(memberTool(db, live.tokenId, ADA), LIST, { op: 'list' } as never)).toBe(true);
      expect(await authorizeTool(memberTool(db, ended.tokenId, LIN), LIST, { op: 'list' } as never)).toBe(false);

      const during = await issueMemberToken(db, { memberId: ADA, machineId: 'machine_3' }, NOW + 1);
      await build(db);
      await expectHeadsExact(db, 'after catch-up');
      expect((await countOf(db, ADA, NOW + 2)).liveCredentials).toBe(2);
      expect(await authorizeTool(memberTool(db, during.tokenId, ADA), LIST, { op: 'list' } as never)).toBe(true);
    });
  }, 120_000);

  it('reads a flat number of rows however long a member\'s credential history is', async () => {
    const measure = async (history: number) => withStore('D1', async (db, d1) => {
      const ids = JSON.stringify(Array.from({ length: history }, (_, n) => n));
      const insert = (member: string, machine: string, revokedAt: string, expiresAt: string) => db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at,revoked_at)
        SELECT ?1||'-'||value,?1,?2,?1||'-h-'||value,?3-value-5,${expiresAt},?1||'-root',?3-value-5,${revokedAt} FROM json_each(?4)`).bind(member, machine, NOW, ids);
      await insert(ADA, 'machine_1', '?3', '?3 + 10').run();
      await insert(LIN, 'machine_2', 'NULL', '?3 - 1').run();
      const current = await issueMemberToken(db, { memberId: ADA, machineId: 'machine_1' }, NOW);
      await build(db);
      const meter = measuredStore(d1!);
      const env = { db: meter.db } as unknown as ServerEnv;
      const measured = async (work: () => Promise<unknown>) => { meter.reset(); await work(); return meter.reads(); };
      return {
        tool: await measured(() => authorizeTool(memberTool(meter.db, current.tokenId, ADA), LIST, { op: 'list' } as never)),
        members: await measured(async () => handleMembers(env, { now: NOW, url: new URL('https://s/api/members') } as never)),
        detail: await measured(() => handleCredentials(env, { now: NOW, url: new URL('https://s/api/credentials?purpose=member&limit=5'), member: { id: ADA, role: 'member' } } as never)),
      };
    });
    const small = await measure(20);
    const large = await measure(400);
    expect(large).toEqual(small);
  }, 180_000);
});

describe('member, invitation and grant pages', () => {
  it('page by cursor with no total, and refuse a malformed cursor', async () => {
    await withStore('native', async db => {
      const env = { db } as unknown as ServerEnv;
      const get = async (handler: typeof handleMembers, path: string, extra: object = {}) => {
        const response = await handler(env, { now: NOW, url: new URL(`https://s${path}`), ...extra } as never);
        return { status: response.status, body: await response.json() as Record<string, unknown> & { cursor?: string | null } };
      };
      const one = await get(handleMembers, '/api/members?limit=2');
      expect((one.body.members as { id: string }[]).map(member => member.id)).toEqual([OWNER, ADA]);
      expect(one.body.total).toBeUndefined();
      const two = await get(handleMembers, `/api/members?limit=2&cursor=${encodeURIComponent(one.body.cursor!)}`);
      expect((two.body.members as { id: string }[]).map(member => member.id)).toEqual([LIN]);
      expect(two.body.cursor).toBeNull();
      expect((await get(handleMembers, '/api/members?cursor=nope')).status).toBe(400);

      for (let n = 0; n < 3; n += 1) await issueEnrollmentAuthority(db, NOW + n, { role: 'member', ttlMs: MEMBER_TOKEN_TTL_MS, issuer: { kind: 'operator' }, memberId: null, projectId: null });
      const invitations = await get(handleInvitations, '/api/enrollment?limit=2');
      expect(invitations.body.invitations).toHaveLength(2);
      const rest = await get(handleInvitations, `/api/enrollment?limit=2&cursor=${encodeURIComponent(invitations.body.cursor!)}`);
      expect(rest.body.invitations).toHaveLength(1);
      expect(rest.body.cursor).toBeNull();

      for (let n = 0; n < 3; n += 1) await issueExternalGrant(db, { projectId: 'proj_1' }, `key ${n}`, OWNER, NOW + n);
      const ctx = { member: { id: OWNER, role: 'admin' }, params: { projectId: 'proj_1' } };
      const grants = await get(handleGrants, '/api/projects/proj_1/grants?limit=2', ctx);
      expect(grants.body.grants).toHaveLength(2);
      const last = await get(handleGrants, `/api/projects/proj_1/grants?limit=2&cursor=${encodeURIComponent(grants.body.cursor!)}`, ctx);
      expect(last.body.grants).toHaveLength(1);
      expect(last.body.cursor).toBeNull();
    });
  });
});

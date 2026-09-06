import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { insertCandidate, getCandidate } from '@myco-server-worker/core/skills.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPatch, OWNER_ENV, PRINCIPAL } from './helpers/owner.js';

const PATH = '/api/projects/proj_1/skill-candidates';

async function rig() {
  const fixture = sqliteEnv();
  fixture.sqlite.query("INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('agent_1','Myco','built-in',1,1)").run();
  for (const id of ['one', 'two']) await insertCandidate(fixture.db, { projectId: 'proj_1' }, {
    id, agentId: 'agent_1', topic: id, rationale: 'Repeated project evidence', confidence: 0.8, sourceIds: '[]', createdAt: 1,
  });
  const env = { ...fixture.env, ...OWNER_ENV };
  return { ...fixture, env, ask: (request: Request) => worker.fetch(request, env) };
}

describe('member skill candidate review', () => {
  it('pages deterministically and distinguishes invalid filters from empty results', async () => {
    const r = await rig();
    const first = await r.ask(await asOwner(`${PATH}?limit=1`));
    expect(await first.json()).toMatchObject({ candidates: [{ id: 'one', revision: 0 }], hasMore: true });
    const second = await r.ask(await asOwner(`${PATH}?limit=1&offset=1`));
    expect(await second.json()).toMatchObject({ candidates: [{ id: 'two' }], hasMore: false });
    const empty = await r.ask(await asOwner(`${PATH}?status=approved`));
    expect(await empty.json()).toMatchObject({ candidates: [], hasMore: false });
    for (const query of ['status=unknown', 'limit=0', 'offset=-1']) expect((await r.ask(await asOwner(`${PATH}?${query}`))).status).toBe(400);
  });

  it('attributes approval to the signed-in member and refuses a stale review', async () => {
    const r = await rig();
    const approved = await r.ask(await asOwnerPatch(`${PATH}/one`, { revision: 0, status: 'approved', memberId: 'forged' }));
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ reviewed: true, candidate: { status: 'approved', revision: 1, approvedBy: PRINCIPAL.id, reviewedBy: PRINCIPAL.id } });
    const stale = await r.ask(await asOwnerPatch(`${PATH}/one`, { revision: 0, status: 'dismissed' }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'conflict', candidate: { status: 'approved', revision: 1 } });
    expect((await getCandidate(r.db, { projectId: 'proj_1' }, 'one'))?.status).toBe('approved');
  });

  it('requires a member session and same-origin review and cannot invent approval state', async () => {
    const r = await rig();
    expect((await r.ask(new Request(`https://s${PATH}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } }))).status).toBe(401);
    const crossOrigin = await asOwnerPatch(`${PATH}/one`, { revision: 0, status: 'approved' });
    crossOrigin.headers.set('origin', 'https://elsewhere.example');
    expect((await r.ask(crossOrigin)).status).toBe(403);
    expect((await r.ask(await asOwnerPatch(`${PATH}/one`, { revision: 0, status: 'generated' }))).status).toBe(400);
    expect((await r.ask(await asOwnerPatch(`${PATH}/missing`, { revision: 0, status: 'approved' }))).status).toBe(404);
    expect((await r.ask(await asOwner('/api/projects/absent/skill-candidates'))).status).toBe(404);
  });
});

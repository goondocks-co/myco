/**
 * A person retires and restores a spore from the dashboard: the same lifecycle write the tools make, bound to the revision the page read and
 * recorded as the signed-in member's, refused for a member without the admin role.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, MEMBER_SUB, OWNER_ENV, ownerCookie, PRINCIPAL, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { insertSpore } from '@myco-server-worker/db/spores/records.js';
import { resolveSpore } from '@myco-server-worker/db/spores/lifecycle.js';

const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;
const SPORE = '/api/projects/proj_1/spores/sp1';

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(NOW);
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  const scope = { projectId: 'proj_1' };
  for (const id of ['sp1', 'sp2']) {
    await insertSpore(fixture.db, scope, { id, agentId: AGENT, sessionId: null, observationType: 'gotcha', content: `cobalt finding ${id}`, context: null,
      filePath: null, tags: null, contentHash: null, properties: null, author: null, createdAt: NOW });
  }
  const json = async (request: Request) => {
    const res = await worker.fetch(request, env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const get = async (path: string) => json(await asOwner(fixture.db, path));
  const post = async (path: string, body: unknown) => json(await asOwnerPost(fixture.db, path, body));
  const read = async () => (await get(SPORE)).body;
  const found = async () => ((await get('/api/projects/proj_1/search?q=cobalt&type=spore&mode=fts')).body.hits as { id: string }[]).map(hit => hit.id).sort();
  return { ...fixture, env, scope, get, post, read, found };
}

describe('retiring and restoring a spore from the dashboard', () => {
  it('refuses a retirement without a reason and leaves the spore current', async () => {
    const h = await harness();
    const { revision } = (await h.read()).spore;
    for (const reason of [undefined, '', '   ']) {
      expect((await h.post(`${SPORE}/retire`, { reason, revision })).status).toBe(400);
    }
    expect((await h.read()).spore.status).toBe('active');
  });

  it('retires with who, when and why, then restores the spore to search and the current list', async () => {
    const h = await harness();
    expect(await h.found()).toEqual(['sp1', 'sp2']);
    const retired = await h.post(`${SPORE}/retire`, { reason: 'The rule changed in the new release', revision: (await h.read()).spore.revision });
    expect(retired.status).toBe(200);
    expect(await h.read()).toMatchObject({
      spore: { status: 'obsolete' },
      resolution: { action: 'obsolete', author: PRINCIPAL.id, authorKind: 'member', reason: 'The rule changed in the new release', createdAt: expect.any(Number) },
    });
    expect(await h.found()).toEqual(['sp2']);
    expect(((await h.get('/api/projects/proj_1/spores?status=active')).body.spores as { id: string }[]).map(s => s.id)).toEqual(['sp2']);
    expect(((await h.get('/api/projects/proj_1/spores?status=obsolete')).body.spores as { id: string }[]).map(s => s.id)).toEqual(['sp1']);

    const restored = await h.post(`${SPORE}/restore`, { revision: retired.body.spore.revision });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ spore: { status: 'active' }, resolution: { action: 'restore', author: PRINCIPAL.id, authorKind: 'member' } });
    expect(await h.found()).toEqual(['sp1', 'sp2']);
    expect((await h.get('/api/projects/proj_1/spores?status=active')).body.total).toBe(2);
  });

  it('refuses a page that read an older revision and changes nothing', async () => {
    const h = await harness();
    const stale = (await h.read()).spore.revision;
    await h.post(`${SPORE}/retire`, { reason: 'Out of date', revision: stale });
    const before = await h.read();
    const again = await h.post(`${SPORE}/restore`, { revision: stale });
    expect({ status: again.status, error: again.body.error, message: again.body.message })
      .toEqual({ status: 409, error: 'spore_changed', message: expect.stringContaining('Reload the page and try again') });
    expect(await h.read()).toEqual(before);
  });

  it('refuses a member without the admin role and changes nothing', async () => {
    const h = await harness();
    seedMemberRoleAccount(h.sqlite);
    const { revision } = (await h.read()).spore;
    const res = await worker.fetch(new Request(`https://s${SPORE}/retire`, {
      method: 'POST', body: JSON.stringify({ reason: 'Not mine to retire', revision }),
      headers: { cookie: await ownerCookie(h.db, Date.now(), MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
    }), h.env);
    expect(res.status).toBe(403);
    expect((await h.read()).spore.status).toBe('active');
  });

  it('refuses to restore a replaced spore, which reads its replacement instead', async () => {
    const h = await harness();
    await resolveSpore(h.db, h.scope, { status: 'superseded', now: NOW, event: {
      id: 're1', agentId: AGENT, sporeId: 'sp1', action: 'supersede', newSporeId: 'sp2', reason: null, sessionId: null, author: null, createdAt: NOW,
    } });
    const before = await h.read();
    const res = await h.post(`${SPORE}/restore`, { revision: before.spore.revision });
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 409, error: 'spore_replaced' });
    expect(await h.read()).toEqual(before);
    expect(before.supersededBy).toEqual(['sp2']);
  });
});

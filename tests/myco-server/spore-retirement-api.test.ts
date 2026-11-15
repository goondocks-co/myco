import { settingsWriter } from '@myco-server-worker/core/settings.js';
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
import { writeSpore } from '@myco-server-worker/core/spore-admission.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { selectSporesForPrompt } from '@myco-server-worker/core/injection.js';
import { sessionWriteAdmission } from '@myco-server-worker/ingest/projections.js';
import { embedding_semanticSearch as semanticSearch } from '@myco-server-worker/read/catalog/embedding.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { indexFixture } from './helpers/vector-index.js';

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

  it('finds a restored spore by words at once, and serves it and finds it by meaning once its embedding is written again', async () => {
    const h = await harness();
    // Unrelated findings point away from the cobalt ones, so the prompt's matches stand out from the Project's other spores.
    const unrelated = ['parsers', 'ports', 'locales', 'retries', 'themes', 'queues', 'fonts', 'clocks'];
    for (const [i, topic] of unrelated.entries()) {
      await insertSpore(h.db, h.scope, { id: `other-${i}`, agentId: AGENT, sessionId: null, observationType: 'gotcha', content: `notes on ${topic}`, context: null,
        filePath: null, tags: null, contentHash: null, properties: null, author: null, createdAt: NOW });
    }
    const angle = (text: string) => text.includes('cobalt') ? 0 : 1.2 + unrelated.findIndex(topic => text.includes(topic)) * 0.25;
    const provider = { modelKey: 'restore-model', embed: async (text: string) => [Math.cos(angle(text)), Math.sin(angle(text))] };
    const semantic = { provider, vectors: cloudflareVectorStore(indexFixture()) };
    const reconcile = () => reconcileEmbedding({ db: h.db, blobs: h.bucket, ...semantic }, 'proj_1', NOW);
    for (let step = 0; step < 20 && (await reconcile()).phase !== 'settled'; step++);
    const byMeaning = async () => (await semanticSearch(h.db, h.scope, semantic, ['spore'], { query: 'cobalt' }, 10)).hits.map(hit => hit.id).filter(id => id.startsWith('sp')).sort();
    let prompts = 0;
    const served = async () => {
      const session = `restore-${++prompts}`;
      const selected = await selectSporesForPrompt(h.db, h.scope, { enabled: true, maxPerPrompt: 7 }, true, {
        sessionId: session, admission: sessionWriteAdmission({ projectId: 'proj_1', machineId: 'machine_1' }, session),
        promptId: `p${prompts}`, promptHash: `hash${prompts}`, prompt: 'Please help me configure the cobalt cache correctly.', now: NOW,
      }, async () => semantic);
      return selected.items.map(item => item.id).sort();
    };
    expect([await byMeaning(), await served()]).toEqual([['sp1', 'sp2'], ['sp1', 'sp2']]);

    const retired = await h.post(`${SPORE}/retire`, { reason: 'Out of date', revision: (await h.read()).spore.revision });
    expect([await byMeaning(), await served(), await h.found()]).toEqual([['sp2'], ['sp2'], ['sp2']]);
    expect((await h.post(`${SPORE}/restore`, { revision: retired.body.spore.revision })).status).toBe(200);
    expect([await h.found(), await byMeaning(), await served()]).toEqual([['sp1', 'sp2'], ['sp2'], ['sp2']]);

    await reconcile();
    expect([await byMeaning(), await served()]).toEqual([['sp1', 'sp2'], ['sp1', 'sp2']]);
  });

  it('reads the change committed last when several land at the same instant', async () => {
    const h = await harness();
    const at = { env: h.serverEnv, projectId: 'proj_1', now: NOW, principal: { kind: 'member' as const, memberId: PRINCIPAL.id, machineId: null } };
    await settingsWriter(h.db).setLeaf('import.spores_enabled', true, PRINCIPAL.id, NOW);
    expect(await writeSpore({ op: 'save', channel: 'import', id: 'dashboard-import', agent_id: AGENT, type: 'gotcha', content: 'dashboard import' }, at)).toMatchObject({ ok: false, classifier: 'no_machine_identity' });
    expect((await h.get('/api/projects/proj_1/spores/dashboard-import')).status).toBe(404);
    await writeSpore({ op: 'obsolete', id: 'sp1', reason: 'First retirement', expect_revision: 0, event_id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' }, at);
    await writeSpore({ op: 'restore', id: 'sp1', expect_revision: 1 }, at);
    expect((await h.read()).resolution).toMatchObject({ action: 'restore', author: PRINCIPAL.id, reason: null });
    await writeSpore({ op: 'obsolete', id: 'sp1', reason: 'Second retirement', expect_revision: 2, event_id: '00000000-0000-4000-8000-000000000000' }, at);
    expect((await h.read()).resolution).toMatchObject({ action: 'obsolete', reason: 'Second retirement' });
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

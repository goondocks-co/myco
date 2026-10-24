/**
 * The spore surface through the deployed entry.
 */
import { describe, expect, it } from 'bun:test';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';

const AGENT = 'agent_1';

async function harness() {
  const fixture = sqliteEnv();
  const now = Date.now();
  const t = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(now);
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, now);
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    await (await worker.fetch(memberPost(t.token, body, path), fixture.env)).json() as Record<string, unknown>;
  return { ...fixture, post };
}

const save = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, agentId: AGENT, observationType: 'gotcha', content: `content of ${id}`, ...over });

describe('POST /spores', () => {
  it('saves and reads back a spore with its lineage', async () => {
    const { post } = await harness();
    expect((await post('/spores/save', save('sp1'))).persisted).toBe(true);
    const got = await post('/spores/get', { id: 'sp1' });
    expect((got.spore as { id: string }).id).toBe('sp1');
    expect(got.supersededBy).toEqual([]);
  });

  it('lists with a total and reports the ceiling it clamps to', async () => {
    const { post } = await harness();
    await post('/spores/save', save('sp1'));
    await post('/spores/save', save('sp2', { observationType: 'decision' }));
    const all = await post('/spores/list', {});
    expect({ n: (all.spores as unknown[]).length, total: all.total }).toEqual({ n: 2, total: 2 });
    const filtered = await post('/spores/list', { observationType: 'decision' });
    expect({ n: (filtered.spores as unknown[]).length, total: filtered.total }).toEqual({ n: 1, total: 1 });
    expect(all.maxLimit).toBe(200);
    // A limit below one asks for a page, not for every spore the Project holds.
    const clamped = await post('/spores/list', { limit: -1 });
    expect({ n: (clamped.spores as unknown[]).length, total: clamped.total }).toEqual({ n: 1, total: 2 });
  });

  it('refuses a supersede that names no successor, which would record lineage nothing can read', async () => {
    const { post, sqlite } = await harness();
    await post('/spores/save', save('sp1'));
    const res = await post('/spores/resolve', { eventId: 're1', agentId: AGENT, sporeId: 'sp1', action: 'supersede', status: 'superseded' });
    expect({ persisted: res.persisted, coded: typeof res.code === 'string' }).toEqual({ persisted: false, coded: true });
    expect((sqlite.query(`SELECT status FROM spores WHERE id = 'sp1'`).get() as { status: string }).status).toBe('active');
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events`).get() as { c: number }).c).toBe(0);
  });

  it('resolves a supersede that names one, and reports it in the lineage', async () => {
    const { post } = await harness();
    await post('/spores/save', save('sp1'));
    await post('/spores/save', save('sp2'));
    expect(await post('/spores/resolve', { eventId: 're1', agentId: AGENT, sporeId: 'sp1', action: 'supersede', status: 'superseded', newSporeId: 'sp2' }))
      .toEqual({ persisted: true, resolved: true });
    expect((await post('/spores/get', { id: 'sp1' })).supersededBy).toEqual(['sp2']);
  });

  it('reports resolved:false for a spore this Project does not hold', async () => {
    const { post } = await harness();
    expect(await post('/spores/resolve', { eventId: 're1', agentId: AGENT, sporeId: 'absent', action: 'obsolete', status: 'obsolete' }))
      .toEqual({ persisted: true, resolved: false });
  });

  it('refuses an unknown status or action rather than storing one', async () => {
    const { post, sqlite } = await harness();
    await post('/spores/save', save('sp1'));
    for (const body of [
      { eventId: 're1', agentId: AGENT, sporeId: 'sp1', action: 'invented', status: 'obsolete' },
      { eventId: 're2', agentId: AGENT, sporeId: 'sp1', action: 'obsolete', status: 'invented' },
    ]) {
      expect((await post('/spores/resolve', body)).persisted).toBe(false);
    }
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events`).get() as { c: number }).c).toBe(0);
  });
});

it('member resolution defaults active, names stale and admits explicit editorial expectations', async () => {
  const { post, sqlite } = await harness();
  try {
    await post('/spores/save', save('guard'));
    const request = { eventId: 'guard-one', agentId: AGENT, sporeId: 'guard', action: 'obsolete', status: 'obsolete', expectRevision: 0 };
    expect(await post('/spores/resolve', request)).toEqual({ persisted: true, resolved: true });
    expect(await post('/spores/resolve', { ...request, eventId: 'guard-two', expectRevision: 1 }))
      .toMatchObject({ persisted: false, code: 'stale', status: 'obsolete', revision: 1 });
    expect(sqlite.query("SELECT id FROM resolution_events WHERE spore_id='guard'").all()).toEqual([{ id: 'guard-one' }]);
    expect(await post('/spores/resolve', { ...request, eventId: 'guard-two', expectStatus: 'obsolete', expectRevision: 1 }))
      .toEqual({ persisted: true, resolved: true });
    expect(await post('/spores/resolve', { ...request, expectRevision: 0 })).toEqual({ persisted: true, resolved: true, duplicate: true });
    expect(sqlite.query("SELECT revision FROM spores WHERE id='guard'").get()).toEqual({ revision: 2 });
  } finally { sqlite.close(); }
});

it('import history admits final or active status, checks revisions and refuses other states with the comparison', async () => {
  const { post, sqlite } = await harness();
  try {
    const request = { channel: 'import', agentId: AGENT, action: 'obsolete', status: 'obsolete', expectStatus: 'obsolete' };
    await post('/spores/save', save('import-active'));
    expect(await post('/spores/resolve', { ...request, eventId: 'wrong-revision', sporeId: 'import-active', expectRevision: 1 }))
      .toMatchObject({ persisted: false, code: 'stale', status: 'active', revision: 0,
        reason: 'source is active at revision 0; expected obsolete or active at revision 1' });
    expect(await post('/spores/resolve', { ...request, eventId: 'later-retirement', sporeId: 'import-active', expectRevision: 0 }))
      .toEqual({ persisted: true, resolved: true });
    await post('/spores/save', { ...save('import-terminal'), status: 'obsolete' });
    expect(await post('/spores/resolve', { ...request, expectStatus: undefined, eventId: 'fresh-history', sporeId: 'import-terminal' }))
      .toEqual({ persisted: true, resolved: true });
    await post('/spores/save', { ...save('import-other'), status: 'superseded' });
    expect(await post('/spores/resolve', { ...request, eventId: 'other-state', sporeId: 'import-other' }))
      .toMatchObject({ persisted: false, code: 'stale', status: 'superseded', revision: 0,
        reason: 'source is superseded at revision 0; expected obsolete or active' });
    await post('/spores/save', save('ordinary-active'));
    expect(await post('/spores/resolve', { ...request, channel: undefined, eventId: 'ordinary', sporeId: 'ordinary-active' }))
      .toMatchObject({ persisted: false, code: 'stale', status: 'active', revision: 0,
        reason: 'source is active at revision 0; expected obsolete' });
    expect(sqlite.query('SELECT id FROM resolution_events ORDER BY id').all())
      .toEqual([{ id: 'fresh-history' }, { id: 'later-retirement' }]);
  } finally { sqlite.close(); }
});

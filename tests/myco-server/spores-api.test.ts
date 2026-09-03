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

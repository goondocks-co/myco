/**
 * `POST /api/transcripts/reread`: an owner reads stored transcripts again after
 * a parser fix, by agent or by session (#1461).
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, asOwnerPost } from './helpers/owner.js';

function seed(e: ReturnType<typeof sqliteEnv>): void {
  e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1','s1','machine_1','mt_x',0,0)`);
  e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, parsed_offset)
                VALUES ('proj_1','tx_0123456789abcdef0123456789abcdef','s1','machine_1','cursor',100,1,0,0,'mt_x',100)`);
  // Retention pruned the first 40 bytes; the segment after them is still held.
  e.sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
                VALUES ('proj_1','tx_0123456789abcdef0123456789abcdef',40,60,?,'e40',0,0,'mt_x')`, ['a'.repeat(64)]);
}

const post = async (e: ReturnType<typeof sqliteEnv>, body: unknown) => {
  const res = await worker.fetch(await asOwnerPost('/api/transcripts/reread', body), { ...e.env, ...OWNER_ENV });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};

describe('POST /api/transcripts/reread', () => {
  it('rewinds every transcript an agent\'s parser reads, and answers how many', async () => {
    const e = sqliteEnv();
    seed(e);
    expect(await post(e, { agent: 'cursor' })).toEqual({ status: 200, body: { reread: 1 } });
    expect(e.sqlite.query('SELECT parsed_offset FROM transcripts').get()).toEqual({ parsed_offset: 40 });
  });

  it('rewinds one session', async () => {
    const e = sqliteEnv();
    seed(e);
    expect(await post(e, { projectId: 'proj_1', sessionId: 's1' })).toEqual({ status: 200, body: { reread: 1 } });
  });

  it('answers not found for a Project that does not exist, as every project-scoped owner route does, rewinding nothing', async () => {
    const e = sqliteEnv();
    seed(e);
    expect(await post(e, { projectId: 'proj_absent', sessionId: 's1' })).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(e.sqlite.query('SELECT parsed_offset FROM transcripts').get()).toEqual({ parsed_offset: 100 });
  });

  it('refuses an agent the Deployment parses no transcript for, a mixed selector and an empty one, rewinding nothing', async () => {
    const e = sqliteEnv();
    seed(e);
    for (const body of [{ agent: 'windsurf' }, { agent: 'cursor', projectId: 'proj_1', sessionId: 's1' }, {}, { projectId: 'proj_1' }]) {
      expect({ body, status: (await post(e, body)).status }).toEqual({ body, status: 400 });
    }
    expect(e.sqlite.query('SELECT parsed_offset FROM transcripts').get()).toEqual({ parsed_offset: 100 });
  });

  it('is refused without an owner session', async () => {
    const e = sqliteEnv();
    const res = await worker.fetch(new Request('https://s/api/transcripts/reread', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' }, body: '{"agent":"cursor"}' }), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(401);
  });
});

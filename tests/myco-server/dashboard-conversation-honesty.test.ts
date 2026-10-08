import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { turnDetail, type TurnDetail } from '@myco-server-worker/read/turns.js';
import { setPlanStatus } from '@myco-server-worker/read/plans.js';
import type { Page } from '@myco-server-worker/read/scope.js';
import { sqliteEnv, uuid } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';

function fixture() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
    VALUES ('proj_1','conversation','m1','tok_1',1,6000), ('proj_1','other','m1','tok_1',1,6000)`);
  const prompt = (id: number, parent: string | null = null, session = 'conversation', project = 'proj_1') => {
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, parent_prompt_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
      VALUES (?,?,?,?,?,?,'user','hash',?,?,'tok_1',?)`, [project, session, uuid(id), `p-${id}`, parent, `Prompt ${id}`, id, id, id]);
  };
  const reply = (id: number, parent: string, session = 'conversation', project = 'proj_1') => {
    e.sqlite.run(`INSERT INTO responses (project_id, session_id, response_id, event_id, prompt_id, text, content_hash, created_at, token_id, received_at)
      VALUES (?,?,?,?,?,?,'hash',?,'tok_1',?)`, [project, session, uuid(id), `r-${id}`, parent, `Reply ${id}`, id, id]);
  };
  const read = async <T,>(path: string): Promise<T> => {
    const res = await worker.fetch(await asOwner(e.db, path), { ...e.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    return await res.json() as T;
  };
  return { ...e, prompt, reply, read, base: '/api/projects/proj_1/sessions/conversation/turns' };
}

describe('dashboard conversation honesty', () => {
  it('gate 1643.1: retrieves all final records and bounded steering reply pages through scoped API continuations', async () => {
    const e = fixture();
    e.prompt(1);
    for (let i = 0; i < 51; i++) {
      e.prompt(100 + i, uuid(1));
      e.reply(1000 + i, uuid(1));
      for (let j = 0; j < 51; j++) e.reply(10000 + i * 100 + j, uuid(100 + i));
      e.sqlite.run(`INSERT INTO attachments (project_id, session_id, attachment_id, event_id, prompt_id, blob_key, media_type, byte_size, created_at, token_id, received_at)
        VALUES ('proj_1','conversation',?,?,?,'blob','image/png',1,?,'tok_1',?)`, [uuid(2000 + i), `a-${i}`, uuid(1), i, i]);
      e.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, prompt_id, created_at, updated_at, token_id, received_at)
        VALUES ('proj_1',?,'conversation',?,'m1','hash','draft',?, ?,?,'tok_1',?)`, [uuid(3000 + i), `pl-${i}`, uuid(1), i, i, i]);
    }
    e.prompt(99, null, 'other');
    e.reply(9999, uuid(1), 'other');
    const prepare = e.db.prepare.bind(e.db);
    let queries = 0;
    e.db.prepare = (...args) => { queries++; return prepare(...args); };
    const detail = await turnDetail(e.db, { projectId: 'proj_1' }, 'conversation', uuid(1));
    expect(queries).toBeLessThanOrEqual(9);
    expect(detail!.children).toHaveLength(50);
    expect(detail!.children.every((child) => child.responses.length === 50 && child.responsesCursor !== null)).toBe(true);
    const wire = await e.read<TurnDetail>(`${e.base}/${uuid(1)}`);
    for (const collection of ['responses', 'attachments', 'plans', 'children'] as const) {
      expect(wire[collection]).toHaveLength(50);
      expect(wire.cursors[collection]).not.toBeNull();
      const next = await e.read<Page<Record<string, unknown>>>(`${e.base}/${uuid(1)}?collection=${collection}&cursor=${encodeURIComponent(wire.cursors[collection]!)}`);
      expect(next.rows).toHaveLength(1);
      expect(next.cursor).toBeNull();
      const id = collection === 'responses' ? next.rows[0].responseId : collection === 'attachments' ? next.rows[0].attachmentId : collection === 'plans' ? next.rows[0].planKey : (next.rows[0].prompt as { promptId: string }).promptId;
      expect(id).toBe(uuid(({ responses: 1050, attachments: 2050, plans: 3050, children: 150 })[collection]));
    }
    const child = wire.children[0];
    const nextReply = await e.read<Page<{ responseId: string }>>(`${e.base}/${child.prompt.promptId}?collection=responses&cursor=${encodeURIComponent(child.responsesCursor!)}`);
    expect(nextReply.rows.map((r) => r.responseId)).toEqual([uuid(10050)]);
    expect(nextReply.cursor).toBeNull();
    for (const suffix of ['?collection=responses&cursor=bad', '?collection=invalid']) {
      expect((await worker.fetch(await asOwner(e.db, `${e.base}/${uuid(1)}${suffix}`), { ...e.env, ...OWNER_ENV })).status).toBe(400);
    }
    expect((await worker.fetch(await asOwner(e.db, `${e.base}/${uuid(99)}?collection=responses`), { ...e.env, ...OWNER_ENV })).status).toBe(404);
  });

  it('gate 1643.1: plan edits and equal-time inserts cannot move displayed identities into a continuation', async () => {
    const e = fixture();
    e.prompt(1);
    const addPlan = (id: number) => e.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, prompt_id, title, content, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1',?,'conversation',?,'m1','hash','draft',?,'Plan','Initial content',1,1,'tok_1',1)`, [uuid(id), `plan-${id}`, uuid(1)]);
    for (let i = 1; i <= 51; i++) addPlan(3000 + i);
    const first = await e.read<TurnDetail>(`${e.base}/${uuid(1)}`);
    expect(first.plans).toHaveLength(50);
    expect(await setPlanStatus(e.db, { projectId: 'proj_1' }, uuid(3001), 'completed', 'member', 100)).toBe(true);
    e.sqlite.run('UPDATE plans SET content = ?, created_at = 0 WHERE plan_key = ?', ['Edited content', uuid(3001)]);
    e.sqlite.run('UPDATE plans SET created_at = 0 WHERE plan_key = ?', [uuid(3051)]);
    addPlan(3052);
    const next = await e.read<Page<{ planKey: string }>>(`${e.base}/${uuid(1)}?collection=plans&cursor=${encodeURIComponent(first.cursors.plans!)}`);
    expect(next.rows.map((plan) => plan.planKey)).toEqual([uuid(3051), uuid(3052)]);
    expect(next.cursor).toBeNull();
    expect(new Set([...first.plans, ...next.rows].map((plan) => plan.planKey)).size).toBe(52);
    const refreshed = await e.read<TurnDetail>(`${e.base}/${uuid(1)}`);
    expect(refreshed.plans[0]).toMatchObject({ planKey: uuid(3001), status: 'completed', content: 'Edited content' });
  });

  it('gate 1643.2: reads newest turns directly and resolves named turns across a 5,001-turn session', async () => {
    const e = fixture();
    e.sqlite.transaction(() => { for (let i = 1; i <= 5001; i++) e.prompt(i); })();
    const first = await e.read<Page<{ promptId: string }>>(`${e.base}?order=desc&limit=200`);
    expect(first.rows).toHaveLength(200);
    expect(first.rows[0].promptId).toBe(uuid(5001));
    expect(first.rows[199].promptId).toBe(uuid(4802));
    const older = await e.read<Page<{ promptId: string }>>(`${e.base}?order=desc&limit=200&cursor=${encodeURIComponent(first.cursor!)}`);
    expect(older.rows[0].promptId).toBe(uuid(4801));
    for (const id of [1, 4801, 4802, 5001]) {
      const named = await e.read<Page<{ promptId: string }>>(`${e.base}?turn=${uuid(id)}`);
      expect(named.rows.map((r) => r.promptId)).toEqual([uuid(id)]);
      expect(named.cursor).toBeNull();
    }
    e.prompt(6000, uuid(1));
    expect((await e.read<Page<{ promptId: string }>>(`${e.base}?turn=${uuid(6000)}`)).rows.map((r) => r.promptId)).toEqual([uuid(1)]);
    e.prompt(6001, null, 'other');
    expect((await e.read<Page<unknown>>(`${e.base}?turn=${uuid(6001)}`)).rows).toEqual([]);
  });
});

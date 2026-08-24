/**
 * L3 — the Project a request names is resolved into existence, within a bound.
 *
 * Member Access spans the Deployment, so a member reaching a Project the server has
 * never seen is ordinary. The bound is what keeps that from being a way to fill a
 * table the byte quota does not cover.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MAX_PROJECTS, MEMBER_TOKEN_BYTE_QUOTA, PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { resolveProject } from '@myco-server-worker/ingest/projects.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

const post = (token: string, project: string, n: number) => new Request('https://s/events', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'cf-connecting-ip': '1.2.3.4', [PROJECT_HEADER]: project, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) },
  body: JSON.stringify(envelope({ eventId: uuid(n), payload: { promptId: uuid(500 + n), text: 'hi', origin: 'user' } })),
});

const rig = async () => {
  const e = sqliteEnv();
  const now = Date.now();
  const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const count = () => (e.sqlite.query(`SELECT COUNT(*) c FROM projects`).get() as { c: number }).c;
  return { e, now, token: t.token, count };
};

describe('project resolution', () => {
  it('creates a Project the Deployment has never seen and lands the event in it, without any prior registration', async () => {
    const r = await rig();
    const before = r.count();
    expect(r.e.sqlite.query(`SELECT 1 FROM projects WHERE project_id = 'proj_new'`).get()).toBeNull();

    expect((await json(await worker.fetch(post(r.token, 'proj_new', 1), r.e.env))).persisted).toBe(true);

    expect(r.count()).toBe(before + 1);
    expect(r.e.sqlite.query(`SELECT project_id, name FROM projects WHERE project_id = 'proj_new'`).get())
      .toEqual({ project_id: 'proj_new', name: 'proj_new' });
    // The event is in the Project it named, not in some fallback.
    expect(r.e.sqlite.query(`SELECT project_id FROM events`).all()).toEqual([{ project_id: 'proj_new' }]);
  });

  it('resolves an existing Project without creating anything or disturbing what it holds', async () => {
    const r = await rig();
    const created = (r.e.sqlite.query(`SELECT created_at FROM projects WHERE project_id = 'proj_1'`).get() as { created_at: number }).created_at;
    const before = r.count();

    for (const n of [2, 3]) expect((await json(await worker.fetch(post(r.token, 'proj_1', n), r.e.env))).persisted).toBe(true);

    expect(r.count()).toBe(before);
    expect((r.e.sqlite.query(`SELECT created_at FROM projects WHERE project_id = 'proj_1'`).get() as any).created_at).toBe(created);
  });

  it('refuses past the Deployment ceiling by name, storing nothing, and keeps serving the Projects it already holds', async () => {
    const r = await rig();
    // Fill to the ceiling directly: driving MAX_PROJECTS requests through the entry
    // would prove the same thing far more slowly.
    const rows = Array.from({ length: MAX_PROJECTS - r.count() }, (_, i) => `('fill_${i}','fill_${i}',0)`).join(',');
    r.e.sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES ${rows}`).run();
    expect(r.count()).toBe(MAX_PROJECTS);

    const refused = await worker.fetch(post(r.token, 'proj_over', 4), r.e.env);
    expect({ status: refused.status, body: await refused.json() }).toEqual({
      status: 200,
      body: { persisted: false, code: 'project_limit', reason: 'deployment is at its project limit' },
    });
    expect(r.count()).toBe(MAX_PROJECTS);
    expect((r.e.sqlite.query(`SELECT COUNT(*) c FROM events`).get() as any).c).toBe(0);

    // A Project the Deployment already holds still works: the ceiling bounds creation, not use.
    expect((await json(await worker.fetch(post(r.token, 'proj_1', 5), r.e.env))).persisted).toBe(true);
  });

  it('spends no Project seat on a request it refuses without touching storage: a credential at its quota creates nothing', async () => {
    // Resolution is the first thing on the admission path that can write, so it runs
    // after every refusal the caller cannot retry into success. A quota refusal is one
    // of those: the credential is done, and it must not consume a Deployment seat on
    // the way to being told so.
    const r = await rig();
    r.e.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE machine_id = 'machine_1'`).run(MEMBER_TOKEN_BYTE_QUOTA - 1);
    const before = r.count();

    const res = await worker.fetch(post(r.token, 'proj_quota_refused', 9), r.e.env);
    expect(await res.json()).toEqual({ persisted: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(r.count()).toBe(before);
    expect(r.e.sqlite.query(`SELECT 1 FROM projects WHERE project_id = 'proj_quota_refused'`).get()).toBeNull();
  });

  it('never passes the ceiling under concurrent creation, and admits every racer that names one Project', async () => {
    const r = await rig();
    const rows = Array.from({ length: MAX_PROJECTS - r.count() - 1 }, (_, i) => `('fill_${i}','fill_${i}',0)`).join(',');
    r.e.sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES ${rows}`).run();
    expect(r.count()).toBe(MAX_PROJECTS - 1);

    // Five requests, one seat. The seat is claimed once and the rest are refused.
    const outcomes = await Promise.all([0, 1, 2, 3, 4].map((i) => resolveProject(r.e.db, `race_${i}`, r.now)));
    expect(outcomes.filter((o) => o.resolved)).toHaveLength(1);
    expect(r.count()).toBe(MAX_PROJECTS);

    // Five requests naming ONE Project: all resolve, and it is created once.
    const e2 = await rig();
    const same = await Promise.all([0, 1, 2, 3, 4].map(() => resolveProject(e2.e.db, 'shared', e2.now)));
    expect(same.every((o) => o.resolved)).toBe(true);
    expect((e2.e.sqlite.query(`SELECT COUNT(*) c FROM projects WHERE project_id = 'shared'`).get() as any).c).toBe(1);
  });
});

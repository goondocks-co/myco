import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { bootstrapOwnership } from '@myco-server-worker/db/identity/ownership.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_S9A } from '@myco-server-worker/db/schema-vNEXT-s9a.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { activity_activityFeed as activityFeed } from '@myco-server-worker/read/catalog/activity.js';
import { plans_pageProjectPlans as pageProjectPlans } from '@myco-server-worker/read/catalog/plans.js';
import { tombstoneSession as acceptDeletion } from '@myco-server-worker/core/tombstones.js';
import { plans_planTotals as planTotals } from '@myco-server-worker/read/catalog/plans.js';
import { advanceSessionDeletions } from '@myco-server-worker/db/sessions/deletion.js';
import { issueMemberToken } from './helpers/member-token.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { sqliteD1 } from './helpers/d1.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, PRINCIPAL, asOwner } from './helpers/owner.js';
import { drainSessionDeletions } from './helpers/session-deletion.js';

const PROJECT = 'proj_1';
const SCOPE = { projectId: PROJECT };
const opened: Database[] = [];
afterEach(() => { for (const sqlite of opened.splice(0)) sqlite.close(); });

/** A Deployment with an owner reading the dashboard routes and a member saving plans through `myco_plans`, as each client does. */
async function rig() {
  const e = sqliteEnv();
  opened.push(e.sqlite);
  await bootstrapOwnership(e.db, PRINCIPAL.id, PRINCIPAL.id, '0', Date.now());
  const member = await issueMemberToken(e.db, { memberId: PRINCIPAL.id, machineId: 'machine_1' }, Date.now());
  const get = async (path: string) => {
    const res = await worker.fetch(await asOwner(e.db, path), { ...e.env, ...OWNER_ENV });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const plans = async (args: Record<string, unknown>) => {
    const res = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(member.token),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_plans', arguments: { project: PROJECT, ...args } } }) }), e.env);
    return ((await res.json()) as any).result?.structuredContent?.result;
  };
  const save = async (planKey: string, extra: Record<string, unknown> = {}) =>
    (await plans({ op: 'save', session_id: 'sess_a', plan_key: planKey, title: `Plan ${planKey}`, content: `# ${planKey}\n- [x] one\n- [ ] two`, ...extra })).id as string;
  /** A status edit made after every earlier write, so it is the newest edit by the clock as well as by order. */
  const setStatus = async (id: string, status: string) => { await Bun.sleep(2); return plans({ op: 'save', id, session_id: 'sess_a', status }); };
  return { ...e, get, plans, save, setStatus };
}

/** Every row a list answers, a page at a time from `first`, following the cursor `next` names on each answer. */
async function walk(read: (cursor: string | null) => Promise<{ rows: string[]; cursor: string | null }>, from: string | null = null): Promise<string[]> {
  const seen: string[] = [];
  let cursor = from;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = await read(cursor);
    seen.push(...page.rows);
    if (page.cursor === null) return seen;
    cursor = page.cursor;
  }
  throw new Error('the list did not end');
}

describe('plan lists', () => {
  it('carry a plan\'s metadata, preview and progress but never its body, which the plan\'s own read answers', async () => {
    const r = await rig();
    const id = await r.save('lists');
    const across = (await r.get('/api/plans')).body.plans[0];
    const inProject = (await r.get(`/api/projects/${PROJECT}/plans`)).body.plans[0];
    const listed = (await r.plans({ op: 'list' })).plans[0];
    for (const row of [across, inProject, listed]) {
      expect({ hasBody: 'content' in row, preview: row.preview, progress: row.progress })
        .toEqual({ hasBody: false, preview: '# lists - [x] one - [ ] two', progress: '1/2' });
    }
    expect((await r.get(`/api/projects/${PROJECT}/plans/${id}`)).body.plan).toMatchObject({ content: '# lists\n- [x] one\n- [ ] two', progress: '1/2' });
    expect(await r.plans({ op: 'get', id })).toMatchObject({ content: '# lists\n- [x] one\n- [ ] two', progress: '1/2' });
  });

  it('page past an edit: unedited plans neither repeat nor drop, and an edited plan moves to the head, where a fresh first page shows it', async () => {
    const r = await rig();
    const ids: string[] = [];
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) ids.push(await r.save(key));
    const pageAcross = async (cursor: string | null) => {
      const { body } = await r.get(`/api/plans?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      return { rows: (body.plans as { planKey: string }[]).map(row => row.planKey), cursor: body.cursor as string | null };
    };
    const pageInProject = async (cursor: string | null) => {
      const { body } = await r.get(`/api/projects/${PROJECT}/plans?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
      return { rows: (body.plans as { planKey: string }[]).map(row => row.planKey), cursor: body.cursor as string | null };
    };
    for (const page of [pageAcross, pageInProject]) {
      // A plan already read is edited: the later pages hold each plan not yet read exactly once.
      const first = await page(null);
      await r.setStatus(first.rows[0]!, 'in_progress');
      const rest = await walk(page, first.cursor);
      expect(rest.sort()).toEqual(ids.filter(id => !first.rows.includes(id)).sort());
      // A plan not yet read is edited: the later pages hold every other unread plan exactly once and not the edited
      // one, which moved to the head; a fresh first page leads with it.
      const head = await page(null);
      const unread = (await walk(page, head.cursor)).at(-1)!;
      await r.setStatus(unread, 'completed');
      const after = await walk(page, head.cursor);
      expect(after.sort()).toEqual(ids.filter(id => !head.rows.includes(id) && id !== unread).sort());
      expect((await page(null)).rows[0]).toBe(unread);
    }
  });

  it('refuse a cursor issued before the list\'s order or by another list, naming the call to make instead', async () => {
    const r = await rig();
    await r.save('a');
    await r.save('b');
    for (const old of ['p1:1:proj_1:a', 'p2:1:proj_1:a', '1:a']) {
      const refused = await r.get(`/api/plans?cursor=${encodeURIComponent(old)}`);
      expect({ old, status: refused.status, reason: refused.body.reason }).toEqual({ old, status: 400, reason: expect.stringContaining('request the first page again') });
    }
    const local = await r.get(`/api/projects/${PROJECT}/plans?cursor=${encodeURIComponent('plans1:1:proj_1:a')}`);
    expect({ status: local.status, reason: local.body.reason }).toEqual({ status: 400, reason: expect.stringContaining('request the first page again') });
    expect(await r.plans({ op: 'list', status: 'active', cursor: 'p1:1:proj_1:a' })).toEqual({
      ok: false, error: expect.stringContaining('Next call: myco_plans {"op":"list","status":"active"}'),
    });
  });

  it('answer each status total from the counters, equal to the rows the status pages through', async () => {
    const r = await rig();
    const statuses = ['active', 'active', 'in_progress', 'completed', 'completed', 'completed', 'abandoned'];
    for (const [i, status] of statuses.entries()) {
      const id = await r.save(`plan-${i}`);
      if (status !== 'active') await r.setStatus(id, status);
    }
    const totals = (await r.get(`/api/plans?project=${PROJECT}`)).body.totals as Record<string, number>;
    const counted: Record<string, number> = {};
    for (const status of new Set(statuses)) {
      counted[status] = (await walk(async (cursor) => {
        const { body } = await r.get(`/api/plans?project=${PROJECT}&status=${status}&limit=1${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
        return { rows: (body.plans as { planKey: string }[]).map(row => row.planKey), cursor: body.cursor as string | null };
      })).length;
    }
    expect(totals).toEqual(counted);
    expect(counted).toEqual({ active: 2, in_progress: 1, completed: 3, abandoned: 1 });
  });
});

describe('the activity feed', () => {
  const feedPage = (r: Awaited<ReturnType<typeof rig>>) => async (cursor: string | null) => {
    const { body } = await r.get(`/api/projects/${PROJECT}/activity?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`);
    return { rows: (body.items as { type: string; id: string }[]).map(item => `${item.type}:${item.id}`), cursor: body.nextCursor as string | null };
  };

  it('pages past an edit: unedited records neither repeat nor drop, and an edited plan moves to the head, where a fresh first page shows it', async () => {
    const r = await rig();
    for (const key of ['a', 'b', 'c', 'd', 'e']) await r.save(key);
    const page = feedPage(r);
    const everything = await walk(page);
    expect(everything).toContain('session:sess_a');
    const first = await page(null);
    const edited = first.rows.find(row => row.startsWith('plan:'))!;
    await r.setStatus(edited.slice('plan:'.length), 'in_progress');
    const rest = await walk(page, first.cursor);
    expect(rest.sort()).toEqual(everything.filter(row => !first.rows.includes(row)).sort());
    expect((await page(null)).rows[0]).toBe(edited);
    const head = await page(null);
    const unread = (await walk(page, head.cursor)).find(row => row.startsWith('plan:'))!;
    await r.setStatus(unread.slice('plan:'.length), 'completed');
    expect(await walk(page, head.cursor)).not.toContain(unread);
    expect((await page(null)).rows[0]).toBe(unread);
    const refused = await r.get(`/api/projects/${PROJECT}/activity?cursor=${encodeURIComponent('plans1:1:proj_1:a')}`);
    expect({ status: refused.status, reason: refused.body.reason }).toEqual({ status: 400, reason: expect.stringContaining('request the first page again') });
  });

  it('stops listing a deleted session and its plans, and the plan lists stop listing them too', async () => {
    const r = await rig();
    const id = await r.save('doomed');
    expect(await walk(feedPage(r))).toEqual(expect.arrayContaining([`plan:${id}`, 'session:sess_a']));
    await acceptDeletion({ db: r.db }, SCOPE, 'sess_a', PRINCIPAL.id, Date.now());
    expect(await planTotals(r.db, { all: true })).toEqual({ state: 'building' });
    expect(await planTotals(r.db, { all: false, projectIds: [PROJECT] })).toEqual({ state: 'building' });
    expect(await planTotals(r.db, { projectId: PROJECT })).toEqual({ state: 'building' });
    expect(await activityFeed(r.db, SCOPE)).toMatchObject({ items: [], building: true });
    await advanceSessionDeletions(r.db, Date.now(), 1);
    expect(await planTotals(r.db, { all: true })).toEqual({ state: 'ready', value: {} });
    expect(await activityFeed(r.db, SCOPE)).toMatchObject({ items: [], building: false });
    await drainSessionDeletions({ db: r.db }, Date.now());
    expect(await walk(feedPage(r))).toEqual([]);
    expect((await r.get('/api/plans')).body.plans).toEqual([]);
    expect((await pageProjectPlans(r.db, SCOPE))!.rows).toEqual([]);
  });
});

describe('a Deployment upgraded with existing plans and records', () => {
  it('says it is building, then lists their progress and their activity once catch-up has added them', async () => {
    const sqlite = new Database(':memory:');
    opened.push(sqlite);
    const db = sqliteD1(sqlite);
    await applySchemaSteps(db, SCHEMA_STEPS.filter(step => step.version < NEXT_S9A));
    sqlite.run("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_1','One',1)");
    sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','older','m','t',10,10)`);
    sqlite.run(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
      VALUES('proj_1','older-plan','older','e','m','Older','- [x] one'||char(10)||'- [ ] two','h','active',20,20,'t',20)`);
    await applySchemaSteps(db);

    const before = (await activityFeed(db, SCOPE))!;
    expect({ building: before.building, items: before.items }).toEqual({ building: true, items: [] });
    expect((await pageProjectPlans(db, SCOPE))!.rows.map(row => [row.planKey, row.progress])).toEqual([['older-plan', null]]);

    for (let round = 0; round < 20 && (await catchUpProjections(db, { clock: () => 0 })).more; round += 1) { /* drain */ }
    const after = (await activityFeed(db, SCOPE))!;
    expect({ building: after.building, items: after.items.map(item => `${item.type}:${item.id}`) }).toEqual({ building: false, items: ['plan:older-plan', 'session:older'] });
    expect((await pageProjectPlans(db, SCOPE))!.rows.map(row => [row.planKey, row.progress, row.preview])).toEqual([['older-plan', '1/2', '- [x] one - [ ] two']]);
  });
});

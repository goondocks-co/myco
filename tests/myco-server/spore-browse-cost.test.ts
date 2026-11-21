/**
 * A filtered spore page reads about what it lists: one author's long history, or thousands of spores written in the
 * same instant, cost a page what an unfiltered page costs, and a page narrowed by origin costs the same however many
 * curated spores the Project holds, measured in rows the store reads.
 */
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { listSporeOriginPage, listSporePage, listSporePageAcross } from '@myco-server-worker/core/spores.js';
import type { OriginFilter } from '@myco-server-worker/db/spores/origins.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const HISTORY = 2_500;
const AT = 1_700_000_000_000;
let mf: Miniflare;
let measured: ReturnType<typeof measuredStore>;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  const d1 = await mf.getD1Database('DB');
  await d1.batch([
    d1.prepare("INSERT INTO projects (project_id, name, created_at) VALUES ('p', 'p', 1), ('q', 'q', 1)"),
    d1.prepare("INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('a', 'a', 'built-in', 1, 0)"),
    d1.prepare("INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('p', 's1', 'm', 't', 1, 1), ('p', 's2', 'm', 't', 1, 1)"),
  ]);
  const seed = (sql: string) => d1.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ${HISTORY - 1}) ${sql}`).run();
  // One author's history, each spore at its own instant, beside spores of other authors.
  await seed(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, author, created_at)
    SELECT 'p', printf('own%05d', i), 'a', 's2', 'decision', 'superseded', 'body', 'run_long', ${AT} + i * 1000 FROM k`);
  // A group written in one instant, matching every structured filter at once.
  await seed(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, author, created_at)
    SELECT 'p', printf('tie%05d', i), 'a', 's1', 'gotcha', 'active', 'body', 'run_other', ${AT + 5_000_000} FROM k`);
  await seed(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, author, created_at)
    SELECT 'q', printf('far%05d', i), 'a', NULL, 'gotcha', 'active', 'body', 'run_far', ${AT + 5_000_000} FROM k`);
  measured = measuredStore(d1);
}, 120_000);
afterAll(async () => { await mf.dispose(); });

/** Rows read for the first page and for the page after it, each 25 spores. */
async function cost(read: (cursor?: string) => Promise<{ rows: unknown[]; cursor: string | null } | null>) {
  measured.reset();
  const first = await read();
  const firstRows = measured.reads();
  measured.reset();
  const next = await read(first!.cursor!);
  return { listed: [first!.rows.length, next!.rows.length], reads: Math.max(firstRows, measured.reads()) };
}

it('reads a bounded page for every filter a list takes, one author\'s history and a tied instant included', async () => {
  const scope = { projectId: 'p' };
  const project = (filters: Record<string, unknown>) => cost((cursor) => listSporePage(measured.db, scope, { ...filters, limit: 25, ...(cursor === undefined ? {} : { cursor }) }));
  const across = (filters: Record<string, unknown>) => cost((cursor) => listSporePageAcross(measured.db, { all: true }, { ...filters, limit: 25, ...(cursor === undefined ? {} : { cursor }) }));
  const plain = await project({});
  const shapes = {
    plain,
    author: await project({ author: 'run_long' }),
    status: await project({ status: 'active' }),
    rareStatus: await project({ status: 'superseded' }),
    type: await project({ observationType: 'gotcha' }),
    session: await project({ sessionId: 's1' }),
    acrossStatus: await across({ status: 'superseded' }),
    acrossType: await across({ observationType: 'decision' }),
  };
  for (const [shape, measuredCost] of Object.entries(shapes)) {
    expect({ shape, listed: measuredCost.listed, bounded: measuredCost.reads <= plain.reads * 3 + 30 })
      .toEqual({ shape, listed: [25, 25], bounded: true });
  }
  // A history-sized read would cost thousands of rows; a page costs tens.
  expect(plain.reads).toBeLessThan(200);
}, 120_000);

it('reads a selected Project\'s page across Projects by its own history, whatever newer spores another Project holds, and walks a set once', async () => {
  const across = (set: { all: false; projectIds: string[] }, filters: Record<string, unknown>) =>
    cost((cursor) => listSporePageAcross(measured.db, set, { ...filters, limit: 25, ...(cursor === undefined ? {} : { cursor }) }));
  const plain = await cost((cursor) => listSporePage(measured.db, { projectId: 'p' }, { limit: 25, ...(cursor === undefined ? {} : { cursor }) }));
  // Project q holds 2,500 spores newer than most of p's; the dashboard's selected-Project list never walks them.
  const shapes = {
    selected: await across({ all: false, projectIds: ['p'] }, {}),
    selectedStatus: await across({ all: false, projectIds: ['p'] }, { status: 'superseded' }),
    selectedType: await across({ all: false, projectIds: ['p'] }, { observationType: 'decision' }),
    selectedWindow: await across({ all: false, projectIds: ['p'] }, { createdFrom: AT, createdTo: AT + 86_400_000 }),
    pair: await across({ all: false, projectIds: ['p', 'q'] }, { status: 'active' }),
  };
  for (const [shape, measuredCost] of Object.entries(shapes)) {
    expect({ shape, listed: measuredCost.listed, bounded: measuredCost.reads <= plain.reads * 3 + 30 })
      .toEqual({ shape, listed: [25, 25], bounded: true });
  }
  // A walk of a named set lists every spore of its Projects once, newest first across them.
  const walked: string[] = [];
  for (let cursor: string | undefined, page = 0; page < 40; page += 1) {
    const listed = (await listSporePageAcross(measured.db, { all: false, projectIds: ['p', 'q'] }, { observationType: 'gotcha', limit: 200, ...(cursor === undefined ? {} : { cursor }) }))!;
    walked.push(...listed.rows.map((row) => `${row.projectId}/${row.id}`));
    if (listed.cursor === null) break;
    cursor = listed.cursor;
  }
  expect({ n: walked.length, unique: new Set(walked).size }).toEqual({ n: HISTORY * 2, unique: HISTORY * 2 });
}, 120_000);

it('reads an origin-filtered page and its total at the same cost whether a Project holds sixty or six hundred of each origin', async () => {
  const d1 = await mf.getD1Database('DB');
  /** `n` spores merged from two, `n` rewritten from one and `n` saved, in Project `project`, through the tables curation writes. */
  const seed = async (project: string, n: number) => {
    const rows = (sql: string) => d1.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ${n - 1}) ${sql}`).run();
    await d1.prepare(`INSERT INTO projects (project_id, name, created_at) VALUES ('${project}', '${project}', 1)`).run();
    for (const [kind, sources] of [['mrg', ['a', 'b']], ['rew', ['a']]] as const) {
      await rows(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) SELECT '${project}', printf('${kind}%05d', i), 'a', 'wisdom', 'active', 'body', ${AT} + i * 1000 FROM k`);
      await rows(`INSERT INTO spore_curation_units (project_id, id, kind, created_at, member_count) SELECT '${project}', printf('u${kind}%05d', i), 'answer', ${AT} + i * 1000, ${sources.length + 1} FROM k`);
      await rows(`INSERT INTO spore_curation_unit_members (project_id, unit_id, spore_id, role, after_json) SELECT '${project}', printf('u${kind}%05d', i), printf('${kind}%05d', i), 'output', '{}' FROM k`);
      for (const source of sources) {
        await rows(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) SELECT '${project}', printf('${kind}%05d${source}', i), 'a', 'gotcha', 'consolidated', 'body', ${AT} + i * 1000 - 1 FROM k`);
        await rows(`INSERT INTO resolution_events (project_id, id, agent_id, spore_id, new_spore_id, action, created_at) SELECT '${project}', printf('e${kind}%05d${source}', i), 'a', printf('${kind}%05d${source}', i), printf('${kind}%05d', i), 'consolidate', ${AT} FROM k`);
        await rows(`INSERT INTO spore_curation_unit_members (project_id, unit_id, spore_id, role, event_ids, after_json) SELECT '${project}', printf('u${kind}%05d', i), printf('${kind}%05d${source}', i), 'source', json_array(printf('e${kind}%05d${source}', i)), '{}' FROM k`);
      }
    }
    await rows(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) SELECT '${project}', printf('sav%05d', i), 'a', 'gotcha', 'active', 'body', ${AT} + i * 1000 + 1 FROM k`);
  };
  const [small, large] = [60, 600] as const;
  await seed('few', small); await seed('many', large);
  const page = (project: string, filter: OriginFilter) => cost(async (cursor) => {
    const listed = await listSporeOriginPage(measured.db, { projectId: project }, { ...filter, limit: 25, ...(cursor === undefined ? {} : { cursor }) });
    return listed === null || 'building' in listed ? null : listed;
  });
  const shapes: Record<string, OriginFilter> = { curated: { origin: 'curated' }, merged: { minSources: 2 }, rewrittenOrMore: { minSources: 1, status: 'active' }, saved: { origin: 'saved', status: 'active' } };
  for (const [shape, filter] of Object.entries(shapes)) {
    const [few, many] = [await page('few', filter), await page('many', filter)];
    expect({ shape, listed: [few.listed, many.listed], bounded: many.reads <= few.reads + 10 }).toEqual({ shape, listed: [[25, 25], [25, 25]], bounded: true });
  }
  const totals = await Promise.all([{ origin: 'curated' as const }, { minSources: 2 }, { origin: 'saved' as const, status: 'active' }]
    .map(async (filter) => (await listSporeOriginPage(measured.db, { projectId: 'many' }, filter)) as { total: number; rows: { origin?: string; sources?: number }[] }));
  expect(totals.map((answer) => answer.total)).toEqual([large * 2, large, large]);
  expect([totals[1]!.rows[0]?.origin, totals[1]!.rows[0]?.sources]).toEqual(['curated', 2]);
}, 120_000);

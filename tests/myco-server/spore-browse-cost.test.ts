/**
 * A filtered spore page reads about what it lists: one author's long history, or thousands of spores written in the
 * same instant, cost a page what an unfiltered page costs, measured in rows the store reads.
 */
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { listSporePage, listSporePageAcross } from '@myco-server-worker/core/spores.js';
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

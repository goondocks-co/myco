/**
 * A search costs D1 the same when ten times the records match it: every window it ranks is full at both sizes, in a
 * Project's search and across Projects, for every shape a caller asks, its later pages, a search by time, the backlog it
 * reports, and a write it indexes. And D1 answers the widest search a caller may ask.
 */
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { MAX_NAMED_PROJECTS, type ProjectSet } from '@myco-server-worker/read/scope.js';
import { searchAcross, searchDeployment } from '@myco-server-worker/core/search.js';
import { pendingSearchBlobs, searchBacklog } from '@myco-server-worker/db/search/blob-index.js';
import { SEARCH_WINDOW, type SearchAnswer, type SearchOptions } from '@goondocks/myco-shared/search-types';
import { createProject } from '@myco-server-worker/db/storage/projects.js';
import { schemaD1Root } from './helpers/schema-template.js';
import { d1TwoScale, eachUnit, expectTwoScale, type CostCase, type CostRun } from './helpers/two-scale.js';

const PROJECTS = ['proj_0', 'proj_1', 'proj_2'];
/** Units of the corpus: each adds a matching spore, plan, session and turn card to the first Project. */
const SIZES = [SEARCH_WINDOW + 100, (SEARCH_WINDOW + 100) * 10] as const;
const NOW = 1_800_000_000_000;
const ALL: ProjectSet = { all: true };
const NAMED: ProjectSet = { all: false, projectIds: ['proj_0', 'proj_1'] };
const envOf = (db: RelationalStore) => ({ db }) as unknown as ServerEnv;
type Ask = (db: RelationalStore, opts: SearchOptions, reader?: string) => Promise<SearchAnswer | Omit<SearchAnswer, 'hits'>>;
const REACHES: Record<string, Ask> = {
  project: (db, opts, reader = 'member:cost') => searchDeployment(envOf(db), { projectId: 'proj_0' }, opts, reader, NOW),
  all: (db, opts, reader = 'member:cost') => searchAcross(envOf(db), ALL, opts, reader, NOW),
  named: (db, opts, reader = 'member:cost') => searchAcross(envOf(db), NAMED, opts, reader, NOW),
};
const SHAPES: Record<string, SearchOptions> = {
  one: { query: 'cobalt', mode: 'fts' },
  spores: { query: 'cobalt', mode: 'fts', type: 'spore' },
  words: { query: 'cobalt plan', mode: 'fts' },
  plansRare: { query: 'cobalt zqxrare', mode: 'fts', type: 'plan' },
  plansCommon: { query: 'cobalt plan', mode: 'fts', type: 'plan' },
  filtered: { query: 'cobalt', mode: 'fts', status: 'active', observation_type: 'gotcha', since: 1, until: 2_000_000_000 },
  session: { query: 'cobalt', mode: 'fts', session_id: 's1' },
  released: { query: 'cobalt', mode: 'fts', release_state: 'released', release_confidence: 'high' },
  anyWord: { query: 'cobalt zqxrare', mode: 'fts', match: 'any', type: 'spore' },
  /** Every match is a Codex session's, so this filter rejects the whole window. */
  rejecting: { query: 'cobalt', mode: 'fts', agent: 'claude' },
  rejectingByTime: { query: 'cobalt', mode: 'fts', type: 'spore', order: 'time', branch: 'other' },
};

async function setup(db: RelationalStore) {
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
  for (const project of PROJECTS) {
    await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
    await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,branch,title)
      VALUES(?,'s1','m','t',1,1,'codex','main','cobalt session')`).bind(project).run();
    await db.prepare(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
      VALUES(?,'rare','s1','e','m','plan','cobalt plan zqxrare','h','active',1000,1000,'t',1)`).bind(project).run();
  }
}

/** Each unit is a matching spore (every third with the word in its line), plan, titled session and turn card of the first Project. */
async function grow(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO spores(project_id,id,agent_id,session_id,observation_type,status,content,agent_line,created_at)
    SELECT 'proj_0','sp-'||i,'agent','s1','gotcha','active','cobalt body '||i,CASE WHEN i%3=0 THEN 'cobalt line' END,1000000+i*1000 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
    SELECT 'proj_0','pl-'||i,'s1','e-'||i,'m','plan','cobalt plan '||i,'h','active',1000000+i*1000,1,'t',1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,branch,title)
    SELECT 'proj_0','other-'||i,'m','t',1000000+i*1000,1,'codex','main','cobalt session '||i FROM n`);
  await eachUnit(db, from, to, `INSERT INTO turn_cards(project_id,session_id,turn_key,state,card,created_at)
    SELECT 'proj_0','s1','t-'||i,'carded','cobalt turn '||i,1000000+i*1000 FROM n`);
}

/**
 * A first page and the pages that follow it: the second stores the ranking, the third reads it. Each size reads as a
 * reader of its own, so the rankings one reader holds (at most `SEARCH_WINDOWS_PER_READER`) are the same at both.
 */
function pagedCases(reach: string, ask: Ask, opts: SearchOptions): CostCase[] {
  const cursors: Record<number, string | null> = {};
  const next = (at: CostRun, answer: { nextCursor: string | null }) => { cursors[at.scale] = answer.nextCursor; };
  const page = (at: CostRun) => ({ ...opts, limit: 20, ...(cursors[at.scale] ? { cursor: cursors[at.scale]! } : {}) });
  const reader = (at: CostRun) => `member:cost-${reach}-${at.scale}`;
  return [
    { name: `${reach} search, first page`, run: async (db, at) => { cursors[at.scale] = null; next(at, await ask(db, page(at), reader(at))); } },
    { name: `${reach} search, second page`, run: async (db, at) => next(at, await ask(db, page(at), reader(at))) },
    { name: `${reach} search, third page`, run: async (db, at) => next(at, await ask(db, page(at), reader(at))) },
  ];
}

const cases: CostCase[] = [
  ...Object.entries(REACHES).flatMap(([reach, ask]) => Object.entries(SHAPES)
    .map(([shape, opts]): CostCase => ({ name: `${reach} search, ${shape}`, run: (db) => ask(db, opts) }))),
  ...Object.entries(REACHES).flatMap(([reach, ask]) => pagedCases(reach, ask, SHAPES.one!)),
  ...pagedCases('rejecting', REACHES.project!, SHAPES.rejecting!),
  ...pagedCases('conversation by time', REACHES.project!, { query: 'cobalt', mode: 'fts', type: 'card', session_id: 's1', order: 'time' }),
];

it('a search, its later pages and a search by time cost D1 the same as the records that match grow, in every reach and shape', async () => {
  expectTwoScale(await d1TwoScale({ sizes: SIZES, setup, grow, cases }));
}, 600_000);

it('the backlog a search and Health report, and a write the index follows, cost D1 the same as the plan bodies grow', async () => {
  let edits = 0;
  expectTwoScale(await d1TwoScale({
    sizes: SIZES,
    setup,
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        SELECT 'proj_'||(i%3),printf('%064d',i),10,'text/plain','t',1000,'0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b' FROM n`);
      await eachUnit(db, from, to, `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,blob_key,content_hash,status,created_at,updated_at,token_id,received_at)
        SELECT 'proj_'||(i%3),'spilled-'||i,'s1','e-'||i,'m','spilled',NULL,printf('%064d',i),'h','active',1000,1,'t',1 FROM n`);
      await db.prepare(`UPDATE search_blobs SET state = 'indexed' WHERE state = 'pending' AND blob_key <> printf('%064d', 0)`).run();
      await grow(db, from, to);
    },
    cases: [
      ...Object.entries({ project: 'proj_0', all: ALL, named: NAMED, deployment: undefined } as const)
        .map(([reach, scope]): CostCase => ({ name: `backlog of ${reach}`, run: (db) => pendingSearchBlobs(db, scope) })),
      { name: 'backlog for Health', run: (db) => searchBacklog(db) },
      { name: 'a spore edit', run: (db) => db.prepare("UPDATE spores SET content = ? WHERE project_id = 'proj_0' AND id = 'sp-7'").bind(`cobalt edited ${edits++}`).run() },
    ],
  }));
}, 600_000);

it('D1 answers a search naming the most Projects and words with every filter, and the page that continues it', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  try {
    const db = await mf.getD1Database('DB') as unknown as RelationalStore;
    const most: ProjectSet = { all: false, projectIds: Array.from({ length: MAX_NAMED_PROJECTS }, (_, i) => `proj_${i}`) };
    for (const projectId of most.projectIds) await createProject(db, projectId, projectId, 1);
    const opts: SearchOptions = {
      query: Array.from({ length: 16 }, (_, i) => `term${i}`).join(' '), mode: 'fts', status: 'active', session_id: 's', observation_type: 'gotcha',
      since: 1, until: 2, release_state: 'released', release_confidence: 'high', agent: 'codex', branch: 'main', limit: 100,
    };
    // A card has no status and is no spore, so a conversation's search by time carries every other filter.
    const { status: _status, observation_type: _observationType, ...conversation } = opts;
    for (const answer of [
      await searchAcross(envOf(db), most, opts, 'member:cost'), await searchAcross(envOf(db), ALL, opts, 'member:cost'),
      await searchDeployment(envOf(db), { projectId: 'proj_0' }, opts, 'member:cost'),
      await searchAcross(envOf(db), most, { ...conversation, type: 'card', order: 'time' }, 'member:cost'),
      await searchDeployment(envOf(db), { projectId: 'proj_0' }, { ...opts, match: 'any' }, 'member:cost'),
    ]) expect(answer).toMatchObject({ hits: [], nextCursor: null });
  } finally { await mf.dispose(); }
}, 60_000);

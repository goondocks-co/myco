/**
 * A search costs the same on D1 when the Projects hold ten times the records that do not match it, in a Project's
 * search and across Projects, with and without planner statistics; and D1 answers the widest search a caller may ask.
 */
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { MAX_NAMED_PROJECTS, type ProjectSet } from '@myco-server-worker/read/scope.js';
import { search_searchAcross as searchAcross, search_searchProject as searchProject } from '@myco-server-worker/read/catalog/search.js';
import { type SearchOptions } from '@goondocks/myco-shared/search-types';
import { createProject } from '@myco-server-worker/db/storage/projects.js';
import { schemaD1Root } from './helpers/schema-template.js';
import { d1TwoScale, eachUnit, expectReportedWalk, expectTwoScale, type CaseCost, type CostCase } from './helpers/two-scale.js';

const PROJECTS = ['proj_0', 'proj_1', 'proj_2'];
/** Sizes of the corpus, in units. */
const SIZES = [600, 6_000] as const;
/** Records of each kind, in each Project, that a search for "title" matches. */
const MATCHES = 4;
const ALL: ProjectSet = { all: true };
const NAMED: ProjectSet = { all: false, projectIds: ['proj_0', 'proj_1'] };
const REACHES: Record<string, (db: RelationalStore, opts: SearchOptions) => Promise<unknown>> = {
  project: (db, opts) => searchProject(db, { projectId: 'proj_0' }, opts),
  all: (db, opts) => searchAcross(db, ALL, opts),
  named: (db, opts) => searchAcross(db, NAMED, opts),
};
/** A cursor as a search by time issues one: the last match of a page, in the order of the record's time, id and Project. */
const cursorFor = (type: string) => btoa(JSON.stringify({ type, created_at: 1000, id: 'p', project_id: 'proj_0' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SHAPES: Record<string, SearchOptions> = {
  one: { query: 'title' },
  terms: { query: 'title two three' },
  filtered: { query: 'title two', status: 'active', observation_type: 'gotcha', since: 1, until: 2_000_000_000 },
  session: { query: 'title', session_id: 's1' },
  released: { query: 'title', release_state: 'released', release_confidence: 'high' },
  conversation: { query: 'title two', type: 'prompt', session_id: 's1', order: 'time' },
  conversationNextPage: { query: 'title two', type: 'prompt', session_id: 's1', order: 'time', cursor: cursorFor('prompt') },
  repliesNextPage: { query: 'title', type: 'response', session_id: 's1', order: 'time', cursor: cursorFor('response') },
};

async function setup(db: RelationalStore) {
  await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
  for (const project of PROJECTS) {
    await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
    await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,branch,title)
      VALUES(?,'s1','m','t',1,1,'codex','main','title of the session')`).bind(project).run();
    await db.prepare("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES(?,'s1','live',1,1)").bind(project).run();
    await eachUnit(db, 0, MATCHES, `INSERT INTO spores(project_id,id,agent_id,session_id,observation_type,status,content,created_at)
      SELECT ?3,'match-'||i,'agent','s1','gotcha','active','title two three '||i,1000+i FROM n`, project);
    await eachUnit(db, 0, MATCHES, `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
      SELECT ?3,'match-'||i,'s1','e-'||i,'m','title two','three','h','active',1000+i,1000+i,'t',1 FROM n`, project);
    await eachUnit(db, 0, MATCHES, `INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at)
      SELECT ?3,'s1',1,'turn-'||i,'turn-'||i,i,'user',1000+i FROM n`, project);
    await eachUnit(db, 0, MATCHES, `INSERT INTO turn_cards(project_id,session_id,turn_key,state,card,created_at)
      SELECT ?3,'s1','turn-'||i,'carded','title two three '||i,1000+i FROM n`, project);
  }
}

/** Each unit is a session with its document, a spore, a plan, a turn card and a turn in the matched session, in one of the Projects, none of which a search for "title" matches. */
async function grow(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,title)
    SELECT 'proj_'||(i%3),'other-'||i,'m','t',1,1,'codex','alpha beta '||i FROM n`);
  await eachUnit(db, from, to, `INSERT INTO spores(project_id,id,agent_id,session_id,observation_type,status,content,created_at)
    SELECT 'proj_'||(i%3),'other-'||i,'agent','other-'||i,'gotcha','active','alpha beta gamma '||i,2000+i FROM n`);
  await eachUnit(db, from, to, `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
    SELECT 'proj_'||(i%3),'other-'||i,'other-'||i,'e-'||i,'m','alpha','beta gamma','h','active',2000+i,2000+i,'t',1 FROM n`);
  await eachUnit(db, from, to, `INSERT INTO turn_cards(project_id,session_id,turn_key,state,card,created_at)
    SELECT 'proj_'||(i%3),'other-'||i,'turn-'||i,'carded','alpha beta gamma '||i,2000+i FROM n`);
  // The conversation a hit's turn is named from: more turns in the matched session, and a document for every session.
  await eachUnit(db, from, to, `INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at)
    SELECT 'proj_'||(i%3),'s1',1,'other-turn-'||i,'other-turn-'||i,100+i,'user',2000+i FROM n`);
  await eachUnit(db, from, to, `INSERT INTO session_documents(project_id,session_id,state,generation,updated_at)
    SELECT 'proj_'||(i%3),'other-'||i,'live',1,1 FROM n`);
}

const cases: CostCase[] = Object.entries(REACHES).flatMap(([reach, search]) => Object.entries(SHAPES)
  .map(([shape, opts]): CostCase => ({ name: `${reach} search, ${shape}`, run: (db) => search(db, opts) })));

it('a search costs D1 the same as the records it does not match grow, in every reach and shape', async () => {
  expectTwoScale(await d1TwoScale({ sizes: SIZES, setup, grow, cases }));
}, 240_000);

it('a search costs D1 the same as the finished search backlog grows', async () => {
  const costs = await d1TwoScale({
    sizes: SIZES,
    setup,
    grow: (db, from, to) => eachUnit(db, from, to, `INSERT INTO search_blob_queue(project_id,blob_key,complete)
      SELECT 'proj_'||(i%3),printf('%064d',i),1 FROM n`),
    cases: Object.entries(REACHES).map(([reach, search]): CostCase => ({ name: `${reach} search`, run: (db) => search(db, SHAPES.one!) })),
  });
  // Under planner statistics a Project's backlog count walks that Project's finished queue rows instead of the pending
  // ones (#2174): a third of the units are that Project's.
  const walks = (cost: CaseCost) => cost.statistics !== 'none' && cost.name === 'project search';
  expectTwoScale(costs.filter((cost) => !walks(cost)));
  for (const cost of costs.filter(walks)) expectReportedWalk(cost, { issue: '#2174', perUnit: 0.5, units: SIZES[1] - SIZES[0] });
}, 120_000);

it('D1 answers a search naming the most Projects and terms with every filter, and the page that continues it', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  try {
    const db = await mf.getD1Database('DB') as unknown as RelationalStore;
    const most: ProjectSet = { all: false, projectIds: Array.from({ length: MAX_NAMED_PROJECTS }, (_, i) => `proj_${i}`) };
    for (const projectId of most.projectIds) await createProject(db, projectId, projectId, 1);
    const opts: SearchOptions = {
      query: Array.from({ length: 16 }, (_, i) => `term${i}`).join(' '), status: 'active', session_id: 's', observation_type: 'gotcha',
      since: 1, until: 2, release_state: 'released', release_confidence: 'high', limit: 100,
    };
    // A prompt has no status and is no spore, so the page that continues a conversation carries every other filter.
    const { status: _status, observation_type: _observationType, ...conversation } = opts;
    const paged: SearchOptions = { ...conversation, type: 'prompt', order: 'time', cursor: cursorFor('prompt') };
    for (const answer of [
      await searchAcross(db, most, opts), await searchAcross(db, ALL, opts), await searchProject(db, { projectId: 'proj_0' }, opts),
      await searchAcross(db, most, paged), await searchProject(db, { projectId: 'proj_0' }, paged),
    ]) expect(answer).toMatchObject({ results: [] });
  } finally { await mf.dispose(); }
}, 60_000);

/**
 * A refused text filter names the search to make instead. Following that call, as MCP or over HTTP, selects exactly
 * the records the list would have read with that text; a narrowing search cannot apply is named in the refusal.
 */
import { expect, it } from 'bun:test';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';
import {
  search_searchProject as searchProject,
  search_searchAcross as searchAcross,
} from '@myco-server-worker/read/catalog/search.js';
import type { SearchOptions } from '@goondocks/myco-shared/search-types';
import { definitionOf } from '@myco-server-worker/mcp/definitions.js';
import { RUN_DEFINITIONS } from '@myco-server-worker/mcp/run-definitions.js';
import { validateInput } from '@myco-server-worker/mcp/validate.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const DAY = 86_400_000;
const AT = 20 * DAY;

async function harness() {
  const f = sqliteEnv();
  const now = Date.now();
  const t = await issueMemberToken(f.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  f.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', 1)`).run();
  f.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)`).run();
  for (const session of ['s1', 's2']) {
    f.sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', ?, 'machine_1', 'tok', 1, 1)`).run(session);
  }
  // Every combination of session, status, type, day and text, so a dropped narrowing selects a different set.
  let n = 0;
  for (const session of ['s1', 's2']) for (const status of ['active', 'obsolete']) for (const type of ['decision', 'gotcha'])
    for (const day of [-1, 0, 1]) for (const text of ['cobalt keys', 'other words']) {
      f.sqlite.query(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, created_at) VALUES ('proj_1', ?, 'agent_1', ?, ?, ?, ?, ?)`)
        .run(`sp_${n++}`, session, type, status, text, AT + day * DAY + 5_000);
    }
  const post = async (path: string, body: unknown) => await (await worker.fetch(memberPost(t.token, body, path), f.env)).json() as Record<string, unknown>;
  const ids = (where: string) => (f.sqlite.query(`SELECT id FROM spores WHERE project_id = 'proj_1' AND content LIKE '%cobalt%' AND ${where} ORDER BY id`).all() as { id: string }[]).map((r) => r.id);
  /** Every match of a search, page after page. */
  const searched = async (options: SearchOptions) => {
    const found: string[] = [];
    for (let cursor: string | undefined; ;) {
      const answer = await searchProject(f.db, { projectId: 'proj_1' }, { ...options, limit: 100, ...(cursor === undefined ? {} : { cursor }) });
      found.push(...answer.results.map((r) => r.id));
      if (answer.cursor === null) return found.sort();
      cursor = answer.cursor;
    }
  };
  return { ...f, post, ids, searched };
}

/** The `myco_search` arguments a refusal names, as search options. */
function namedCall(text: string): SearchOptions {
  const [, json] = /Next call: myco_search (\{.*?\})(?:;|\.$)/.exec(text) ?? [];
  if (json === undefined) throw new Error(`no myco_search call in: ${text}`);
  const { query, project: _project, ...rest } = JSON.parse(json) as Record<string, unknown>;
  return { query: String(query), ...rest } as SearchOptions;
}

/** The HTTP search a refusal names, as search options. */
function namedPath(text: string): SearchOptions {
  const [, path] = /over HTTP, GET (\S+?)\.$/.exec(text) ?? [];
  const url = new URL(path!, 'https://s');
  const options: Record<string, unknown> = { query: url.searchParams.get('q') };
  for (const [key, value] of url.searchParams) if (key !== 'q' && key !== 'project') options[key] = ['since', 'until'].includes(key) ? Number(value) : value;
  return options as unknown as SearchOptions;
}

it('names a search that selects what the member list would, every narrowing and the widened window kept', async () => {
  const h = await harness();
  const refused = await h.post('/spores/list', { search: 'cobalt', status: 'obsolete', observationType: 'decision', sessionId: 's1', since: AT + 1 });
  const reason = String(refused.reason);
  const expected = h.ids(`status = 'obsolete' AND observation_type = 'decision' AND session_id = 's1' AND created_at >= ${AT}`);
  expect(expected).toHaveLength(2);
  expect(await h.searched(namedCall(reason))).toEqual(expected);
  expect(await h.searched(namedPath(reason))).toEqual(expected);
});

it('names what search cannot narrow by, on the member list and both tools, and keeps the rest', async () => {
  const h = await harness();
  const member = String((await h.post('/spores/list', { search: 'cobalt', agentId: 'agent_1', includeActive: false, status: 'active' })).reason);
  expect(member).toContain('Search cannot narrow by agentId or includeActive');
  expect(await h.searched(namedCall(member))).toEqual(h.ids("status = 'active'"));
  const refusal = (definition: Parameters<typeof validateInput>[0], input: Record<string, unknown>) => {
    try { validateInput(definition, input); } catch (error) { return (error as Error).message; }
    throw new Error('the call was not refused');
  };
  const tool = refusal(definitionOf('myco_spores')!, { op: 'list', search: 'cobalt', agent_id: 'agent_1', status: 'obsolete', observation_type: 'gotcha' });
  expect(tool).toContain('Search cannot narrow by agent_id');
  expect(await h.searched(namedCall(tool))).toEqual(h.ids("status = 'obsolete' AND observation_type = 'gotcha'"));
  // The run's inventory lists active spores when it names no status; its search keeps that.
  const run = refusal(RUN_DEFINITIONS.find((d) => d.name === 'myco_run_spores')!, { op: 'list', search: 'cobalt', observation_type: 'decision' });
  expect(await h.searched(namedCall(run))).toEqual(h.ids("status = 'active' AND observation_type = 'decision'"));
});

it('names the reach a search across every Project loses as myco_search, and its HTTP search keeps every Project', async () => {
  const f = sqliteEnv();
  const env = { ...f.env, ...OWNER_ENV };
  f.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)`).run();
  for (const project of ['proj_1', 'proj_2']) {
    f.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, 1)`).run(project, project);
    for (let i = 0; i < 3; i += 1) f.sqlite.query(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES (?, ?, 'agent_1', 'gotcha', 'active', 'cobalt keys', ?)`).run(project, `${project}_${i}`, AT + i);
  }
  const res = await worker.fetch(new Request('https://s/api/spores?q=cobalt', { headers: { cookie: await ownerCookie(f.db, Date.now()), 'cf-connecting-ip': '1.2.3.4' } }), env);
  const reason = String((await res.json() as { reason: string }).reason);
  expect(res.status).toBe(400);
  // The named call reads one Project, the caller's current one, and the refusal says so rather than passing it off as every Project.
  expect(reason).toContain('Search cannot narrow by every Project (myco_search reads one Project, the current one when it names none; the HTTP search reads them all)');
  const call = namedCall(reason);
  expect(await searchProject(f.db, { projectId: 'proj_1' }, { ...call, limit: 100 }).then((a) => a.results.map((r) => r.id).sort())).toEqual(['proj_1_0', 'proj_1_1', 'proj_1_2']);
  // The HTTP search it names reads every Project.
  const [, path] = /over HTTP, GET (\S+?)\.$/.exec(reason) ?? [];
  expect(new URL(path!, 'https://s').pathname).toBe('/api/search');
  const http = namedPath(reason);
  expect((await searchAcross(f.db, { all: true }, { ...http, limit: 100 })).results.map((r) => `${r.projectId}/${r.id}`).sort())
    .toEqual(['proj_1/proj_1_0', 'proj_1/proj_1_1', 'proj_1/proj_1_2', 'proj_2/proj_2_0', 'proj_2/proj_2_1', 'proj_2/proj_2_2']);
});

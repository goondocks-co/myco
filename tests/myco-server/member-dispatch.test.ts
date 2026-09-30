/**
 * A member starting a task by hand (`POST /api/harness/dispatch`), and reading which tasks a Project has turned on.
 *
 * Every member may start a task. A member who is not an admin starts at most `memberRunsPerDay` runs of a task in a
 * rolling day, across every Project, checked in the write that records the run; past it the dispatch answers 429 with
 * when the day's oldest run leaves the window, and writes nothing. A fresh run over unmoved input is an admin's alone.
 * Admins start runs uncapped. Runs the clock starts and runs a member starts never count against each other's ceiling.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_PRINCIPAL, MEMBER_SUB, OWNER_ENV, PRINCIPAL, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import { CLOCK_ACTOR, MEMBER_RUNS_PER_DAY_DEFAULT, memberRunsPerDay, readScheduleFacts } from '@myco-server-worker/core/scheduled-tasks.js';
import { taskFactsKey } from '@myco-server-worker/core/runs.js';

const DAY = 86_400_000;
const TASK = 'extract-curate';

const INNER = Symbol('inner statement');

/**
 * The D1 binding with every answer held back a few milliseconds, so requests sent together interleave at each of their
 * statements as they do against the hosted store. Each statement still runs whole and alone.
 */
function slowed(d1: any): any {
  const pause = () => new Promise((resolve) => setTimeout(resolve, 3));
  const wrap = (statement: any): any => ({
    [INNER]: statement,
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    first: async (...a: unknown[]) => { await pause(); return statement.first(...a); },
    all: async () => { await pause(); return statement.all(); },
    run: async () => { await pause(); return statement.run(); },
    raw: async (...a: unknown[]) => { await pause(); return statement.raw(...a); },
  });
  return { ...d1, prepare: (sql: string) => wrap(d1.prepare(sql)), batch: async (statements: any[]) => { await pause(); return d1.batch(statements.map((st) => st[INNER] ?? st)); } };
}

function harness(settings: Record<string, unknown> = {}, opts: { slow?: boolean } = {}) {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV, ...(opts.slow === true ? { MYCO_DB: slowed(fixture.env.MYCO_DB) } : {}) };
  seedMemberRoleAccount(fixture.sqlite);
  for (const [leaf, value] of Object.entries(settings)) {
    fixture.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 1, 'test')`).run(leaf, JSON.stringify(value));
  }
  const send = async (method: string, path: string, sub: string | undefined, body?: unknown) => {
    const res = await worker.fetch(new Request(`https://s${path}`, {
      method,
      headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() as Record<string, any> };
  };
  const dispatch = (sub: string | undefined, body: Record<string, unknown>) => send('POST', '/api/harness/dispatch', sub, body);
  const asMember = (body: Record<string, unknown>) => dispatch(MEMBER_SUB, body);
  const asAdmin = (body: Record<string, unknown>) => dispatch(undefined, body);
  const runs = () => fixture.sqlite.query(`SELECT id, project_id AS projectId, task, json_extract(dispatch_spec, '$.actor') AS actor, queued_at AS queuedAt FROM agent_runs ORDER BY queued_at, id`).all() as Array<{ id: string; projectId: string; task: string; actor: string | null; queuedAt: number }>;
  return { fixture, env, send, asMember, asAdmin, runs };
}

/** `agent.tasks` giving a member `perDay` runs of the task a day. */
const memberCap = (perDay: number) => ({ 'agent.tasks': { [TASK]: { schedule: { memberRunsPerDay: perDay } } } });

describe('a member starting a task', () => {
  it('queues the run and records who started it, which the run list names', async () => {
    const h = harness();
    const started = await h.asMember({ task: TASK, projectId: 'proj_1' });
    expect(started).toMatchObject({ status: 200, body: { queued: true, task: TASK, projectId: 'proj_1' } });
    expect(h.runs().map((r) => r.actor)).toEqual([MEMBER_PRINCIPAL.id]);
    const listed = await h.send('GET', '/api/projects/proj_1/runs', MEMBER_SUB);
    expect(listed.body.rows[0]).toMatchObject({ id: started.body.runId, startedBy: MEMBER_PRINCIPAL.id });
  });

  it('refuses a member past the day\'s ceiling with when it resets, and writes no run', async () => {
    const h = harness(memberCap(2));
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(200);
    expect((await h.asMember({ task: TASK, projectId: 'proj_2' })).status).toBe(200);
    const [first] = h.runs();
    const refused = await h.asMember({ task: TASK, projectId: 'proj_1' });
    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({ error: 'daily_limit', task: TASK, perDay: 2, resetsAt: first!.queuedAt + DAY });
    expect(Number(refused.retryAfter)).toBeGreaterThan(DAY / 1000 - 120);
    expect(h.runs()).toHaveLength(2);
  });

  it('counts a rolling day: a run that entered a day ago no longer counts', async () => {
    const h = harness(memberCap(1));
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(200);
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(429);
    h.fixture.sqlite.run(`UPDATE agent_runs SET queued_at = queued_at - ${DAY + 1000}`);
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(200);
  });

  it('holds the ceiling when dispatches arrive at once: the write that records a run is what checks it', async () => {
    const h = harness(memberCap(2), { slow: true });
    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => h.asMember({ task: TASK, projectId: i % 2 === 0 ? 'proj_1' : 'proj_2' })));
    expect(answers.map((a) => a.status).sort()).toEqual([200, 200, 429, 429, 429, 429]);
    expect(h.runs()).toHaveLength(2);
  });

  it('leaves admins uncapped, and records who started each of their runs too', async () => {
    const h = harness(memberCap(1));
    for (let i = 0; i < 3; i += 1) expect((await h.asAdmin({ task: TASK, projectId: 'proj_1' })).status).toBe(200);
    expect(h.runs().map((r) => r.actor)).toEqual([PRINCIPAL.id, PRINCIPAL.id, PRINCIPAL.id]);
    // An admin's runs are not the member's: the member still has its one.
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(200);
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(429);
  });

  it('never counts the clock\'s runs against a member, nor a member\'s against the clock', async () => {
    const h = harness(memberCap(2));
    const now = Date.now();
    h.fixture.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)`);
    for (let i = 0; i < 3; i += 1) {
      h.fixture.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, started_at, dispatch_spec)
                            VALUES ('proj_1', ?, 'agent_1', ?, 'completed', ?, ?, ?)`, [`run_clock_${i}`, TASK, now - 1000 * (i + 1), now - 1000 * (i + 1), JSON.stringify({ actor: CLOCK_ACTOR })]);
    }
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(200);
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(200);
    expect((await h.asMember({ task: TASK, projectId: 'proj_1' })).status).toBe(429);
    const facts = await readScheduleFacts(h.fixture.serverEnv, [TASK], Date.now(), 'proj_1');
    expect(facts.runs.get(taskFactsKey('proj_1', TASK))?.entriesSince).toBe(3);
  });

  it('refuses a fresh run to a member by a code the page can word, and admits it for an admin', async () => {
    const h = harness();
    expect(await h.asMember({ task: TASK, projectId: 'proj_1', fresh: true })).toMatchObject({ status: 403, body: { error: 'fresh_needs_admin' } });
    expect(h.runs()).toHaveLength(0);
    expect((await h.asAdmin({ task: TASK, projectId: 'proj_1', fresh: true })).status).toBe(200);
  });

  it('lets a member read which tasks a Project has turned on, and never change them', async () => {
    const h = harness();
    const read = await h.send('GET', '/api/projects/proj_1/capabilities', MEMBER_SUB);
    expect(read.status).toBe(200);
    expect(read.body).toHaveProperty('capabilities');
    const write = await h.send('PUT', '/api/projects/proj_1/capabilities/vault_evolution', MEMBER_SUB, { enabled: true });
    expect(write).toMatchObject({ status: 403, body: { error: 'not_admin' } });
  });
});

describe('how many runs of a task a member may start in a day', () => {
  it('is the owner\'s memberRunsPerDay, else the task\'s daily ceiling, else the default', async () => {
    const plain = harness();
    expect(await memberRunsPerDay(plain.fixture.serverEnv, 'extract-curate')).toBe(12);
    expect(await memberRunsPerDay(plain.fixture.serverEnv, 'canopy-map')).toBe(4);
    expect(await memberRunsPerDay(plain.fixture.serverEnv, 'title-summary')).toBe(MEMBER_RUNS_PER_DAY_DEFAULT);
    const tuned = harness({ 'agent.tasks': { 'extract-curate': { schedule: { maxRunsPerDay: 6 } }, 'title-summary': { schedule: { memberRunsPerDay: 0 } } } });
    expect(await memberRunsPerDay(tuned.fixture.serverEnv, 'extract-curate')).toBe(6);
    expect(await memberRunsPerDay(tuned.fixture.serverEnv, 'title-summary')).toBe(0);
    expect(await tuned.asMember({ task: 'title-summary', projectId: 'proj_1' })).toMatchObject({ status: 429, body: { error: 'daily_limit', perDay: 0, resetsAt: null } });
  });

  it('refuses a memberRunsPerDay that is not a whole number of 0 or more', async () => {
    const h = harness();
    const refused = await h.send('PUT', '/api/settings/agent.tasks', undefined, { value: { [TASK]: { schedule: { memberRunsPerDay: -1 } } } });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('memberRunsPerDay');
  });
});

/**
 * The bounded backfill of imported sessions (#1203): off until an operator
 * turns it on, newest first over untitled imported sessions with parsed
 * material, one `claim` attempt per session through the live titling gate,
 * inside the block's interval and the Deployment-wide daily ceiling, and
 * stoppable through the same override the operator's switch writes.
 */
import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import {
  backfillImportedTitles, titleSession, titlingBackfillPolicy, titlingBackfillProgress, TITLING_BACKFILL_ACTOR, TITLING_BACKFILL_BATCH, TITLING_TASK,
} from '@myco-server-worker/core/titling.js';
import { TITLING_BACKFILL_SCHEDULE, SERVER_JOBS } from '@myco-server-worker/core/jobs.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import worker from '@myco-server-worker/index.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { listBackfillTitleSessions } from '@myco-server-worker/read/children.js';
import { count, sqliteEnv, withHarness } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ORIGIN = 'https://s';

function rig() {
  const e = sqliteEnv();
  const launches: Array<{ runId: string }> = [];
  const env: ServerEnv = { ...withHarness(() => e.serverEnv, { launch: async (spec) => { launches.push(spec); } }), origin: ORIGIN, wake: async () => {} };
  const setting = (leaf: string, value: unknown) =>
    e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  setting('agent.provider.type', 'openai-compatible');
  setting('agent.provider.model', 'm');
  setting('agent.provider.base_url', 'http://models.internal/v1');
  /** An ended session with one inline user prompt and one transcript; by default imported and parsed. */
  const session = (id: string, over: { project?: string; endedAt?: number; imported?: boolean; parsed?: boolean; title?: string; material?: boolean; transcript?: boolean } = {}) => {
    const project = over.project ?? 'proj_1';
    const endedAt = over.endedAt ?? NOW - 1000;
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at, title)
                  VALUES (?, ?, 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?, ?)`, [project, id, endedAt - 10_000, endedAt, endedAt - 10_000, endedAt, over.title ?? null]);
    if (over.material !== false) {
      e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                    VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?, 'tok_1', ?)`, [project, id, `p_${id}`, `e_${id}`, `Please fix the build for ${id}`, `h_${id}`, endedAt - 5000, endedAt - 5000, endedAt - 5000]);
    }
    if (over.transcript !== false) {
      e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, parsed_offset, first_received_at, last_received_at, token_id, imported_at)
                    VALUES (?, ?, ?, 'm1', 100, ?, ?, ?, 'tok_1', ?)`, [project, `tx_${id}`, id, over.parsed === false ? 40 : 100, endedAt, endedAt, over.imported === false ? null : endedAt]);
    }
  };
  const runs = () => e.sqlite.query(`SELECT id, project_id AS projectId, status, json_extract(run_context, '$.session_id') AS sessionId, json_extract(run_context, '$.mode') AS mode, json_extract(dispatch_spec, '$.actor') AS actor
                                     FROM agent_runs WHERE task = ? ORDER BY COALESCE(queued_at, started_at), id`).all(TITLING_TASK) as Array<{ id: string; projectId: string; status: string; sessionId: string; mode: string; actor: string }>;
  const titledAt = (id: string) => (e.sqlite.query(`SELECT titled_at FROM sessions WHERE session_id = ?`).get(id) as { titled_at: number | null }).titled_at;
  const on = () => { setting('agent.scheduled_tasks_enabled', true); setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true } } }); };
  return { ...e, bindings: e.env, env, launches, setting, session, runs, titledAt, on };
}

describe('the imported-session backfill', () => {
  it('is declared as a job at idle depth, with a block that is off until an operator turns it on', () => {
    expect(SERVER_JOBS.find((j) => j.name === 'titling-backfill')?.runsThrough).toBe('idle');
    expect(TITLING_BACKFILL_SCHEDULE).toEqual({ enabled: false, intervalSeconds: 900, runIn: ['idle'], overlap: 'queue', maxRunsPerDay: 24 });
  });

  it('dispatches nothing while scheduling is off, or while its own block is off, and leaves no claim behind', async () => {
    const r = rig();
    r.session('s1');
    expect(await titlingBackfillPolicy(r.env)).toEqual({ scheduledTasksEnabled: false, backfillEnabled: false, runsPerDay: 24, intervalSeconds: 900, enabled: false });
    expect(await backfillImportedTitles(r.env, NOW)).toBe(0);
    r.setting('agent.scheduled_tasks_enabled', true);
    expect((await titlingBackfillPolicy(r.env)).enabled).toBe(false);
    expect(await backfillImportedTitles(r.env, NOW)).toBe(0);
    r.setting('agent.scheduled_tasks_enabled', false);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true } } });
    expect((await titlingBackfillPolicy(r.env)).enabled).toBe(false);
    expect(await backfillImportedTitles(r.env, NOW)).toBe(0);
    expect(r.runs()).toEqual([]);
    expect(r.titledAt('s1')).toBeNull();
  });

  it('titles untitled imported sessions with parsed material, newest first, as a claim attributed to the backfill; every other session is left alone', async () => {
    const r = rig();
    r.on();
    r.session('older', { endedAt: NOW - DAY });
    r.session('newest', { endedAt: NOW - 1000 });
    r.session('middle', { endedAt: NOW - 3600_000, project: 'proj_2' });
    r.session('live', { imported: false });
    r.session('unparsed', { parsed: false });
    r.session('titled', { title: 'Already titled' });
    r.session('silent', { material: false });
    r.session('no-transcript', { transcript: false });
    r.session('deleted');
    r.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES ('proj_1', 'deleted', NULL, ?, 'mem_1')`, [NOW]);

    expect((await listBackfillTitleSessions(r.env.db, 10)).map((c) => c.sessionId)).toEqual(['newest', 'middle', 'older']);
    expect(await backfillImportedTitles(r.env, NOW)).toBe(3);
    expect(r.runs().map((run) => [run.projectId, run.sessionId, run.mode, run.actor]).sort()).toEqual([
      ['proj_1', 'newest', 'claim', TITLING_BACKFILL_ACTOR], ['proj_1', 'older', 'claim', TITLING_BACKFILL_ACTOR], ['proj_2', 'middle', 'claim', TITLING_BACKFILL_ACTOR],
    ]);
    for (const id of ['live', 'unparsed', 'titled', 'silent', 'no-transcript', 'deleted']) expect({ id, titledAt: r.titledAt(id) }).toEqual({ id, titledAt: null });
    // A second wake inside the interval dispatches nothing; one past it finds every candidate already attempted.
    expect(await backfillImportedTitles(r.env, NOW + 1)).toBe(0);
    expect(await backfillImportedTitles(r.env, NOW + 901_000)).toBe(0);
    expect(r.runs().length).toBe(3);
  });

  it('takes a bounded page per wake, counts its ceiling across the Deployment, and reports where it stands', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0, maxRunsPerDay: TITLING_BACKFILL_BATCH + 2 } } });
    for (let i = 0; i < TITLING_BACKFILL_BATCH + 4; i += 1) r.session(`s${i}`, { project: i % 2 === 0 ? 'proj_1' : 'proj_2', endedAt: NOW - i * 1000 });

    expect(await backfillImportedTitles(r.env, NOW)).toBe(TITLING_BACKFILL_BATCH);
    expect(await backfillImportedTitles(r.env, NOW + 1)).toBe(2);
    expect(await backfillImportedTitles(r.env, NOW + 2)).toBe(0);
    expect(await titlingBackfillProgress(r.env, NOW + 2)).toMatchObject({ enabled: true, runsPerDay: TITLING_BACKFILL_BATCH + 2, usedToday: TITLING_BACKFILL_BATCH + 2, remaining: 2, inFlight: TITLING_BACKFILL_BATCH + 2, completedToday: 0, failedToday: 0 });
    // The window rolls: a day later the same ceiling admits the rest.
    expect(await backfillImportedTitles(r.env, NOW + DAY + 3)).toBe(2);
    expect(await titlingBackfillProgress(r.env, NOW + DAY + 3)).toMatchObject({ usedToday: 2, remaining: 0 });
  });

  it('never counts a person\'s own ask against the ceiling, and the ask is admitted at the ceiling', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0, maxRunsPerDay: 1 } } });
    r.session('a', { endedAt: NOW - 1000 });
    r.session('b', { endedAt: NOW - 2000 });
    expect(await backfillImportedTitles(r.env, NOW)).toBe(1);
    expect(await backfillImportedTitles(r.env, NOW + 1)).toBe(0);
    const ask = await titleSession(r.env, { projectId: 'proj_1', sessionId: 'b', now: NOW + 2, origin: ORIGIN }, { mode: 'owner', by: 'mem_1' });
    expect(['dispatched', 'queued']).toContain(ask.outcome);
    expect(r.runs().map((run) => [run.sessionId, run.actor])).toEqual([['a', TITLING_BACKFILL_ACTOR], ['b', 'mem_1']]);
    expect((await titlingBackfillProgress(r.env, NOW + 3)).usedToday).toBe(1);
  });

  it('claims each session once under concurrent wakes, and keeps no state of its own', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.setting('agent.tasks', { [TITLING_TASK]: { schedule: { enabled: true, intervalSeconds: 0 } } });
    r.session('a'); r.session('b');
    const tables = () => (r.sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    const before = tables();
    const dispatched = await Promise.all([backfillImportedTitles(r.env, NOW), backfillImportedTitles(r.env, NOW)]);
    expect(dispatched.reduce((a, b) => a + b, 0)).toBe(2);
    expect(r.runs().map((run) => run.sessionId).sort()).toEqual(['a', 'b']);
    expect(tables()).toEqual(before);
    expect(count(r.sqlite, 'agent_runs')).toBe(2);
  });

  it('is stopped and started by the operator\'s switch, which writes the task override and reports the state, and runs under the tick', async () => {
    const r = rig();
    r.setting('agent.scheduled_tasks_enabled', true);
    r.session('a');
    const cookie = await ownerCookie();
    const request = (method: string, body?: unknown) => worker.fetch(new Request('https://s/api/titling-backfill', {
      method, headers: { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { ...r.bindings, ...OWNER_ENV });
    const read = async () => (await request('GET')).json() as Promise<{ enabled: boolean; backfillEnabled: boolean; remaining: number }>;
    expect(await read()).toMatchObject({ enabled: false, backfillEnabled: false, remaining: 1 });
    expect((await request('PUT', { enabled: 'yes' })).status).toBe(400);
    expect(await (await request('PUT', { enabled: true })).json()).toMatchObject({ enabled: true, backfillEnabled: true });
    expect(JSON.parse((r.sqlite.query(`SELECT value FROM deployment_settings WHERE leaf = 'agent.tasks'`).get() as { value: string }).value)).toEqual({ [TITLING_TASK]: { schedule: { enabled: true } } });
    const tick = await runTick(r.env, NOW);
    expect(tick.jobs.find((j) => j.name === 'titling-backfill')).toEqual({ name: 'titling-backfill', changed: 1, failed: null });
    expect(await (await request('PUT', { enabled: false })).json()).toMatchObject({ enabled: false, backfillEnabled: false, inFlight: 1 });
    r.session('b');
    expect((await runTick(r.env, NOW + 1)).jobs.find((j) => j.name === 'titling-backfill')).toEqual({ name: 'titling-backfill', changed: 0, failed: null });
    expect(r.runs().length).toBe(1);
  });
});

/**
 * The sessions a run read (`run_reads`), and what the dashboard reads off them.
 *
 * A read is recorded when a run's own credential is served a session's material or a page of its prompt bodies,
 * after the answer and never in its way: a record that fails or never finishes leaves the read answered. It is one
 * row per run and session, bounded per run, and goes with its run's retention and its session's deletion. A member
 * reads it off the session (the runs that read it, and what came of it) and off the run (what it read, and what it
 * wrote), inside the Project the route names.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { MAX_RUN_READS, pruneTerminalRuns, recordDispatch, recordRunReads, recordRunWrite } from '@myco-server-worker/core/runs.js';
import { PROMPT_MARK_TOOL } from '@myco-server-worker/core/tool-catalogue.js';
import { OUTCOME_RUN_LIMIT, OUTCOME_SPORE_LIMIT } from '@myco-server-worker/read/run-reads.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { createBackup, restoreBackup } from '@myco-server-worker/core/backup.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { noteRunReads, type ToolContext } from '@myco-server-worker/mcp/context.js';
import { readWindowFor } from '@myco-server-worker/core/read-window.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const NOW = Date.now();
const TITLING = 'title-summary';
const SWEEP = 'extract-curate';

const rpc = (name: string, args: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

async function setup() {
  const e = sqliteEnv();
  const env = { ...e.env, ...OWNER_ENV };
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
  const session = (id: string, project = 'proj_1') => e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at, title)
    VALUES (?, ?, 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?, ?)`, [project, id, NOW - 10_000, NOW, NOW - 10_000, NOW, `Title of ${id}`]);
  const prompt = (id: string, sessionId: string) => e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
    VALUES ('proj_1', ?, ?, ?, ?, 'user', ?, ?, ?, 'tok_1', ?)`, [sessionId, id, `e_${id}`, `body of ${id}`, `h_${id}`, NOW, NOW, NOW]);
  const spore = (id: string, sessionId: string | null, author: string, project = 'proj_1', at = NOW) => e.sqlite.run(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, agent_line, author, created_at)
    VALUES (?, ?, 'myco-agent', ?, 'gotcha', 'active', 'body', ?, ?, ?)`, [project, id, sessionId, `line of ${id}`, author, at]);
  session('sess_1');
  session('sess_2');
  await ensureMember(e.db, HARNESS_MEMBER_ID, NOW, 'member', 'harness runtime');
  const member = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);

  /** A running run, dispatched over a credential of its own, as the dispatcher mints one per run; answers that credential. */
  const dispatch = async (runId: string, task: string, over: { sessionId?: string | null; project?: string; startedAt?: number } = {}) => {
    const credential = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW);
    const runContext = JSON.stringify({ ...(over.sessionId === null ? {} : { session_id: over.sessionId ?? 'sess_1' }), mode: 'claim', timeoutSeconds: 300 });
    expect(await recordDispatch(e.db, { projectId: over.project ?? 'proj_1' }, {
      id: runId, agentId: 'myco-agent', task, provider: 'anthropic', model: null, runContext, dispatchedBy: credential.tokenId, startedAt: over.startedAt ?? NOW,
    })).toBe(true);
    e.sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE project_id = ? AND id = ?`, [over.project ?? 'proj_1', runId]);
    return credential;
  };
  /** One tool call, the deferral the request carries settled before it answers. */
  const call = async (token: string, name: string, args: Record<string, unknown>, bindings: Record<string, unknown> = env) => {
    const res = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token), body: rpc(name, args) }), bindings as never, e.deferred);
    const body = await res.json() as any;
    await e.deferred.settle();
    return { result: body.result?.structuredContent?.result, error: body.error };
  };
  const reads = () => e.sqlite.query(`SELECT project_id AS projectId, run_id AS runId, session_id AS sessionId, token_id AS tokenId, received_at AS receivedAt FROM run_reads ORDER BY run_id, session_id`).all();
  const get = async (path: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env as never);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { ...e, env, member, dispatch, call, reads, get, session, prompt, spore };
}

describe('recording what a run read', () => {
  it('records a titling run\'s own session when its material is served, over the run\'s credential, once however often it reads', async () => {
    const { dispatch, call, reads, prompt } = await setup();
    prompt('p1', 'sess_1');
    const harness = await dispatch('run_t', TITLING);
    expect((await call(harness.token, 'myco_run_sessions', { op: 'material' })).result.session_id).toBe('sess_1');
    expect(reads()).toEqual([{ projectId: 'proj_1', runId: 'run_t', sessionId: 'sess_1', tokenId: harness.tokenId, receivedAt: expect.any(Number) }]);
    const first = (reads()[0] as { receivedAt: number }).receivedAt;
    await Bun.sleep(5);
    await call(harness.token, 'myco_run_sessions', { op: 'material' });
    expect(reads()).toEqual([expect.objectContaining({ runId: 'run_t', sessionId: 'sess_1', receivedAt: first })]);
  });

  it('records the sessions a page of prompt bodies carried, and nothing for a page of ids alone', async () => {
    const { dispatch, call, reads, prompt } = await setup();
    prompt('p1', 'sess_1');
    prompt('p2', 'sess_1');
    prompt('p3', 'sess_2');
    const harness = await dispatch('run_x', SWEEP, { sessionId: null });
    expect((await call(harness.token, 'myco_run_prompts', { op: 'unprocessed' })).result.prompts).toHaveLength(3);
    expect(reads()).toEqual([]);
    expect((await call(harness.token, 'myco_run_prompts', { op: 'unprocessed', include_text: true })).result.prompts).toHaveLength(3);
    expect(reads()).toEqual([
      expect.objectContaining({ runId: 'run_x', sessionId: 'sess_1' }),
      expect.objectContaining({ runId: 'run_x', sessionId: 'sess_2' }),
    ]);
  });

  it('records nothing for a member reading sessions, and nothing for a call the run surface refuses', async () => {
    const { member, dispatch, call, reads, prompt } = await setup();
    prompt('p1', 'sess_1');
    const harness = await dispatch('run_t', TITLING);
    expect((await call(member.token, 'myco_sessions', { op: 'get', id: 'sess_1' })).result.id).toBe('sess_1');
    expect((await call(member.token, 'myco_run_sessions', { op: 'material' })).error?.data?.code).toBe('unknown_tool');
    // A titling run's surface holds no extraction reads beyond its own page; a tool off it is refused before any handler.
    expect((await call(harness.token, 'myco_run_spores', { op: 'list' })).error?.data?.code).toBe('unknown_tool');
    expect(reads()).toEqual([]);
  });

  it('notes a read under a run\'s credential alone: a member\'s and a grant\'s reads schedule nothing', async () => {
    const e = await setup();
    const harness = await e.dispatch('run_t', TITLING);
    const at = { env: e.serverEnv, projectId: 'proj_1', now: NOW };
    const principals: Array<ToolContext['principal']> = [
      { kind: 'member', memberId: 'mem_machine_1', machineId: 'machine_1', tokenId: e.member.tokenId },
      { kind: 'grant', grantId: 'eg_1' },
    ];
    for (const principal of principals) noteRunReads({ ...at, principal }, ['sess_1']);
    expect(e.deferred.pending).toHaveLength(0);
    const run = { kind: 'run', runId: 'run_t', task: TITLING, agentId: 'myco-agent', sessionId: 'sess_1', runContext: null, tokenId: harness.tokenId, allow: new Map(), window: readWindowFor(TITLING) } as const;
    noteRunReads({ ...at, principal: run }, ['sess_1']);
    noteRunReads({ ...at, principal: run }, []);
    expect(e.deferred.pending).toHaveLength(1);
    await e.deferred.settle();
    expect(e.reads()).toEqual([expect.objectContaining({ runId: 'run_t', sessionId: 'sess_1', tokenId: harness.tokenId })]);
  });

  it('answers the read when its record fails, and names the failure in telemetry', async () => {
    const e = await setup();
    e.prompt('p1', 'sess_1');
    const harness = await e.dispatch('run_t', TITLING);
    const failing: RelationalStore = {
      prepare: (sql) => e.db.prepare(sql),
      batch: (statements) => {
        if (statements.some((s) => /INSERT INTO run_reads/.test((s as unknown as { sql: string }).sql))) throw new Error('D1_ERROR: storage is unavailable');
        return e.db.batch(statements);
      },
    };
    const logged: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      const answered = await e.call(harness.token, 'myco_run_sessions', { op: 'material' }, { ...e.env, MYCO_DB: failing });
      expect(answered.error).toBeUndefined();
      expect(answered.result.session_id).toBe('sess_1');
    } finally {
      console.log = log;
    }
    expect(e.reads()).toEqual([]);
    expect(logged.map((l) => JSON.parse(l)).filter((event) => event.kind === 'run_reads_unrecorded')).toEqual([{ kind: 'run_reads_unrecorded', runId: 'run_t', projectId: 'proj_1', error: expect.any(String) }]);
  });

  it('answers the read before its record lands: a record that never finishes holds nothing up', async () => {
    const e = await setup();
    e.prompt('p1', 'sess_1');
    const harness = await e.dispatch('run_t', TITLING);
    const stalled: RelationalStore = {
      prepare: (sql) => e.db.prepare(sql),
      batch: (statements) => (statements.some((s) => /INSERT INTO run_reads/.test((s as unknown as { sql: string }).sql)) ? new Promise(() => {}) : e.db.batch(statements)),
    };
    const res = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(harness.token), body: rpc('myco_run_sessions', { op: 'material' }) }),
      { ...e.env, MYCO_DB: stalled } as never, e.deferred);
    expect(((await res.json()) as any).result.structuredContent.result.session_id).toBe('sess_1');
    expect(e.deferred.pending.length).toBeGreaterThan(0);
    expect(e.reads()).toEqual([]);
  });

  it('holds one run to MAX_RUN_READS sessions, counting the rows one batch adds', async () => {
    const { db, sqlite, dispatch, reads } = await setup();
    const harness = await dispatch('run_x', SWEEP, { sessionId: null });
    for (let i = 0; i < MAX_RUN_READS + 5; i += 1) {
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?)`, [`bulk_${i}`, NOW, NOW]);
    }
    const scope = { projectId: 'proj_1' };
    const first = Array.from({ length: MAX_RUN_READS - 2 }, (_, i) => `bulk_${i}`);
    expect(await recordRunReads(db, scope, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: first, receivedAt: NOW })).toBe(MAX_RUN_READS - 2);
    // A session read again inside the bound keeps its one row and its first read.
    expect(await recordRunReads(db, scope, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: ['bulk_0', 'bulk_0'], receivedAt: NOW + 1 })).toBe(0);
    expect(sqlite.query(`SELECT received_at AS at FROM run_reads WHERE run_id = 'run_x' AND session_id = 'bulk_0'`).all()).toEqual([{ at: NOW }]);
    const next = Array.from({ length: 5 }, (_, i) => `bulk_${MAX_RUN_READS - 2 + i}`);
    expect(await recordRunReads(db, scope, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: next, receivedAt: NOW })).toBe(2);
    expect(reads()).toHaveLength(MAX_RUN_READS);
    // A read of a session already recorded, or of one the Project does not hold, adds nothing.
    expect(await recordRunReads(db, scope, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: ['bulk_0', 'absent'], receivedAt: NOW })).toBe(0);
    expect(await recordRunReads(db, scope, { runId: 'run_absent', tokenId: harness.tokenId, sessionIds: ['sess_1'], receivedAt: NOW })).toBe(0);
    expect(reads()).toHaveLength(MAX_RUN_READS);
  });
  it('records the sessions of a page the Project holds and skips one it does not, without losing the rest of the page', async () => {
    const { db, dispatch, reads } = await setup();
    const harness = await dispatch('run_x', SWEEP, { sessionId: null });
    expect(await recordRunReads(db, { projectId: 'proj_1' }, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: ['sess_2', 'absent'], receivedAt: NOW })).toBe(1);
    expect(reads()).toEqual([expect.objectContaining({ runId: 'run_x', sessionId: 'sess_2' })]);
  });
});

describe('what a member reads off a session and a run', () => {
  it('serves a session the runs that read it and what came of it, and a run what it read and what it wrote, to a member who is not an administrator', async () => {
    const { dispatch, call, prompt, spore, sqlite, get } = await setup();
    seedMemberRoleAccount(sqlite);
    sqlite.run(`UPDATE sessions SET title = NULL WHERE session_id = 'sess_1'`);
    prompt('p1', 'sess_1');
    prompt('p2', 'sess_2');
    const titling = await dispatch('run_t', TITLING, { startedAt: NOW - 2_000 });
    await call(titling.token, 'myco_run_sessions', { op: 'material' });
    expect((await call(titling.token, 'myco_run_sessions', { op: 'title', title: 'A title', summary: 'A summary' })).result.written).toBe(true);
    const sweep = await dispatch('run_x', SWEEP, { sessionId: null, startedAt: NOW - 1_000 });
    await call(sweep.token, 'myco_run_prompts', { op: 'unprocessed', include_text: true });
    spore('sp_1', 'sess_1', 'run_x', 'proj_1', NOW + 1);
    spore('sp_2', 'sess_2', 'run_x', 'proj_1', NOW + 2);
    spore('sp_m', 'sess_1', 'mem_machine_1', 'proj_1', NOW + 3);

    const detail = await get('/api/projects/proj_1/sessions/sess_1', MEMBER_SUB);
    expect(detail.status).toBe(200);
    expect(detail.body.outcome).toEqual({
      runs: [
        { runId: 'run_x', task: SWEEP, status: 'running', startedAt: NOW - 1_000, completedAt: null, readAt: expect.any(Number), target: false, titled: false, spores: 1 },
        { runId: 'run_t', task: TITLING, status: 'running', startedAt: NOW - 2_000, completedAt: null, readAt: expect.any(Number), target: true, titled: true, spores: 0 },
      ],
      spores: {
        total: 2,
        items: [
          { id: 'sp_m', observationType: 'gotcha', status: 'active', agentLine: 'line of sp_m', sessionId: 'sess_1', createdAt: NOW + 3, runId: null },
          { id: 'sp_1', observationType: 'gotcha', status: 'active', agentLine: 'line of sp_1', sessionId: 'sess_1', createdAt: NOW + 1, runId: 'run_x' },
        ],
      },
    });

    const run = await get('/api/projects/proj_1/runs/run_x', MEMBER_SUB);
    expect(run.status).toBe(200);
    expect(run.body.read).toEqual({
      sessions: [
        { sessionId: 'sess_1', title: 'A title', readAt: expect.any(Number) },
        { sessionId: 'sess_2', title: 'Title of sess_2', readAt: expect.any(Number) },
      ],
      total: 2,
      recorded: true,
    });
    expect(run.body.produced.spores.total).toBe(2);
    expect(run.body.produced.spores.items.map((s: { id: string }) => s.id)).toEqual(['sp_2', 'sp_1']);
  });

  it('answers a run with no recorded read by the sessions of the spores it wrote, and says so', async () => {
    const { dispatch, spore, get } = await setup();
    await dispatch('run_old', SWEEP, { sessionId: null });
    spore('sp_1', 'sess_2', 'run_old');
    spore('sp_2', 'sess_2', 'run_old', 'proj_1', NOW + 1);
    const run = await get('/api/projects/proj_1/runs/run_old');
    expect(run.body.read).toEqual({ sessions: [{ sessionId: 'sess_2', title: 'Title of sess_2', readAt: null }], total: 1, recorded: false });
    // The session lists the run by what it wrote from it, with no read time.
    const outcome = (await get('/api/projects/proj_1/sessions/sess_2')).body.outcome;
    expect(outcome.runs).toEqual([expect.objectContaining({ runId: 'run_old', readAt: null, spores: 2 })]);
    expect((await get('/api/projects/proj_1/runs/absent')).status).toBe(404);
    expect((await get('/api/projects/proj_1/sessions/absent')).status).toBe(404);
  });

  it('keeps each Project\'s reads to itself: the same run and session ids under another Project are never read through this one', async () => {
    const { db, sqlite, dispatch, spore, get } = await setup();
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, title) VALUES ('proj_2', 'sess_1', 'm1', 'tok_1', ?, ?, 'Theirs')`, [NOW, NOW]);
    const harness = await dispatch('run_x', SWEEP, { sessionId: null, project: 'proj_2' });
    // A run of this Project under the same id, which read another session and wrote nothing.
    const ourRun = await dispatch('run_x', SWEEP, { sessionId: null });
    expect(await recordRunReads(db, { projectId: 'proj_2' }, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: ['sess_1'], receivedAt: NOW })).toBe(1);
    expect(await recordRunReads(db, { projectId: 'proj_1' }, { runId: 'run_x', tokenId: ourRun.tokenId, sessionIds: ['sess_2'], receivedAt: NOW })).toBe(1);
    spore('sp_theirs', 'sess_1', 'run_x', 'proj_2');
    expect((await get('/api/projects/proj_1/sessions/sess_1')).body.outcome).toEqual({ runs: [], spores: { total: 0, items: [] } });
    const ours = await get('/api/projects/proj_1/runs/run_x');
    expect({ status: ours.status, read: ours.body.read, produced: ours.body.produced }).toEqual({
      status: 200,
      read: { sessions: [{ sessionId: 'sess_2', title: 'Title of sess_2', readAt: NOW }], total: 1, recorded: true },
      produced: { spores: { total: 0, items: [] } },
    });
    const theirs = await get('/api/projects/proj_2/sessions/sess_1');
    expect(theirs.body.outcome.runs.map((r: { runId: string }) => r.runId)).toEqual(['run_x']);
    expect(theirs.body.outcome.spores.total).toBe(1);
  });
});

describe('what a session\'s outcome counts and lists', () => {
  it('lists at most 10 spores and 20 runs, and counts every spore', async () => {
    const { db, sqlite, spore, get } = await setup();
    expect({ spores: OUTCOME_SPORE_LIMIT, runs: OUTCOME_RUN_LIMIT }).toEqual({ spores: 10, runs: 20 });
    for (let i = 0; i < 11; i += 1) spore(`sp_${i}`, 'sess_2', 'mem_machine_1', 'proj_1', NOW + i);
    for (let i = 0; i < 21; i += 1) {
      sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', ?, 'myco-agent', ?, 'completed', ?)`, [`run_${i}`, SWEEP, NOW + i]);
      await recordRunReads(db, { projectId: 'proj_1' }, { runId: `run_${i}`, tokenId: 'mt_run', sessionIds: ['sess_2'], receivedAt: NOW });
    }
    const outcome = (await get('/api/projects/proj_1/sessions/sess_2')).body.outcome;
    expect({ runs: outcome.runs.length, first: outcome.runs[0].runId, spores: outcome.spores.items.length, total: outcome.spores.total })
      .toEqual({ runs: 20, first: 'run_20', spores: 10, total: 11 });
  });

  it('marks a run titled only for the title it wrote of this session: never for a refused write, another session, or another tool\'s write', async () => {
    const { db, sqlite, dispatch, call, prompt, get } = await setup();
    prompt('p1', 'sess_1');
    prompt('p2', 'sess_2');
    sqlite.run(`UPDATE sessions SET title = NULL WHERE session_id = 'sess_2'`);
    // sess_1 already carries a title, so a claim-mode write is refused.
    const refused = await dispatch('run_refused', TITLING, { startedAt: NOW - 3_000 });
    await call(refused.token, 'myco_run_sessions', { op: 'material' });
    expect((await call(refused.token, 'myco_run_sessions', { op: 'title', title: 'T', summary: 'S' })).result.written).toBe(false);
    // A run of the other session writes its title and reads a page that carries this one.
    const other = await dispatch('run_other', TITLING, { sessionId: 'sess_2', startedAt: NOW - 2_000 });
    await call(other.token, 'myco_run_sessions', { op: 'material' });
    expect((await call(other.token, 'myco_run_sessions', { op: 'title', title: 'T', summary: 'S' })).result.written).toBe(true);
    await call(other.token, 'myco_run_prompts', { op: 'unprocessed', include_text: true });
    // A run dispatched on this session whose only landed write is another tool's.
    await dispatch('run_marked', TITLING, { startedAt: NOW - 1_000 });
    await recordRunWrite(db, { projectId: 'proj_1' }, { runId: 'run_marked', toolName: PROMPT_MARK_TOOL, op: 'mark_processed', recordedAt: NOW, detail: { prompt_id: 'p1' } });

    const runs = (await get('/api/projects/proj_1/sessions/sess_1')).body.outcome.runs as Array<{ runId: string; target: boolean; titled: boolean }>;
    expect(runs.map(({ runId, target, titled }) => ({ runId, target, titled }))).toEqual([
      { runId: 'run_marked', target: true, titled: false },
      { runId: 'run_other', target: false, titled: false },
      { runId: 'run_refused', target: true, titled: false },
    ]);
    const theirs = (await get('/api/projects/proj_1/sessions/sess_2')).body.outcome.runs as Array<{ runId: string; target: boolean; titled: boolean }>;
    expect(theirs.map(({ runId, target, titled }) => ({ runId, target, titled }))).toEqual([{ runId: 'run_other', target: true, titled: true }]);
  });

  it('lists a run dispatched on a session that recorded no read of it and wrote nothing from it, and answers that run\'s reads as its dispatch\'s session', async () => {
    const { dispatch, get } = await setup();
    await dispatch('run_title', TITLING, { sessionId: 'sess_2' });
    expect((await get('/api/projects/proj_1/sessions/sess_2')).body.outcome.runs)
      .toEqual([expect.objectContaining({ runId: 'run_title', readAt: null, target: true, titled: false, spores: 0 })]);
    expect((await get('/api/projects/proj_1/runs/run_title')).body.read)
      .toEqual({ sessions: [{ sessionId: 'sess_2', title: 'Title of sess_2', readAt: null }], total: 1, recorded: false });
    // A run with no record, no session and no spores: no record, which is not a claim that it read nothing.
    await dispatch('run_blank', SWEEP, { sessionId: null });
    expect((await get('/api/projects/proj_1/runs/run_blank')).body.read).toEqual({ sessions: [], total: 0, recorded: false });
  });
});

describe('retention', () => {
  it('removes a run\'s reads with the run when run retention takes it, and leaves every other run\'s', async () => {
    const { db, sqlite, dispatch, reads } = await setup();
    const old = await dispatch('run_old', SWEEP, { sessionId: null });
    await dispatch('run_new', SWEEP, { sessionId: null });
    for (const runId of ['run_old', 'run_new']) await recordRunReads(db, { projectId: 'proj_1' }, { runId, tokenId: old.tokenId, sessionIds: ['sess_1', 'sess_2'], receivedAt: NOW });
    sqlite.run(`UPDATE agent_runs SET status = 'completed', completed_at = ? WHERE id = 'run_old'`, [NOW - 100_000]);
    expect(await pruneTerminalRuns(db, NOW - 50_000, 100)).toBeGreaterThanOrEqual(1);
    expect(sqlite.query(`SELECT id FROM agent_runs WHERE id IN ('run_old', 'run_new')`).all()).toEqual([{ id: 'run_new' }]);
    expect((reads() as Array<{ runId: string }>).map((r) => r.runId)).toEqual(['run_new', 'run_new']);
  });

  it('removes the record of every run reading a deleted session, and leaves those runs and their other reads', async () => {
    const { db, dispatch, reads, get } = await setup();
    const harness = await dispatch('run_x', SWEEP, { sessionId: null });
    await recordRunReads(db, { projectId: 'proj_1' }, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: ['sess_1', 'sess_2'], receivedAt: NOW });
    expect((await tombstoneSession({ db }, { projectId: 'proj_1' }, 'sess_1', 'mem_machine_1', NOW)).applied).toBe(true);
    expect(reads()).toEqual([expect.objectContaining({ runId: 'run_x', sessionId: 'sess_2' })]);
    expect((await get('/api/projects/proj_1/runs/run_x')).body.read.sessions.map((s: { sessionId: string }) => s.sessionId)).toEqual(['sess_2']);
    // A record that lands after the deletion — a read deferred past it — writes nothing.
    expect(await recordRunReads(db, { projectId: 'proj_1' }, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: ['sess_1'], receivedAt: NOW + 1 })).toBe(0);
    expect(reads()).toEqual([expect.objectContaining({ runId: 'run_x', sessionId: 'sess_2' })]);
  });

  it('never lists a deleted session among a run\'s reads, recorded or known from its spores and dispatch', async () => {
    const { db, sqlite, dispatch, spore, get, session } = await setup();
    session('sess_3');
    const harness = await dispatch('run_rec', SWEEP, { sessionId: null });
    await recordRunReads(db, { projectId: 'proj_1' }, { runId: 'run_rec', tokenId: harness.tokenId, sessionIds: ['sess_1', 'sess_2', 'sess_3'], receivedAt: NOW });
    await dispatch('run_old', TITLING, { sessionId: 'sess_1' });
    spore('sp_old', 'sess_2', 'run_old');
    // A tombstone standing without the deletion's sweep, as a record racing the sweep would leave it.
    sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, created_at, created_by) VALUES ('proj_1', 'sess_1', ?, 'mem_machine_1'), ('proj_1', 'sess_2', ?, 'mem_machine_1')`, [NOW, NOW]);
    expect((await get('/api/projects/proj_1/runs/run_rec')).body.read)
      .toEqual({ sessions: [{ sessionId: 'sess_3', title: 'Title of sess_3', readAt: NOW }], total: 1, recorded: true });
    expect((await get('/api/projects/proj_1/runs/run_old')).body.read).toEqual({ sessions: [], total: 0, recorded: false });
  });

  it('carries the reads through a backup and its restore, and a second restore adds nothing', async () => {
    const source = await setup();
    const harness = await source.dispatch('run_x', SWEEP, { sessionId: null });
    await recordRunReads(source.db, { projectId: 'proj_1' }, { runId: 'run_x', tokenId: harness.tokenId, sessionIds: ['sess_1'], receivedAt: NOW });
    const backup = await createBackup(source.db, source.bucket, { producer: 'test', now: NOW });

    const target = sqliteEnv();
    target.bucket.objects.set(backup.key, source.bucket.objects.get(backup.key)!);
    target.sqlite.query(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256) VALUES (?, ?, ?, ?, ?, ?, 'copied', 0, ?)`)
      .run(backup.id, backup.key, backup.created_at, backup.size_bytes, backup.counts_json, backup.schema_version, backup.sha256);
    const restored = await restoreBackup(target.db, target.bucket, { id: backup.id, allowForeignLineage: true });
    expect(restored!.tables.run_reads).toEqual({ rows: 1, inserted: 1 });
    expect(target.sqlite.query(`SELECT run_id AS runId, session_id AS sessionId, token_id AS tokenId FROM run_reads`).all())
      .toEqual([{ runId: 'run_x', sessionId: 'sess_1', tokenId: harness.tokenId }]);
    expect((await restoreBackup(target.db, target.bucket, { id: backup.id, allowForeignLineage: true }))!.tables.run_reads).toEqual({ rows: 1, inserted: 0 });
  });
});

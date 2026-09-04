/**
 * Instructions on the harness, end to end on the server side.
 *
 * The dispatch builds the input and refuses to spend a run on a Project that has
 * not moved; the run carries its prompt on its own row and reads it back over an
 * admitted route; the artifact is filed under the hash the SERVER recorded, not
 * the one the runtime claims; and a run that closes without its report is
 * refused.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { drainQueue, HARNESS_AGENT_ID, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { getRun, upsertCortexInstructions } from '@myco-server-worker/core/runs.js';
import { upsertDigest } from '@myco-server-worker/core/digests.js';
import { insertSpore } from '@myco-server-worker/core/spores.js';
import { RUN_CLOSE_REPORTS } from '@myco-server-worker/core/run-postconditions.js';
import { buildTaskInput } from '@myco-server-worker/core/task-inputs.js';
import { listInstructions } from '@myco-server-worker/read/cortex.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const TASK = 'cortex-instructions';
type Launch = { runId: string; timeoutSeconds: number; envVars: Record<string, string> };

async function fixture(opts: { capability?: boolean } = {}) {
  const e = sqliteEnv();
  const launches: Launch[] = [];
  const HARNESS = {
    idFromName: (name: string) => ({ name }),
    get: () => ({ launch: async (spec: Launch) => { launches.push(spec); } }),
  };
  const bindings = { ...e.env, ...OWNER_ENV, HARNESS } as never;
  const base = serverEnvFromBindings(bindings);
  const env: ServerEnv = { ...base, wake: async () => {} };
  const setting = (leaf: string, value: unknown) =>
    e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  setting('agent.provider.type', 'openai-compatible');
  setting('agent.provider.model', 'm');
  setting('agent.provider.base_url', 'http://models.internal/v1');
  e.sqlite.run(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', ?, ?, 'test')`, [opts.capability === false ? 0 : 1, NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
  await ensureMember(e.db, HARNESS_MEMBER_ID, NOW, 'harness runtime');
  const minted = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW);

  const call = async (path: string, body: unknown, token = minted.token) =>
    worker.fetch(new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(token), body: JSON.stringify(body) }), bindings) as Promise<Response>;
  const answered = async (path: string, body: unknown, token = minted.token) => (await call(path, body, token)).json() as Promise<Record<string, unknown>>;
  const dispatch = async (body: Record<string, unknown> = {}) => {
    const res = await worker.fetch(await asOwnerPost('/api/harness/dispatch', { task: TASK, projectId: 'proj_1', ...body }), bindings);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  /** A dispatched run of `task`, live under the harness credential, with a recorded context. */
  const liveRun = (id: string, task: string, context: Record<string, unknown>, instruction: string | null = null, dryRun = false, dispatchedBy = minted.tokenId) => {
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, instruction, status, dry_run, started_at, run_context, dispatched_by)
       VALUES ('proj_1', ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      [id, HARNESS_AGENT_ID, task, instruction, dryRun ? 1 : 0, Date.now(), JSON.stringify(context), dispatchedBy],
    );
    return id;
  };
  /** A second harness credential: closing a run releases the one that dispatched it, so a test with two runs mints two. */
  const credential = () => issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, NOW);
  const session = (id: string, title: string, ended: boolean) =>
    e.sqlite.run(
      `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at, title, summary)
       VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?, ?, ?)`,
      [id, NOW, NOW, NOW, ended ? NOW + 1 : null, title, `summary of ${title}`],
    );
  const spore = (id: string, content: string) => insertSpore(e.db, SCOPE, {
    id, agentId: HARNESS_AGENT_ID, sessionId: null, promptId: null, observationType: 'decision',
    content, context: null, filePath: null, tags: null, contentHash: null, properties: null, createdAt: NOW,
  });
  const runs = () => e.sqlite.query(`SELECT id, task, status, instruction, dry_run AS dryRun, run_context AS runContext FROM agent_runs ORDER BY COALESCE(queued_at, started_at), id`).all() as Array<Record<string, unknown>>;
  return { ...e, env, bindings, launches, setting, call, answered, dispatch, liveRun, credential, session, spore, runs, tokenId: minted.tokenId, token: minted.token };
}

describe('the routes a Cortex run holds', () => {
  it('answers the run its own prompt, and answers a caller holding no such run nothing', async () => {
    const f = await fixture();
    f.liveRun('run_1', TASK, { input_hash: 'h1' }, 'THE PROMPT');
    f.liveRun('run_other', 'title-summary', { session_id: 's1' }, 'not this one');
    expect(await f.answered('/runs/instruction', { runId: 'run_1' })).toEqual({ persisted: true, held: true, instruction: 'THE PROMPT' });
    expect(await f.answered('/runs/instruction', { runId: 'run_other' })).toEqual({ persisted: true, held: false });
    expect(await f.answered('/runs/instruction', { runId: 'run_1' }, (await issueMemberToken(f.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW)).token))
      .toEqual({ persisted: true, held: false });
  });

  it('reads the instruction outside the row every served tool call reads', async () => {
    const f = await fixture();
    f.liveRun('run_1', TASK, { input_hash: 'h1' }, 'THE PROMPT');
    const before = f.executed.length;
    await f.answered('/runs/spores', { runId: 'run_1' });
    expect(f.executed.slice(before).some((sql) => sql.includes('instruction'))).toBe(false);
  });

  it('files the artifact under the hash the run row carries, never the body\'s', async () => {
    const f = await fixture();
    f.liveRun('run_1', TASK, { input_hash: 'server-hash' }, 'THE PROMPT');
    expect(await f.answered('/runs/instructions-write', { runId: 'run_1', content: '# Start here', inputHash: 'caller-hash' }))
      .toEqual({ persisted: true, held: true, written: true });
    const rows = await listInstructions(f.db, SCOPE);
    expect(rows).toHaveLength(1);
    expect({ content: rows[0]!.content, inputHash: rows[0]!.inputHash, sourceRunId: rows[0]!.sourceRunId, agentId: rows[0]!.agentId })
      .toEqual({ content: '# Start here', inputHash: 'server-hash', sourceRunId: 'run_1', agentId: HARNESS_AGENT_ID });
  });

  it('writes nothing for a dry run, and nothing for a caller holding no run', async () => {
    const f = await fixture();
    f.liveRun('run_dry', TASK, { input_hash: 'server-hash' }, 'THE PROMPT', true);
    expect(await f.answered('/runs/instructions-write', { runId: 'run_dry', content: '# nope' }))
      .toEqual({ persisted: true, held: true, written: false });
    expect(await f.answered('/runs/instructions-write', { runId: 'run_absent', content: '# nope' }))
      .toEqual({ persisted: true, held: false, written: false });
    expect(await listInstructions(f.db, SCOPE)).toEqual([]);
  });

  it('serves the settled sessions within a clamped page, and never one still in flight', async () => {
    const f = await fixture();
    f.liveRun('run_1', TASK, { input_hash: 'h' });
    for (let i = 0; i < 4; i += 1) f.session(`s${i}`, `Session ${i}`, true);
    f.session('live', 'Still going', false);
    const answered = await f.answered('/runs/sessions', { runId: 'run_1', limit: 2 });
    const sessions = answered.sessions as Array<{ id: string; title: string; summary: string }>;
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id)).not.toContain('live');
    expect(sessions[0]!.summary).toContain('summary of');
    const all = await f.answered('/runs/sessions', { runId: 'run_1', limit: 9999 });
    expect((all.sessions as unknown[]).length).toBe(4);
  });

  it('serves one digest tier in full and every tier\'s shape when none is named', async () => {
    const f = await fixture();
    f.liveRun('run_1', TASK, { input_hash: 'h' });
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: HARNESS_AGENT_ID, tier: 5000, content: 'the digest', substrateHash: null, generatedAt: NOW });
    expect(await f.answered('/runs/digest', { runId: 'run_1', tier: 5000 }))
      .toEqual({ persisted: true, held: true, digest: { tier: 5000, content: 'the digest', generatedAt: NOW } });
    expect(await f.answered('/runs/digest', { runId: 'run_1' }))
      .toEqual({ persisted: true, held: true, tiers: [{ tier: 5000, generatedAt: NOW, contentLength: 10 }] });
    expect(await f.answered('/runs/digest', { runId: 'run_absent' })).toEqual({ persisted: true, held: false });
  });
});

describe('a dispatch of the instructions task', () => {
  it('carries the prompt on the run row and the hash and counts in its context', async () => {
    const f = await fixture();
    f.session('s1', 'Session one', true);
    const answered = await f.dispatch();
    expect(answered.status).toBe(200);
    const row = f.runs().find((r) => r.task === TASK)!;
    expect(String(row.instruction)).toContain('## Recent sessions');
    const context = JSON.parse(String(row.runContext)) as Record<string, unknown>;
    expect(typeof context.input_hash).toBe('string');
    expect(context.counts).toEqual({ sessions: 1, spores: 0, plans: 0 });
    expect(row.dryRun).toBe(0);
  });

  it('answers unchanged, with no run at all, when the Project has not moved past what it holds', async () => {
    const f = await fixture();
    f.session('s1', 'Session one', true);
    const built = await buildTaskInput(f.env, TASK, 'proj_1', NOW);
    await upsertCortexInstructions(f.db, SCOPE, {
      agentId: HARNESS_AGENT_ID, content: '# held', inputHash: (built as { input: { inputHash: string } }).input.inputHash, generatedAt: NOW, sourceRunId: null,
    });
    expect(await f.dispatch()).toEqual({ status: 200, body: { outcome: 'unchanged' } });
    expect(f.runs()).toEqual([]);
    // A spore lands and the Project has moved: the next ask starts a run.
    await f.spore('sp_1', 'we chose the queue');
    expect((await f.dispatch()).body.runId).toBeString();
  });

  it('marks a dry run on its own row', async () => {
    const f = await fixture();
    const answered = await f.dispatch({ dryRun: true });
    expect(answered.status).toBe(200);
    expect(f.runs()[0]!.dryRun).toBe(1);
  });

  it('is answered its per-day ceiling once the day is spent', async () => {
    const f = await fixture();
    await f.dispatch();
    await f.spore('sp_1', 'moved');
    expect(await f.dispatch()).toMatchObject({ status: 409, body: { error: 'max_runs_per_day' } });
  });
});

describe('the clock and the queue', () => {
  it('records a skipped run naming the unchanged input rather than spending one', async () => {
    const f = await fixture();
    f.setting('agent.scheduled_tasks_enabled', true);
    f.setting('agent.tasks', { [TASK]: { schedule: { enabled: true, runIn: ['active', 'idle', 'sleep'] } } });
    f.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('proj_1', 'recent', 'm1', 'tok_1', ?, ?, 'claude-code')`, [Date.now(), Date.now()]);
    const built = await buildTaskInput(f.env, TASK, 'proj_1', Date.now());
    await upsertCortexInstructions(f.db, SCOPE, {
      agentId: HARNESS_AGENT_ID, content: '# held', inputHash: (built as { input: { inputHash: string } }).input.inputHash, generatedAt: NOW, sourceRunId: null,
    });
    // `container-smoke` is scheduled too and dispatches on its own; the instructions task is what this reads.
    expect(await runScheduledTasks(f.env, 'sleep', Date.now(), 'https://s')).toMatchObject({ skipped: 1 });
    const skipped = f.runs().filter((r) => r.task === TASK);
    expect(skipped).toHaveLength(1);
    expect({ status: skipped[0]!.status, context: JSON.parse(String(skipped[0]!.runContext)) }).toEqual({ status: 'skipped', context: { reason: 'input_unchanged' } });
    expect(f.launches.map((l) => l.envVars.MYCO_TASK)).not.toContain(TASK);
  });

  it('rebuilds a queued dispatch at the drain: skipped when the Project stood still, launched with the fresh prompt when it moved', async () => {
    const f = await fixture();
    f.setting('agent.limits.concurrent_runs', 1);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'blocker', ?, 'digest-only', 'running', ?)`, [HARNESS_AGENT_ID, Date.now()]);
    const queued = await f.dispatch();
    expect(queued.body.queued).toBe(true);
    const runId = String(queued.body.runId);

    // The Project has not moved past what the queued dispatch built: the row is skipped by name.
    const built = await buildTaskInput(f.env, TASK, 'proj_1', Date.now());
    await upsertCortexInstructions(f.db, SCOPE, {
      agentId: HARNESS_AGENT_ID, content: '# held', inputHash: (built as { input: { inputHash: string } }).input.inputHash, generatedAt: NOW, sourceRunId: null,
    });
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed' WHERE id = 'blocker'`);
    expect(await drainQueue(f.env, Date.now())).toBe(0);
    const skipped = await getRun(f.db, SCOPE, runId);
    expect({ status: skipped?.status, context: JSON.parse(String(skipped?.runContext)) }).toEqual({ status: 'skipped', context: { reason: 'input_unchanged' } });
    expect(f.launches).toHaveLength(0);

    // A second queued dispatch, and a spore lands before it drains: it launches with the prompt built at that instant.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'blocker_2', ?, 'digest-only', 'running', ?)`, [HARNESS_AGENT_ID, Date.now()]);
    await f.spore('sp_1', 'the queue holds a run row');
    const again = await f.dispatch();
    expect(again.body.queued).toBe(true);
    await f.spore('sp_2', 'a drained run reads the vault as it stands');
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed' WHERE id = 'blocker_2'`);
    expect(await drainQueue(f.env, Date.now())).toBe(1);
    const launched = f.runs().find((r) => r.id === again.body.runId)!;
    expect(launched.status).toBe('pending');
    expect(String(launched.instruction)).toContain('a drained run reads the vault as it stands');
    const fresh = await buildTaskInput(f.env, TASK, 'proj_1', Date.now());
    expect(JSON.parse(String(launched.runContext)).input_hash).toBe((fresh as { input: { inputHash: string } }).input.inputHash);
  });
});

describe('what the instructions run owes before it closes', () => {
  it('names the report the task must have recorded', () => {
    expect(RUN_CLOSE_REPORTS[TASK]).toBe('cortex_instructions');
  });

  it('fails a run that recorded none, and closes one that did', async () => {
    const f = await fixture();
    f.liveRun('run_silent', TASK, { input_hash: 'h' }, 'THE PROMPT');
    const close = (runId: string) => f.answered('/runs/update', { runId, update: { status: 'completed', completed_at: Date.now() } });
    expect(await close('run_silent')).toMatchObject({ persisted: true, applied: false, reason: 'postcondition' });
    expect((await getRun(f.db, SCOPE, 'run_silent'))?.status).toBe('failed');

    const second = await f.credential();
    f.liveRun('run_reported', TASK, { input_hash: 'h' }, 'THE PROMPT', false, second.tokenId);
    await f.answered('/runs/report', { runId: 'run_reported', agentId: HARNESS_AGENT_ID, action: 'cortex_instructions', summary: 'wrote them' }, second.token);
    expect(await f.answered('/runs/update', { runId: 'run_reported', update: { status: 'completed', completed_at: Date.now() } }, second.token)).toMatchObject({ persisted: true, changed: 1 });
    expect((await getRun(f.db, SCOPE, 'run_reported'))?.status).toBe('completed');
  });
});

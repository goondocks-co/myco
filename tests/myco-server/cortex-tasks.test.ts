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
import { DEFAULT_DISPATCH_TIMEOUT_SECONDS, drainQueue, HARNESS_AGENT_ID, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { TASK_RUN_TIMEOUT_SECONDS } from '@myco-server-worker/core/task-catalogue.js';
import { runScheduledTasks } from '@myco-server-worker/core/scheduled-tasks.js';
import { getRun, upsertCortexInstructions } from '@myco-server-worker/core/runs.js';
import { listDigests, upsertDigest } from '@myco-server-worker/core/digests.js';
import { insertSpore } from '@myco-server-worker/core/spores.js';
import { RUN_CLOSE_ARTIFACT_ERROR, RUN_CLOSE_ERROR, RUN_CLOSE_REPORTS, RUN_CLOSE_RULES } from '@myco-server-worker/core/run-postconditions.js';
import { buildTaskInput } from '@myco-server-worker/core/task-inputs.js';
import {
  DIGEST_SESSION_PAGE_LIMIT, DIGEST_SPORE_PAGE_LIMIT, RUN_SESSION_LABEL_CHARS, RUN_SESSION_SUMMARY_CHARS, RUN_SESSION_TITLE_CHARS,
} from '@myco-server-worker/core/cortex-input.js';
import { listInstructions } from '@myco-server-worker/read/cortex.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const TASK = 'cortex-instructions';
const DIGEST_TASK = 'digest-only';
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
  /** A run the dispatcher recorded and the container has not claimed yet, under this fixture's credential so the claim route can move it. */
  const pendingRun = (id: string, task: string, context: Record<string, unknown>, instruction: string | null, dryRun: boolean, dispatchedBy = minted.tokenId) =>
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, instruction, status, dry_run, started_at, run_context, dispatched_by)
       VALUES ('proj_1', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [id, HARNESS_AGENT_ID, task, instruction, dryRun ? 1 : 0, Date.now(), JSON.stringify(context), dispatchedBy],
    );
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
  /** Close a run as the credential that dispatched it; closing releases that credential, so each run takes its own. */
  const close = (runId: string, token?: string) => answered('/runs/update', { runId, update: { status: 'completed', completed_at: Date.now() } }, token);
  return { ...e, env, bindings, launches, setting, call, answered, dispatch, liveRun, pendingRun, credential, close, session, spore, runs, tokenId: minted.tokenId, token: minted.token };
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

  it('stays dry through the container\'s own claim: the claim never carries dry_run', async () => {
    const f = await fixture();
    // The dispatcher recorded a dry run; the container claims it the way the
    // runtime does, naming no dryRun of its own.
    f.pendingRun('run_dry_claim', TASK, { input_hash: 'server-hash' }, 'THE PROMPT', true);
    expect(await f.answered('/runs/claim', { id: 'run_dry_claim', agentId: HARNESS_AGENT_ID, task: TASK, capability: 'cortex', harness: 'claude-sdk' }))
      .toMatchObject({ persisted: true, claimed: true });
    expect(f.runs().find((r) => r.id === 'run_dry_claim')).toMatchObject({ status: 'running', dryRun: 1 });
    expect(await f.answered('/runs/instructions-write', { runId: 'run_dry_claim', content: '# nope' }))
      .toEqual({ persisted: true, held: true, written: false });
    expect(await listInstructions(f.db, SCOPE)).toEqual([]);
  });

  it('refuses the dispatcher\'s own columns on a dispatched run, by name', async () => {
    const f = await fixture();
    f.liveRun('run_owned', TASK, { input_hash: 'server-hash' }, 'THE PROMPT');
    for (const update of [{ run_context: JSON.stringify({ input_hash: 'mine' }) }, { dry_run: 1 }, { run_context: '{}', dry_run: 1 }]) {
      const answered = await f.answered('/runs/update', { runId: 'run_owned', update });
      expect({ update, persisted: answered.persisted }).toEqual({ update, persisted: false });
      expect(String(answered.reason)).toContain('belong to the dispatcher');
    }
    const held = f.runs().find((r) => r.id === 'run_owned')!;
    expect({ hash: JSON.parse(String(held.runContext)).input_hash, dryRun: held.dryRun }).toEqual({ hash: 'server-hash', dryRun: 0 });
    // Every other column still moves on the same run.
    expect(await f.answered('/runs/update', { runId: 'run_owned', update: { tokens_used: 12 } })).toMatchObject({ persisted: true, changed: 1 });
    // The columns stay settable on a run nothing dispatched.
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, dry_run, started_at) VALUES ('proj_1', 'run_local', ?, 'digest-only', 'running', 0, ?)`, [HARNESS_AGENT_ID, Date.now()]);
    expect(await f.answered('/runs/update', { runId: 'run_local', update: { run_context: '{}' } })).toMatchObject({ persisted: true, changed: 1 });
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

  it('cuts every part of a session row to its own bound, so a long title cannot outgrow the page', async () => {
    const f = await fixture();
    f.liveRun('run_1', TASK, { input_hash: 'h' });
    f.sqlite.run(
      `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at, title, summary)
       VALUES ('proj_1', 'long', 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?, ?, ?)`,
      [NOW, NOW, NOW, NOW + 1, 'title '.repeat(200), 'summary '.repeat(200)],
    );
    const row = ((await f.answered('/runs/sessions', { runId: 'run_1' })).sessions as Array<{ title: string; label: string; summary: string }>)[0]!;
    expect(row.title.length).toBeLessThanOrEqual(RUN_SESSION_TITLE_CHARS + 1);
    expect(row.label.length).toBeLessThanOrEqual(RUN_SESSION_LABEL_CHARS + 1);
    expect(row.summary.length).toBeLessThanOrEqual(RUN_SESSION_SUMMARY_CHARS + 1);
  });

  it('serves one digest tier in full and every tier\'s shape when none is named', async () => {
    const f = await fixture();
    f.liveRun('run_1', TASK, { input_hash: 'h' });
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: HARNESS_AGENT_ID, tier: 5000, content: 'the digest', substrateHash: null, generatedAt: NOW });
    expect(await f.answered('/runs/digest', { runId: 'run_1', tier: 5000 }))
      .toEqual({ persisted: true, held: true, digest: { tier: 5000, content: 'the digest', generatedAt: NOW, fallback: false } });
    // A run that only reads is served the nearest tier the Project holds, and told which it got.
    expect(await f.answered('/runs/digest', { runId: 'run_1', tier: 10000 }))
      .toEqual({ persisted: true, held: true, digest: { tier: 5000, content: 'the digest', generatedAt: NOW, fallback: true } });
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

  it('carries the task\'s own run budget into the run\'s context, and the flat default for a task that names none', async () => {
    const f = await fixture();
    const asked = await f.dispatch();
    expect(JSON.parse(String(f.runs().find((r) => r.id === asked.body.runId)!.runContext)).timeoutSeconds).toBe(TASK_RUN_TIMEOUT_SECONDS[TASK]);

    const digest = await f.dispatch({ task: DIGEST_TASK });
    expect(JSON.parse(String(f.runs().find((r) => r.id === digest.body.runId)!.runContext)).timeoutSeconds).toBe(TASK_RUN_TIMEOUT_SECONDS[DIGEST_TASK]);

    const smoke = await f.dispatch({ task: 'container-smoke' });
    expect(JSON.parse(String(f.runs().find((r) => r.id === smoke.body.runId)!.runContext)).timeoutSeconds).toBe(DEFAULT_DISPATCH_TIMEOUT_SECONDS);

    // A caller naming its own bound keeps it.
    const named = await f.dispatch({ task: 'container-smoke', timeoutSeconds: 42 });
    expect(JSON.parse(String(f.runs().find((r) => r.id === named.body.runId)!.runContext)).timeoutSeconds).toBe(42);
  });

  it('reads the day\'s ceiling through the owner\'s own schedule override', async () => {
    const f = await fixture();
    await f.dispatch();
    await f.spore('sp_1', 'moved');
    expect(await f.dispatch()).toMatchObject({ status: 409, body: { error: 'max_runs_per_day' } });

    // A run that spent its money and produced nothing is a day an owner may lift.
    f.setting('agent.tasks', { [TASK]: { schedule: { maxRunsPerDay: 3 } } });
    await f.spore('sp_2', 'moved again');
    expect((await f.dispatch()).status).toBe(200);
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

    // The skip advanced the interval: a second wake inside it rebuilds nothing
    // and leaves no second row. A whole payload rebuilt on every wake would be
    // the cost the interval exists to bound.
    expect(await runScheduledTasks(f.env, 'sleep', Date.now(), 'https://s')).toMatchObject({ skipped: 0 });
    expect(f.runs().filter((r) => r.task === TASK)).toHaveLength(1);
  });

  it('stamps a start on a queued row it skips, so the run reads as something that happened', async () => {
    const f = await fixture();
    f.setting('agent.limits.concurrent_runs', 1);
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'blocker', ?, 'digest-only', 'running', ?)`, [HARNESS_AGENT_ID, Date.now()]);
    const queued = await f.dispatch();
    const runId = String(queued.body.runId);
    const built = await buildTaskInput(f.env, TASK, 'proj_1', Date.now());
    await upsertCortexInstructions(f.db, SCOPE, {
      agentId: HARNESS_AGENT_ID, content: '# held', inputHash: (built as { input: { inputHash: string } }).input.inputHash, generatedAt: NOW, sourceRunId: null,
    });
    f.sqlite.run(`UPDATE agent_runs SET status = 'completed' WHERE id = 'blocker'`);
    await drainQueue(f.env, Date.now());
    const row = f.sqlite.query(`SELECT status, started_at AS startedAt, completed_at AS completedAt FROM agent_runs WHERE id = ?`).get(runId) as { status: string; startedAt: number | null; completedAt: number | null };
    expect(row.status).toBe('skipped');
    expect(row.startedAt).toBeNumber();
    expect(row.completedAt).toBeNumber();
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
  it('names the report and the artifact the task must have left', () => {
    expect(RUN_CLOSE_REPORTS[TASK]).toEqual(['cortex_instructions']);
    expect(RUN_CLOSE_RULES[TASK]?.artifact).toBeFunction();
  });

  it('fails a run that reported nothing', async () => {
    const f = await fixture();
    f.liveRun('run_silent', TASK, { input_hash: 'h' }, 'THE PROMPT');
    expect(await f.close('run_silent')).toMatchObject({ persisted: true, applied: false, reason: 'postcondition' });
    const failed = await getRun(f.db, SCOPE, 'run_silent');
    expect({ status: failed?.status, error: failed?.error }).toEqual({ status: 'failed', error: RUN_CLOSE_ERROR });
  });

  it('fails a run that reported without leaving the row: the report is a claim, the row is the evidence', async () => {
    const f = await fixture();
    const credential = await f.credential();
    f.liveRun('run_claimed', TASK, { input_hash: 'h' }, 'THE PROMPT', false, credential.tokenId);
    await f.answered('/runs/report', { runId: 'run_claimed', agentId: HARNESS_AGENT_ID, action: 'cortex_instructions', summary: 'said so' }, credential.token);
    expect(await f.close('run_claimed', credential.token)).toMatchObject({ persisted: true, applied: false, reason: 'postcondition' });
    const failed = await getRun(f.db, SCOPE, 'run_claimed');
    expect({ status: failed?.status, error: failed?.error }).toEqual({ status: 'failed', error: RUN_CLOSE_ARTIFACT_ERROR });
  });

  it('closes a run that reported and wrote, and a dry run that reported and could not', async () => {
    const f = await fixture();
    const wrote = await f.credential();
    f.liveRun('run_wrote', TASK, { input_hash: 'h' }, 'THE PROMPT', false, wrote.tokenId);
    await f.answered('/runs/instructions-write', { runId: 'run_wrote', content: '# Start here' }, wrote.token);
    await f.answered('/runs/report', { runId: 'run_wrote', agentId: HARNESS_AGENT_ID, action: 'cortex_instructions', summary: 'wrote them' }, wrote.token);
    expect(await f.close('run_wrote', wrote.token)).toMatchObject({ persisted: true, changed: 1 });
    expect((await getRun(f.db, SCOPE, 'run_wrote'))?.status).toBe('completed');

    const dry = await f.credential();
    f.liveRun('run_dry_close', TASK, { input_hash: 'h' }, 'THE PROMPT', true, dry.tokenId);
    await f.answered('/runs/report', { runId: 'run_dry_close', agentId: HARNESS_AGENT_ID, action: 'cortex_instructions', summary: 'would have written' }, dry.token);
    expect(await f.close('run_dry_close', dry.token)).toMatchObject({ persisted: true, changed: 1 });
    expect((await getRun(f.db, SCOPE, 'run_dry_close'))?.status).toBe('completed');
  });
});

describe('the digest a run writes', () => {
  it('files one tier for the run\'s agent under the server\'s hash, and answers a caller holding no such run nothing', async () => {
    const f = await fixture();
    f.liveRun('run_digest', DIGEST_TASK, { input_hash: 'server-hash', counts: { spores: 7, sessionsInWindow: 2, windowFull: false } });
    f.liveRun('run_other', TASK, { input_hash: 'h' });
    expect(await f.answered('/runs/digest-write', { runId: 'run_digest', tier: 5000, content: '# the digest' }))
      .toEqual({ persisted: true, held: true, written: true, tier: 5000, revisionOf: null });

    const rows = await listDigests(f.db, SCOPE);
    expect(rows.map((r) => ({ agentId: r.agentId, tier: r.tier, content: r.content, substrateHash: r.substrateHash })))
      .toEqual([{ agentId: HARNESS_AGENT_ID, tier: 5000, content: '# the digest', substrateHash: 'server-hash' }]);

    // A run of another task, and a caller holding no run at all, write nothing.
    expect(await f.answered('/runs/digest-write', { runId: 'run_other', tier: 5000, content: '# nope' }))
      .toEqual({ persisted: true, held: false, written: false });
    expect(await f.answered('/runs/digest-write', { runId: 'run_absent', tier: 5000, content: '# nope' }))
      .toEqual({ persisted: true, held: false, written: false });
    expect((await listDigests(f.db, SCOPE)).map((r) => r.content)).toEqual(['# the digest']);
  });

  it('refuses a tier the Deployment does not serve, by name', async () => {
    const f = await fixture();
    f.liveRun('run_digest', DIGEST_TASK, { input_hash: 'h' });
    const answered = await f.answered('/runs/digest-write', { runId: 'run_digest', tier: 3000, content: '# nope' });
    expect(String(answered.reason)).toContain('tier is one of 1500, 5000, 10000');
    expect(await listDigests(f.db, SCOPE)).toEqual([]);
  });

  it('writes nothing for a dry run', async () => {
    const f = await fixture();
    f.liveRun('run_dry', DIGEST_TASK, { input_hash: 'h' }, null, true);
    expect(await f.answered('/runs/digest-write', { runId: 'run_dry', tier: 1500, content: '# nope' }))
      .toEqual({ persisted: true, held: true, written: false });
    expect(await listDigests(f.db, SCOPE)).toEqual([]);
  });

  it('archives the body it replaces, naming the run that replaced it and what its material counted', async () => {
    const f = await fixture();
    f.liveRun('run_first', DIGEST_TASK, { input_hash: 'hash-one', counts: { spores: 4, sessionsInWindow: 1, windowFull: false } });
    expect((await f.answered('/runs/digest-write', { runId: 'run_first', tier: 5000, content: '# first' })).revisionOf).toBeNull();

    const second = await f.credential();
    f.liveRun('run_second', DIGEST_TASK, { input_hash: 'hash-two', counts: { spores: 9, sessionsInWindow: 3, windowFull: false } }, null, false, second.tokenId);
    const answered = await f.answered('/runs/digest-write', { runId: 'run_second', tier: 5000, content: '# second' }, second.token);
    expect(answered).toMatchObject({ written: true, tier: 5000 });
    expect(typeof answered.revisionOf).toBe('number');

    const revisions = f.sqlite.query(`SELECT id, tier, content, metadata, run_id AS runId, parent_revision_id AS parentRevisionId FROM digest_extract_revisions ORDER BY id`).all() as Array<Record<string, unknown>>;
    expect(revisions.map((r) => ({ tier: r.tier, content: r.content, runId: r.runId, metadata: r.metadata, parentRevisionId: r.parentRevisionId })))
      .toEqual([{ tier: 5000, content: '# first', runId: 'run_second', metadata: JSON.stringify({ spores: 9, sessionsInWindow: 3, windowFull: false }), parentRevisionId: null }]);

    const third = await f.credential();
    f.liveRun('run_third', DIGEST_TASK, { input_hash: 'hash-three' }, null, false, third.tokenId);
    await f.answered('/runs/digest-write', { runId: 'run_third', tier: 5000, content: '# third' }, third.token);
    const chained = f.sqlite.query(`SELECT id, content, parent_revision_id AS parentRevisionId FROM digest_extract_revisions ORDER BY id`).all() as Array<{ id: number; content: string; parentRevisionId: number | null }>;
    expect(chained.map((r) => r.content)).toEqual(['# first', '# second']);
    expect(chained[1]!.parentRevisionId).toBe(chained[0]!.id);
    expect((await listDigests(f.db, SCOPE)).map((r) => ({ content: r.content, substrateHash: r.substrateHash })))
      .toEqual([{ content: '# third', substrateHash: 'hash-three' }]);
  });

  it('admits a digest run to the material a Cortex run reads', async () => {
    const f = await fixture();
    f.liveRun('run_digest', DIGEST_TASK, { input_hash: 'h' });
    f.session('s1', 'Session one', true);
    await f.spore('sp_1', 'the digest run reads this');
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: HARNESS_AGENT_ID, tier: 5000, content: 'held', substrateHash: null, generatedAt: NOW });

    expect(((await f.answered('/runs/sessions', { runId: 'run_digest' })).sessions as unknown[]).length).toBe(1);
    expect(((await f.answered('/runs/spores', { runId: 'run_digest' })).spores as unknown[]).length).toBe(1);
    expect(await f.answered('/runs/digest', { runId: 'run_digest', tier: 5000 }))
      .toEqual({ persisted: true, held: true, digest: { tier: 5000, content: 'held', generatedAt: NOW, fallback: false } });
    // The run that WRITES the tiers is served the tier it asked for or nothing: a
    // neighbour's body carried forward under an absent tier's name collapses the two.
    expect(await f.answered('/runs/digest', { runId: 'run_digest', tier: 10000 }))
      .toEqual({ persisted: true, held: true, digest: null });
  });

  it('hands a digest run its tier window rather than the page any other run may ask for', async () => {
    const f = await fixture();
    f.liveRun('run_digest', DIGEST_TASK, { input_hash: 'h' });
    const second = await f.credential();
    f.liveRun('run_cortex', TASK, { input_hash: 'h' }, null, false, second.tokenId);
    for (let i = 0; i < DIGEST_SESSION_PAGE_LIMIT + 1; i += 1) f.session(`s${i}`, `Session ${i}`, true);
    for (let i = 0; i < DIGEST_SPORE_PAGE_LIMIT + 1; i += 1) await f.spore(`sp_${i}`, `spore ${i}`);

    const digestSessions = await f.answered('/runs/sessions', { runId: 'run_digest', limit: 9999 });
    const cortexSessions = await f.answered('/runs/sessions', { runId: 'run_cortex', limit: 9999 }, second.token);
    expect((digestSessions.sessions as unknown[]).length).toBe(DIGEST_SESSION_PAGE_LIMIT);
    expect((cortexSessions.sessions as unknown[]).length).toBe(DIGEST_SESSION_PAGE_LIMIT + 1);

    const digestSpores = await f.answered('/runs/spores', { runId: 'run_digest', limit: 200 });
    const cortexSpores = await f.answered('/runs/spores', { runId: 'run_cortex', limit: 200 }, second.token);
    expect((digestSpores.spores as unknown[]).length).toBe(DIGEST_SPORE_PAGE_LIMIT);
    expect((cortexSpores.spores as unknown[]).length).toBe(DIGEST_SPORE_PAGE_LIMIT + 1);
  });

  it('carries the owner\'s from-scratch ask onto the run\'s own context, and never answers a digest ask unchanged', async () => {
    const f = await fixture();
    const first = await f.dispatch({ task: DIGEST_TASK, fresh: true });
    expect(first.status).toBe(200);
    const rowOf = (runId: unknown) => f.runs().find((r) => r.id === runId)!;
    const row = rowOf(first.body.runId);
    expect(JSON.parse(String(row.runContext)).fresh).toBe(true);
    expect(String(row.instruction)).toContain('write every tier from the material alone');

    // A second ask over material that has not moved still starts a run: the run
    // itself judges tier by tier what is worth rewriting.
    const again = await f.dispatch({ task: DIGEST_TASK });
    expect(again.body.outcome).toBeUndefined();
    expect(String(again.body.runId)).toStartWith('run_');
    const plain = rowOf(again.body.runId);
    expect(JSON.parse(String(plain.runContext)).fresh).toBeUndefined();
    expect(String(plain.instruction)).not.toContain('write every tier from the material alone');
  });

  it('names the reports that close a digest run', () => {
    expect(RUN_CLOSE_REPORTS[DIGEST_TASK]).toEqual(['digest', 'skip']);
  });

  it('closes a run that reported a skip, which owes no row at all', async () => {
    const f = await fixture();
    f.liveRun('run_skipped', DIGEST_TASK, { input_hash: 'h' });
    await f.answered('/runs/report', { runId: 'run_skipped', agentId: HARNESS_AGENT_ID, action: 'skip', summary: 'already current' });
    expect(await f.close('run_skipped')).toMatchObject({ persisted: true, changed: 1 });
    expect((await getRun(f.db, SCOPE, 'run_skipped'))?.status).toBe('completed');
  });

  it('closes a run that reported and wrote, and fails one that reported and left no tier', async () => {
    const f = await fixture();
    const wrote = await f.credential();
    f.liveRun('run_wrote', DIGEST_TASK, { input_hash: 'h' }, null, false, wrote.tokenId);
    await f.answered('/runs/digest-write', { runId: 'run_wrote', tier: 5000, content: '# a tier' }, wrote.token);
    await f.answered('/runs/report', { runId: 'run_wrote', agentId: HARNESS_AGENT_ID, action: 'digest', summary: 'wrote one tier' }, wrote.token);
    expect(await f.close('run_wrote', wrote.token)).toMatchObject({ persisted: true, changed: 1 });
    expect((await getRun(f.db, SCOPE, 'run_wrote'))?.status).toBe('completed');

    const claimed = await f.credential();
    f.liveRun('run_claimed', DIGEST_TASK, { input_hash: 'another-hash' }, null, false, claimed.tokenId);
    await f.answered('/runs/report', { runId: 'run_claimed', agentId: HARNESS_AGENT_ID, action: 'digest', summary: 'said so' }, claimed.token);
    expect(await f.close('run_claimed', claimed.token)).toMatchObject({ persisted: true, applied: false, reason: 'postcondition' });
    const failed = await getRun(f.db, SCOPE, 'run_claimed');
    expect({ status: failed?.status, error: failed?.error }).toEqual({ status: 'failed', error: RUN_CLOSE_ARTIFACT_ERROR });

    const dry = await f.credential();
    f.liveRun('run_dry_close', DIGEST_TASK, { input_hash: 'h' }, null, true, dry.tokenId);
    await f.answered('/runs/report', { runId: 'run_dry_close', agentId: HARNESS_AGENT_ID, action: 'digest', summary: 'would have written' }, dry.token);
    expect(await f.close('run_dry_close', dry.token)).toMatchObject({ persisted: true, changed: 1 });
  });

  it('reads a run that reported nothing as owing its report', async () => {
    const f = await fixture();
    f.liveRun('run_silent', DIGEST_TASK, { input_hash: 'h' });
    expect(await f.close('run_silent')).toMatchObject({ persisted: true, applied: false, reason: 'postcondition' });
    const failed = await getRun(f.db, SCOPE, 'run_silent');
    expect({ status: failed?.status, error: failed?.error }).toEqual({ status: 'failed', error: RUN_CLOSE_ERROR });
  });
});

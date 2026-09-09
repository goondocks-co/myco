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
import { dispatchLoad, getRun, upsertCortexInstructions } from '@myco-server-worker/core/runs.js';
import { listDigests, upsertDigest } from '@myco-server-worker/core/digests.js';
import { insertSpore } from '@myco-server-worker/core/spores.js';
import { RUN_CLOSE_ARTIFACT_ERROR, RUN_CLOSE_ERROR, RUN_CLOSE_REPORTS, RUN_CLOSE_RULES } from '@myco-server-worker/core/run-postconditions.js';
import { buildTaskInput } from '@myco-server-worker/core/task-inputs.js';
import {
  DIGEST_FULL_READ_BODY_CHARS, DIGEST_SESSION_PAGE_LIMIT, DIGEST_SPORE_PAGE_LIMIT, RUN_SESSION_LABEL_CHARS,
  RUN_SESSION_SUMMARY_CHARS, RUN_SESSION_TITLE_CHARS,
} from '@myco-server-worker/core/cortex-input.js';
import { SPORE_BODY_CHARS } from '@myco-server-worker/core/spores.js';
import { memberHeaders, sqliteEnv, withHarness } from './helpers/fixtures.js';
import { runToolCalls } from '@myco-server-worker/read/runs.js';
import { asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const TASK = 'digest-only';
const DIGEST_TASK = 'digest-only';
type Launch = { runId: string; timeoutSeconds: number; envVars: Record<string, string> };

async function fixture(opts: { capability?: boolean } = {}) {
  const e = sqliteEnv();
  const launches: Launch[] = [];
  // The entry maps its own deployment, so a launch reaches it only as the recording runtime.
  const bindings = { ...e.env, ...OWNER_ENV, HARNESS_LAUNCH_MODE: 'record' } as never;
  const base = withHarness(() => serverEnvFromBindings(bindings), { launch: async (spec) => { launches.push(spec); } });
  const env: ServerEnv = { ...base, wake: async () => {} };
  const setting = (leaf: string, value: unknown) =>
    e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'mem_1')`, [leaf, JSON.stringify(value), NOW]);
  setting('agent.provider.type', 'openai-compatible');
  setting('agent.provider.model', 'm');
  setting('agent.provider.base_url', 'http://models.internal/v1');
  e.sqlite.run(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', ?, ?, 'test')`, [opts.capability === false ? 0 : 1, NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`, [HARNESS_AGENT_ID, NOW]);
  await ensureMember(e.db, HARNESS_MEMBER_ID, NOW, 'member', 'harness runtime');
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
    content, context: null, filePath: null, tags: null, contentHash: null, properties: null, author: null, createdAt: NOW,
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
    // A surviving run route, so the assertion runs against a real answer
    // rather than an auth refusal.
    expect(await f.answered('/runs/digest', { runId: 'run_1' })).toMatchObject({ held: true });
    expect(f.executed.slice(before).some((sql) => sql.includes('instruction'))).toBe(false);
  });



  it('stays dry through the container\'s own claim: the claim never carries dry_run', async () => {
    const f = await fixture();
    // The dispatcher recorded a dry run; the container claims it the way the
    // runtime does, naming no dryRun of its own.
    f.pendingRun('run_dry_claim', TASK, { input_hash: 'server-hash' }, 'THE PROMPT', true);
    expect(await f.answered('/runs/claim', { id: 'run_dry_claim', agentId: HARNESS_AGENT_ID, task: TASK, capability: 'cortex', harness: 'claude-sdk' }))
      .toMatchObject({ persisted: true, claimed: true });
    expect(f.runs().find((r) => r.id === 'run_dry_claim')).toMatchObject({ status: 'running', dryRun: 1 });
    expect(await f.answered('/runs/digest-write', { runId: 'run_dry_claim', tier: 1500, content: '# nope' }))
      .toEqual({ persisted: true, held: true, written: false });
    expect(await listDigests(f.db, SCOPE)).toEqual([]);
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

  it('serves one digest tier in full and every tier\'s shape when none is named', async () => {
    const f = await fixture();
    f.liveRun('run_1', TASK, { input_hash: 'h' });
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: HARNESS_AGENT_ID, tier: 5000, content: 'the digest', substrateHash: null, generatedAt: NOW });
    expect(await f.answered('/runs/digest', { runId: 'run_1', tier: 5000 }))
      .toEqual({ persisted: true, held: true, digest: { tier: 5000, content: 'the digest', generatedAt: NOW, fallback: false } });
    // A run that writes tiers is served its exact tier or nothing: a nearest-tier
    // answer would have it rewrite one tier's body under another tier's name.
    expect(await f.answered('/runs/digest', { runId: 'run_1', tier: 10000 }))
      .toEqual({ persisted: true, held: true, digest: null });
    expect(await f.answered('/runs/digest', { runId: 'run_1' }))
      .toEqual({ persisted: true, held: true, tiers: [{ tier: 5000, generatedAt: NOW, contentLength: 10 }] });
    expect(await f.answered('/runs/digest', { runId: 'run_absent' })).toEqual({ persisted: true, held: false });
  });
});

describe('a dispatch of a Cortex task', () => {
  it('carries the prompt on the run row and the hash and counts in its context', async () => {
    const f = await fixture();
    f.session('s1', 'Session one', true);
    const answered = await f.dispatch();
    expect(answered.status).toBe(200);
    const row = f.runs().find((r) => r.task === TASK)!;
    expect(String(row.instruction)).toContain('## Material behind this pass');
    const context = JSON.parse(String(row.runContext)) as Record<string, unknown>;
    expect(typeof context.input_hash).toBe('string');
    expect(context.counts).toEqual({ spores: 0, sessionsInWindow: 1, windowFull: false });
    expect(row.dryRun).toBe(0);
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
    // Two tasks declare a budget of their own, and they differ: a single
    // declared value would pass a dispatcher that ignored the table.
    expect(Object.values(TASK_RUN_TIMEOUT_SECONDS).length).toBeGreaterThan(1);
    expect(new Set(Object.values(TASK_RUN_TIMEOUT_SECONDS)).size).toBeGreaterThan(1);

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


});


describe('the digest a run writes', () => {
  it('files one tier for the run\'s agent under the server\'s hash, and answers a caller holding no such run nothing', async () => {
    const f = await fixture();
    f.liveRun('run_digest', DIGEST_TASK, { input_hash: 'server-hash', counts: { spores: 7, sessionsInWindow: 2, windowFull: false } });
    f.liveRun('run_other', 'title-summary', { input_hash: 'h' });
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

  it('serves a digest run the tier it asked for, or nothing', async () => {
    const f = await fixture();
    f.liveRun('run_digest', DIGEST_TASK, { input_hash: 'h' });
    f.session('s1', 'Session one', true);
    await f.spore('sp_1', 'the digest run reads this');
    await upsertDigest(f.db, SCOPE, { id: 'd1', agentId: HARNESS_AGENT_ID, tier: 5000, content: 'held', substrateHash: null, generatedAt: NOW });

    expect(await f.answered('/runs/digest', { runId: 'run_digest', tier: 5000 }))
      .toEqual({ persisted: true, held: true, digest: { tier: 5000, content: 'held', generatedAt: NOW, fallback: false } });
    // The run that WRITES the tiers is served the tier it asked for or nothing: a
    // neighbour's body carried forward under an absent tier's name collapses the two.
    expect(await f.answered('/runs/digest', { runId: 'run_digest', tier: 10000 }))
      .toEqual({ persisted: true, held: true, digest: null });
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
    // itself judges tier by tier what is worth rewriting. The day's ceiling is
    // what stops a second ask, not the material.
    f.setting('agent.tasks', { [DIGEST_TASK]: { schedule: { maxRunsPerDay: 2 } } });
    const again = await f.dispatch({ task: DIGEST_TASK });
    expect(again.body.outcome).toBeUndefined();
    expect(String(again.body.runId)).toStartWith('run_');
    const plain = rowOf(again.body.runId);
    expect(JSON.parse(String(plain.runContext)).fresh).toBeUndefined();
    expect(String(plain.instruction)).not.toContain('write every tier from the material alone');
  });

  it('holds a digest ask to one a day, the dearest task the Deployment starts', async () => {
    const f = await fixture();
    expect((await f.dispatch({ task: DIGEST_TASK })).status).toBe(200);
    expect(await f.dispatch({ task: DIGEST_TASK })).toMatchObject({ status: 409, body: { error: 'max_runs_per_day' } });
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

/**
 * The other door a run reaches this Deployment through.
 *
 * A container drives the run routes itself and never touches the MCP tool
 * surface, so a record that held only `tools/call` would read a working
 * container run as one that never called at all — the very reading the record
 * exists to make.
 */
describe('what a run reaching the Deployment over its own routes records', () => {
  it('records each run route the run drove, in the one list its tool calls land in', async () => {
    const f = await fixture();
    const minted = await f.credential();
    f.liveRun('run_routed', DIGEST_TASK, { input_hash: 'h' }, null, false, minted.tokenId);

    await f.answered('/runs/report', { runId: 'run_routed', agentId: HARNESS_AGENT_ID, action: 'digest', summary: 'wrote a tier' }, minted.token);
    await f.answered('/runs/digest-write', { runId: 'run_routed', tier: 5000, content: '# a tier' }, minted.token);

    const calls = await runToolCalls(f.db, SCOPE, 'run_routed');
    expect(calls.map((c) => c.tool)).toEqual(['/runs/report', '/runs/digest-write']);
  });

  it('records the claim itself, so a container that claims and then dies has one call against it', async () => {
    const f = await fixture();
    // A claim is the call that MAKES a run held, so nothing holds it beforehand.
    // A record that skipped it would read a container that claimed and died as
    // one that never reached this Deployment at all.
    f.pendingRun('run_claimed_only', TASK, { input_hash: 'server-hash' }, 'THE PROMPT');
    expect(await f.answered('/runs/claim', { id: 'run_claimed_only', agentId: HARNESS_AGENT_ID, task: TASK, capability: 'cortex', harness: 'claude-sdk' }))
      .toMatchObject({ persisted: true, claimed: true });
    expect((await runToolCalls(f.db, SCOPE, 'run_claimed_only')).map((c) => c.tool)).toEqual(['/runs/claim']);
  });

  it('records nothing for a route it refused, so a malformed call leaves no row', async () => {
    const f = await fixture();
    const minted = await f.credential();
    f.liveRun('run_malformed', DIGEST_TASK, { input_hash: 'h' }, null, false, minted.tokenId);

    // A report naming no action is refused on its shape. Reaching the
    // Deployment and being turned away is the one thing neither door records:
    // a credential may not turn calls it may not make into rows.
    expect(await f.answered('/runs/report', { runId: 'run_malformed', agentId: HARNESS_AGENT_ID }, minted.token))
      .toMatchObject({ persisted: false });
    expect(await runToolCalls(f.db, SCOPE, 'run_malformed')).toEqual([]);

    // The same route, answered, does record.
    await f.answered('/runs/report', { runId: 'run_malformed', agentId: HARNESS_AGENT_ID, action: 'digest', summary: 'wrote it' }, minted.token);
    expect((await runToolCalls(f.db, SCOPE, 'run_malformed')).map((c) => c.tool)).toEqual(['/runs/report']);
  });

  it('records nothing against a run for a credential that holds none', async () => {
    const f = await fixture();
    f.liveRun('run_unheld', DIGEST_TASK, { input_hash: 'h' });
    // A member's own credential drives the route, not a run's. It holds no run,
    // so there is nothing for the call to be recorded against and the run's list
    // stays the empty one that says its own runtime never called.
    const plain = (await issueMemberToken(f.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW)).token;
    await f.answered('/runs/report', { runId: 'run_unheld', agentId: HARNESS_AGENT_ID, action: 'digest', summary: 'said so' }, plain);
    expect(await runToolCalls(f.db, SCOPE, 'run_unheld')).toEqual([]);
  });
});

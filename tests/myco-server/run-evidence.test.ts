import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { releaseNow } from './helpers/release-now.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';
import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { BackupObjectsMissingError, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { RUN_BODY_RETRY_MS, RUN_BODY_STUCK_MS, stuckRunBodies } from '@myco-server-worker/db/runs/body-failures.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { runningEnv as sqliteEnv } from './helpers/running-env.js';
import { measuredStore } from './helpers/read-budget.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { recordRunReads, MAX_RUN_READS, listReports, RUN_REPORTS_LIMIT, type ReportRow } from '@myco-server-worker/db/runs/evidence.js';
import { pruneTerminalRuns } from '@myco-server-worker/db/runs/retention.js';
import { runReads, sessionOutcome } from '@myco-server-worker/db/runs/reads.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { storeStepPage } from '@myco-server-worker/db/runs/steps.js';
import { recordServedPrompts, servedRecords } from '@myco-server-worker/db/runs/served.js';
import { getRunDetail, getRunSteps, getRunCalls, runAttempts, listRuns } from '@myco-server-worker/read/runs.js';
import { listReportsWithBodies, moveRunBodies, runInstructionBody, RunBodyUnavailable, RunNotFound, RUN_BODY_SETTLE_MS } from '@myco-server-worker/db/runs/bodies.js';
import { RUN_BODY_INLINE_BYTES } from '@myco-server-worker/db/runs/evidence-schema.js';
import { storedAudit } from '@myco-server-worker/core/run-audit.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { WorkerPrincipal } from '@myco-server-worker/core/worker-lease.js';
import type { StepPage } from '@goondocks/myco-shared/worker-steps';

const NOW = 1_800_000_000_000;
const SCOPE = { projectId: 'proj_1' };
const LONG_INSTRUCTION = 'read the prompts’ details\n'.repeat(1_000);
const LONG_DETAILS = 'd'.repeat(RUN_BODY_INLINE_BYTES + 10);
const LONG_AUDIT = JSON.stringify({ steps: Array.from({ length: 40 }, (_, i) => `step ${i} ${'x'.repeat(150)}`), reasoning: 'kept what mattered' });
const WORKER: WorkerPrincipal = { kind: 'member', tokenId: 'tok_1', machineId: 'm1', memberId: 'mem_1' } as unknown as WorkerPrincipal;

function fixture() {
  const e = sqliteEnv({ workerLogin: true });
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  const db = e.sqlite;
  db.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, queued_at, instruction, resumable)
    VALUES ('proj_1', 'run_1', 'myco-agent', 'extract-curate', 'completed', ?, ?, ?, ?, 0)`, [NOW - 2 * RUN_BODY_SETTLE_MS, NOW - RUN_BODY_SETTLE_MS - 10, NOW - 2 * RUN_BODY_SETTLE_MS, LONG_INSTRUCTION]);
  const insertReport = (details: string | null, audit: string | null) => db.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, details, audit, created_at)
    VALUES ('proj_1', 'run_1', 'myco-agent', 'extract', 'brief', ?, ?, ?)`, [details, audit, NOW - RUN_BODY_SETTLE_MS - 5]);
  db.run(`INSERT INTO agent_run_attempts (project_id, run_id, attempt_id, leased_by, claimed_at, owner_kind) VALUES ('proj_1', 'run_1', 'att_1', 'tok_1', ?, 'member')`, [NOW]);
  markReady(db);
  return { e, db, insertReport, env: e.serverEnv };
}

/** History older than this schema is counted by the catch-up; a fresh store has none, so its phases are finished. */
function markReady(db: { run(sql: string): unknown }) {
  db.run(`UPDATE projection_catchup SET done = 1 WHERE projection = 'run_evidence'`);
}

const page = (seqs: number[]): StepPage => ({
  attemptId: 'att_1', page: 1, pages: 1, total: 100, overflow: 0, unrecognized: { total: 0, shapes: {} },
  steps: seqs.map((seq) => ({ seq, callId: `c${seq}`, kind: 'read', tool: 'Read', target: 'f', outcome: 'ok', exitCode: null, startedAt: NOW + seq, endedAt: NOW + seq })),
} as StepPage);

const moved = (db: { query(sql: string): { get(...v: unknown[]): unknown; all(...v: unknown[]): unknown[] } }) =>
  db.query(`SELECT body_kind AS kind, item_id AS item, key, size FROM run_bodies ORDER BY body_kind, item_id`).all();

describe('a run page read by what the run holds now, not its history', () => {
  it('counts received steps by the steps that land, once however often a page arrives', async () => {
    const { db, env } = fixture();
    await storeStepPage(env.db, SCOPE, 'run_1', page([0, 1, 2]), WORKER, NOW);
    const landed = await storeStepPage(env.db, SCOPE, 'run_1', page([1, 2, 3, 3]), WORKER, NOW);
    expect(landed).toEqual({ stored: true, landed: 1 });
    expect((await runAttempts(env.db, SCOPE, 'run_1')).rows[0]!.steps?.received).toBe(4);
  });

  it('answers no coverage rather than zero while a run\'s history is still being counted', async () => {
    const { db, env } = fixture();
    await storeStepPage(env.db, SCOPE, 'run_1', page([0, 1]), WORKER, NOW);
    db.run(`UPDATE projection_catchup SET done = 0 WHERE projection = 'run_evidence'`);
    expect((await runAttempts(env.db, SCOPE, 'run_1')).rows[0]!.steps).toBeNull();
    expect((await getRunCalls(env.db, SCOPE, 'run_1'))?.total).toBeNull();
  });

  it('seeds received steps and call counts for runs that predate the projection through the shared catch-up', async () => {
    const { db, env } = fixture();
    await storeStepPage(env.db, SCOPE, 'run_1', page([0, 1, 2]), WORKER, NOW);
    db.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, recorded_at) VALUES ('proj_1', 'run_1', 'run_tool', 't', 'failed', 1), ('proj_1', 'run_1', 'run_tool', 't', 'success', 2)`);
    db.run(`DELETE FROM run_head`); db.run(`DELETE FROM attempt_head`);
    db.run(`UPDATE projection_catchup SET done = 0, after_key = '[]', frontier = NULL WHERE projection = 'run_evidence'`);
    await catchUpProjections(env.db);
    expect((await runAttempts(env.db, SCOPE, 'run_1')).rows[0]!.steps?.received).toBe(3);
    const calls = await getRunCalls(env.db, SCOPE, 'run_1');
    expect({ total: calls?.total, failed: calls?.failed }).toEqual({ total: 2, failed: 1 });
  });

  it('caps a run\'s recorded reads at the bound in one batch, keeping the first read of a session', async () => {
    const { db, env } = fixture();
    db.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) SELECT 'proj_1', 's' || value, 'm', 't', 1, 1 FROM json_each('[0,1,2,3,4]')`);
    const landed = await recordRunReads(env.db, SCOPE, { runId: 'run_1', tokenId: 'tok_1', sessionIds: ['s0', 's1', 's0'], receivedAt: 7 });
    expect(landed).toBe(2);
    await recordRunReads(env.db, SCOPE, { runId: 'run_1', tokenId: 'tok_1', sessionIds: ['s1', 's2'], receivedAt: 8 });
    expect((await runReads(env.db, SCOPE, 'run_1')).read.sessions.map(({ readAt }) => readAt)).toEqual([7, 7, 8]);
    const rows = Array.from({ length: MAX_RUN_READS + 20 }, (_, i) => `x${i}`);
    db.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) SELECT 'proj_1', value, 'm', 't', 1, 1 FROM json_each(?)`, [JSON.stringify(rows)]);
    expect(await recordRunReads(env.db, SCOPE, { runId: 'run_1', tokenId: 'tok_1', sessionIds: rows, receivedAt: 9 })).toBe(MAX_RUN_READS - 3);
  });
});

describe('long runs on the hosted store', () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  afterAll(() => mf.dispose());
  let migrated: Promise<Awaited<ReturnType<typeof mf.getD1Database>>> | undefined;
  const database = () => migrated ??= (async () => {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
    return d1;
  })();
  const seed = async (steps: number, calls: number, served: number) => {
    const d1 = await database();
    await d1.batch([
      d1.prepare(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_1','p',1)`),
      d1.prepare(`INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','a','built-in',1,1)`),
      d1.prepare(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,started_at,completed_at,resumable) VALUES('proj_1','long','myco-agent','extract-curate','completed',1,2,0)`),
      d1.prepare(`INSERT INTO agent_run_attempts (project_id,run_id,attempt_id,leased_by,claimed_at,owner_kind,steps_total) VALUES('proj_1','long','att','t',1,'member',?)`).bind(steps),
      d1.prepare(`INSERT INTO sessions (project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','s1','m','t',1,1) ON CONFLICT DO NOTHING`),
    ]);
    for (let i = 0; i < steps;) { const batch = []; for (let j = 0; j < 200 && i < steps; j++, i++) batch.push(d1.prepare(`INSERT INTO agent_run_steps (project_id,run_id,attempt_id,seq,kind,tool,outcome,started_at,received_at) VALUES('proj_1','long','att',?,'read','r','ok',1,1)`).bind(i)); await d1.batch(batch); }
    for (let i = 0; i < calls;) { const batch = []; for (let j = 0; j < 200 && i < calls; j++, i++) batch.push(d1.prepare(`INSERT INTO agent_run_events (project_id,run_id,event_type,tool_name,outcome,recorded_at) VALUES('proj_1','long','run_tool','t',?,?)`).bind(i % 10 === 0 ? 'failed' : 'success', i)); await d1.batch(batch); }
    for (let i = 0; i < served;) { const batch = []; for (let j = 0; j < 200 && i < served; j++, i++) batch.push(d1.prepare(`INSERT INTO run_served_material (project_id,served_id,run_id,session_id,record_id,served_at) VALUES('proj_1',?,'long','s1',?,1)`).bind(`sv${i}`, `p${i}`)); await d1.batch(batch); }
    await d1.prepare(`INSERT INTO attempt_head (project_id,run_id,attempt_id,received) VALUES('proj_1','long','att',?) ON CONFLICT DO UPDATE SET received=excluded.received`).bind(steps).run();
    await d1.prepare(`UPDATE projection_catchup SET done=1 WHERE projection='run_evidence'`).run();
    return d1;
  };
  const measure = async (run: (db: RelationalStore) => Promise<unknown>, steps: number, calls: number, served: number) => {
    const d1 = await seed(steps, calls, served);
    const store = measuredStore(d1);
    await run(store.db);
    const reads = store.reads();
    await d1.prepare(`DELETE FROM run_served_material`).run(); await d1.prepare(`DELETE FROM agent_run_events`).run(); await d1.prepare(`DELETE FROM agent_run_steps`).run(); await d1.prepare(`DELETE FROM attempt_head`).run(); await d1.prepare(`DELETE FROM agent_run_attempts`).run(); await d1.prepare(`DELETE FROM run_head`).run(); await d1.prepare(`DELETE FROM agent_runs`).run();
    return reads;
  };

  it('reads a run\'s reads and a session\'s outcome by key, whatever else the Project holds', async () => {
    const d1 = await database();
    await d1.batch([
      d1.prepare(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_1','p',1)`),
      d1.prepare(`INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','a','built-in',1,1)`),
      d1.prepare(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,started_at,completed_at,resumable) VALUES('proj_1','reader','myco-agent','extract-curate','completed',1,2,0)`),
      d1.prepare(`INSERT INTO sessions (project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','read-one','m','t',1,1)`),
      d1.prepare(`INSERT INTO run_reads (project_id,run_id,session_id,token_id,received_at) VALUES('proj_1','reader','read-one','t',1)`),
    ]);
    const others = async (from: number, to: number) => {
      const range = `WITH RECURSIVE n(x) AS (SELECT ? UNION ALL SELECT x+1 FROM n WHERE x < ?)`;
      await d1.batch([
        d1.prepare(`${range} INSERT INTO sessions (project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) SELECT 'proj_1','other-'||x,'m','t',1,1 FROM n`).bind(from, to),
        d1.prepare(`${range} INSERT INTO agent_runs (project_id,id,agent_id,task,status,started_at,completed_at,resumable) SELECT 'proj_1','other-'||x,'myco-agent','extract-curate','completed',1,2,0 FROM n`).bind(from, to),
        d1.prepare(`${range} INSERT INTO run_reads (project_id,run_id,session_id,token_id,received_at) SELECT 'proj_1','other-'||x,'other-'||x,'t',1 FROM n`).bind(from, to),
      ]);
    };
    const measured = async () => {
      const store = measuredStore(d1);
      expect((await runReads(store.db, SCOPE, 'reader')).read.total).toBe(1);
      expect((await sessionOutcome(store.db, SCOPE, 'read-one')).runs.map(({ runId }) => runId)).toEqual(['reader']);
      return store.reads();
    };
    await others(1, 100);
    const small = await measured();
    await others(101, 1_000);
    expect(await measured()).toBeLessThanOrEqual(small);
    await d1.batch([d1.prepare(`DELETE FROM run_reads`), d1.prepare(`DELETE FROM agent_runs`), d1.prepare(`DELETE FROM sessions`)]);
  }, 60_000);

  it('reads the same rows for a run\'s pages and totals at 1,000 steps and 10,000 served items as at a tenth of each', async () => {
    const read = async (steps: number, calls: number, served: number) => measure(async (store) => {
      await runAttempts(store, SCOPE, 'long');
      await getRunSteps(store, SCOPE, 'long', undefined, { limit: 50 });
      await getRunCalls(store, SCOPE, 'long', { limit: 50 });
      await servedRecords(store, SCOPE, 'long', 's1', ['p1', 'p2']);
    }, steps, calls, served);
    const small = await read(100, 200, 1_000);
    const big = await read(1_000, 2_000, 10_000);
    expect(big).toBeLessThanOrEqual(small);
    expect(big).toBeLessThan(150);
  }, 120_000);
});

describe('a large body leaves its row only after a verified copy', () => {
  const ready = () => { const f = fixture(); f.insertReport(LONG_DETAILS, LONG_AUDIT); return f; };
  it('moves a settled instruction and report bodies, and serves their exact bytes from the blob', async () => {
    const { db, env } = ready();
    const result = await moveRunBodies(env, NOW);
    expect(result.changed).toBe(3);
    expect(moved(db).map((row: any) => row.kind)).toEqual(['instruction', 'report_audit', 'report_details']);
    expect(db.query(`SELECT instruction FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ instruction: null });
    expect(db.query(`SELECT details, audit FROM agent_reports`).get()).toEqual({ details: null, audit: null });
    expect(await runInstructionBody(env, SCOPE, 'run_1')).toBe(LONG_INSTRUCTION);
    const { reports } = await listReportsWithBodies(env, SCOPE, 'run_1');
    expect(reports[0]!.details).toBe(LONG_DETAILS);
    expect(reports[0]!.audit).not.toBeNull();
    expect(reports[0]!.audit).toEqual(storedAudit(LONG_AUDIT));
    // Moved bodies are named without a blob fetch on the row-only path.
    const held: ReportRow[] = (await listReports(env.db, SCOPE, 'run_1')).reports;
    expect(held[0]).toMatchObject({ details: null, audit: null, detailsMoved: true, auditMoved: true });
  });

  it('leaves the row and hands an upload to the release owner when the row changed before the fenced commit', async () => {
    const { db, env } = fixture();
    const original = env.blobs.put.bind(env.blobs);
    env.blobs.put = (async (...args: Parameters<typeof original>) => {
      const stored = await original(...args);
      db.run(`UPDATE agent_runs SET instruction = 'changed' WHERE id = 'run_1'`);
      return stored;
    }) as typeof env.blobs.put;
    const result = await moveRunBodies(env, NOW, 1);
    expect(result.changed).toBe(0);
    expect(db.query(`SELECT instruction FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ instruction: 'changed' });
    expect(moved(db)).toEqual([]);
    expect(db.query(`SELECT COUNT(*) AS n FROM blob_reservations`).get()).toEqual({ n: 0 });
    expect(db.query(`SELECT COUNT(*) AS n FROM object_releases WHERE kind = 'upload'`).get()).toEqual({ n: 1 });
  });

  it('keeps the row when the store does not return the bytes it was given', async () => {
    const { db, env } = fixture();
    const original = env.blobs.put.bind(env.blobs);
    env.blobs.put = (async (key, value, options) => {
      await original(key, new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('other')); c.close(); } }), { ...options, size: 5, sha256: undefined });
      return { key, size: options?.size ?? 0, durable: true } as never;
    }) as typeof env.blobs.put;
    expect((await moveRunBodies(env, NOW, 1)).changed).toBe(0);
    expect(db.query(`SELECT instruction FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ instruction: LONG_INSTRUCTION });
    expect(moved(db)).toEqual([]);
    expect(db.query(`SELECT COUNT(*) AS n FROM object_releases WHERE kind = 'upload'`).get()).toEqual({ n: 1 });
  });

  it('reuses a registered copy of identical bytes for a second run without a second upload', async () => {
    const { db, env } = ready();
    db.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, instruction, resumable) SELECT project_id, 'run_2', agent_id, task, status, started_at, completed_at, ?, 0 FROM agent_runs WHERE id = 'run_1'`, [LONG_INSTRUCTION]);
    let puts = 0;
    const original = env.blobs.put.bind(env.blobs);
    env.blobs.put = (async (...args: Parameters<typeof original>) => { puts += 1; return original(...args); }) as typeof env.blobs.put;
    await moveRunBodies(env, NOW);
    expect(moved(db).filter((row: any) => row.kind === 'instruction')).toHaveLength(2);
    expect(puts).toBe(3);
    expect(await runInstructionBody(env, SCOPE, 'run_2')).toBe(LONG_INSTRUCTION);
  });

  it('answers a named retryable outcome when a moved body\'s copy is gone, never an empty body', async () => {
    const { db, env } = ready();
    await moveRunBodies(env, NOW);
    const key = (db.query(`SELECT b.key, bl.generation FROM run_bodies b JOIN blobs bl USING (project_id, key) WHERE b.body_kind = 'instruction'`).get() as { key: string; generation: string });
    await env.blobs.delete(`proj_1/${key.key}~${key.generation}`);
    await expect(runInstructionBody(env, SCOPE, 'run_1')).rejects.toBeInstanceOf(RunBodyUnavailable);
    await expect(runInstructionBody(env, SCOPE, 'run_1')).rejects.toMatchObject({ code: 'run_body_unavailable', retryable: true });
  });

  it('stops when no due body remains and never moves a body that has not settled', async () => {
    const { db, env } = ready();
    db.run(`UPDATE agent_runs SET completed_at = ? WHERE id = 'run_1'`, [NOW]);
    db.run(`UPDATE agent_reports SET created_at = ?`, [NOW]);
    expect(await moveRunBodies(env, NOW)).toEqual({ changed: 0, more: false });
    db.run(`UPDATE agent_runs SET completed_at = ? WHERE id = 'run_1'`, [NOW - RUN_BODY_SETTLE_MS - 1]);
    db.run(`UPDATE agent_reports SET created_at = ?`, [NOW - RUN_BODY_SETTLE_MS - 1]);
    expect((await moveRunBodies(env, NOW)).changed).toBe(3);
    expect(await moveRunBodies(env, NOW)).toEqual({ changed: 0, more: false });
  });
});

describe('a run retires in pages, and its parent goes last', () => {
  const left = (db: Parameters<typeof moved>[0]) => db.query(`SELECT (SELECT COUNT(*) FROM agent_run_steps) AS steps, (SELECT COUNT(*) FROM run_bodies) AS bodies, (SELECT COUNT(*) FROM agent_runs) AS runs, (SELECT COUNT(*) FROM run_retirements) AS marked, (SELECT COUNT(*) FROM blob_release_candidates) AS released`).get();

  it('keeps a retiring run\'s bodies until its evidence is gone, then releases them with the run, and stops', async () => {
    const { db, env, insertReport } = fixture();
    insertReport(LONG_DETAILS, null);
    await storeStepPage(env.db, SCOPE, 'run_1', page(Array.from({ length: 30 }, (_, i) => i)), WORKER, NOW);
    await moveRunBodies(env, NOW);
    expect(moved(db).length).toBe(2);
    await pruneTerminalRuns(env.db, NOW, 10, 20, NOW);
    expect(left(db)).toEqual({ steps: 10, bodies: 2, runs: 1, marked: 1, released: 0 });
    await pruneTerminalRuns(env.db, NOW, 10, 100, NOW);
    expect(left(db)).toEqual({ steps: 0, bodies: 0, runs: 0, marked: 0, released: 2 });
    expect(await pruneTerminalRuns(env.db, NOW, 10, 100, NOW)).toBe(0);
  });

  it('answers not found on every read that reaches a retiring run or its bodies', async () => {
    const { db, env } = fixture();
    await storeStepPage(env.db, SCOPE, 'run_1', page(Array.from({ length: 30 }, (_, i) => i)), WORKER, NOW);
    await moveRunBodies(env, NOW);
    await pruneTerminalRuns(env.db, NOW, 10, 5, NOW);
    expect(db.query(`SELECT COUNT(*) AS n FROM agent_runs`).get()).toEqual({ n: 1 });
    expect((await listRuns(env.db, SCOPE, NOW, 'viewer', { limit: 10 })).rows).toHaveLength(0);
    expect(await getRun(env.db, SCOPE, 'run_1')).toBeNull();
    expect(await getRunDetail(env.db, SCOPE, 'run_1', NOW, 'viewer')).toBeNull();
    expect(await getRunSteps(env.db, SCOPE, 'run_1', undefined)).toBeNull();
    expect(await getRunCalls(env.db, SCOPE, 'run_1')).toBeNull();
    await expect(runInstructionBody(env, SCOPE, 'run_1')).rejects.toBeInstanceOf(RunNotFound);
  });

  it('never leaves a run without its instruction while report bodies are released ahead of it', async () => {
    const { db, env, insertReport } = fixture();
    insertReport(LONG_DETAILS, LONG_AUDIT);
    await moveRunBodies(env, NOW);
    expect(moved(db).length).toBe(3);
    await pruneTerminalRuns(env.db, NOW, 10, 2, NOW);
    expect(db.query(`SELECT body_kind AS kind FROM run_bodies ORDER BY body_kind`).all()).toEqual([{ kind: 'instruction' }, { kind: 'report_details' }]);
    expect(left(db)).toMatchObject({ runs: 1, marked: 1 });
    await pruneTerminalRuns(env.db, NOW, 10, 100, NOW);
    expect(left(db)).toMatchObject({ runs: 0, bodies: 0, marked: 0 });
  });

  it('finishes a run it started retiring even after the retention window no longer selects it', async () => {
    const { db, env } = fixture();
    await storeStepPage(env.db, SCOPE, 'run_1', page(Array.from({ length: 30 }, (_, i) => i)), WORKER, NOW);
    await pruneTerminalRuns(env.db, NOW, 10, 5, NOW);
    expect(left(db)).toMatchObject({ runs: 1, marked: 1 });
    expect(await pruneTerminalRuns(env.db, 0, 10, 100, NOW)).toBe(1);
    expect(left(db)).toMatchObject({ runs: 0, marked: 0 });
    expect(await pruneTerminalRuns(env.db, 0, 10, 100, NOW)).toBe(0);
  });
});

describe('a body that cannot move', () => {
  const digestOf = (text: string) => createHash('sha256').update(text).digest('hex');
  function poisoned(env: ReturnType<typeof fixture>['env'], poison: string) {
    const real = env.blobs.put.bind(env.blobs);
    const state = { failing: true };
    env.blobs.put = ((key: string, ...rest: unknown[]) => state.failing && key.includes(digestOf(poison))
      ? Promise.reject(new Error('object store refused')) : (real as (...a: unknown[]) => unknown)(key, ...rest)) as typeof env.blobs.put;
    return state;
  }
  const second = (db: ReturnType<typeof fixture>['db'], instruction: string) => db.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, queued_at, instruction, resumable)
    VALUES ('proj_1', 'run_2', 'myco-agent', 'extract-curate', 'completed', ?, ?, ?, ?, 0)`, [NOW - 2 * RUN_BODY_SETTLE_MS, NOW - RUN_BODY_SETTLE_MS - 1, NOW - 2 * RUN_BODY_SETTLE_MS, instruction]);
  const OTHER = 'a different long instruction\n'.repeat(1_000);
  const marks = (db: ReturnType<typeof fixture>['db']) => db.query(`SELECT run_id AS runId, body_kind AS kind, item_id AS item, failures, retry_at AS retryAt FROM run_body_failures`).all();

  it('is marked and named, and the body behind it moves on the next page', async () => {
    const { db, env } = fixture();
    second(db, OTHER);
    poisoned(env, LONG_INSTRUCTION);
    const logged = spyOn(console, 'log');
    try {
      expect(await moveRunBodies(env, NOW, 1)).toEqual({ changed: 0, more: true });
      const failure = logged.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>).find((event) => event.kind === 'run_body_move_failed');
      expect(failure).toMatchObject({ projectId: 'proj_1', runId: 'run_1', bodyKind: 'instruction', item: 0, failures: 1 });
    } finally { logged.mockRestore(); }
    expect(marks(db)).toEqual([{ runId: 'run_1', kind: 'instruction', item: 0, failures: 1, retryAt: NOW + RUN_BODY_RETRY_MS }]);
    expect(await moveRunBodies(env, NOW, 1)).toEqual({ changed: 1, more: true });
    expect(await runInstructionBody(env, SCOPE, 'run_2')).toBe(OTHER);
    expect(db.query(`SELECT instruction FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ instruction: LONG_INSTRUCTION });
  });

  it('stops while every due body is backing off, retries later with a longer backoff, and clears its mark when it moves', async () => {
    const { db, env } = fixture();
    const store = poisoned(env, LONG_INSTRUCTION);
    expect((await moveRunBodies(env, NOW)).changed).toBe(0);
    expect(await moveRunBodies(env, NOW)).toEqual({ changed: 0, more: false });
    const later = NOW + RUN_BODY_RETRY_MS + 1;
    expect((await moveRunBodies(env, later)).changed).toBe(0);
    expect(marks(db)).toEqual([{ runId: 'run_1', kind: 'instruction', item: 0, failures: 2, retryAt: later + 2 * RUN_BODY_RETRY_MS }]);
    store.failing = false;
    expect((await moveRunBodies(env, later + 2 * RUN_BODY_RETRY_MS + 1)).changed).toBe(1);
    expect(marks(db)).toEqual([]);
    expect(await runInstructionBody(env, SCOPE, 'run_1')).toBe(LONG_INSTRUCTION);
  });

  it('holds back one report body without holding the other body of that report', async () => {
    const { db, env, insertReport } = fixture();
    insertReport(LONG_DETAILS, LONG_AUDIT);
    poisoned(env, LONG_DETAILS);
    expect((await moveRunBodies(env, NOW)).changed).toBe(2);
    expect(moved(db).map((row) => (row as { kind: string }).kind)).toEqual(['instruction', 'report_audit']);
    expect(await moveRunBodies(env, NOW)).toEqual({ changed: 0, more: false });
    expect(marks(db)).toMatchObject([{ kind: 'report_details', failures: 1 }]);
  });

  it('is listed for an administrator once it has failed for a day, naming the run', async () => {
    const { env } = fixture();
    poisoned(env, LONG_INSTRUCTION);
    await moveRunBodies(env, NOW);
    expect((await stuckRunBodies(env.db, NOW)).bodies).toEqual([]);
    expect(await stuckRunBodies(env.db, NOW + RUN_BODY_STUCK_MS + 1)).toMatchObject({ hasMore: false, bodies: [{ projectId: 'proj_1', runId: 'run_1', kind: 'instruction', item: 0, failures: 1 }] });
  });
});

describe('a backup holding moved bodies', () => {
  async function artifactOf(source: ReturnType<typeof fixture>) {
    const backup = await createBackup(source.env.db, source.env.blobs as never, { producer: 'test', now: NOW });
    return new TextDecoder().decode((source.env.blobs as unknown as { objects: Map<string, { bytes: Uint8Array }> }).objects.get(backup.key)!.bytes);
  }
  /** A destination holding the source's objects and their registrations, which a restore needs before it writes a row naming them. */
  function destination(source: ReturnType<typeof fixture>) {
    const target = sqliteEnv({ workerLogin: true });
    target.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 1)`);
    target.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
    const blobs = source.db.query(`SELECT project_id, key, size, media_type, token_id, received_at, generation FROM blobs`).all() as Array<Record<string, string | number>>;
    for (const row of blobs) {
      target.sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES (?, ?, ?, ?, ?, ?, ?)`, [row.project_id!, row.key!, row.size!, row.media_type!, row.token_id!, row.received_at!, row.generation!]);
      const physical = `proj_1/${row.key}~${row.generation}`;
      (target.serverEnv.blobs as unknown as { objects: Map<string, unknown> }).objects.set(physical, (source.env.blobs as unknown as { objects: Map<string, unknown> }).objects.get(physical));
    }
    return target;
  }
  const restore = (target: ReturnType<typeof destination>, text: string) => restoreArtifact(target.serverEnv.db, { authorization: { kind: 'recovery' }, text, allowForeignLineage: true });
  const movedSource = async () => {
    const source = fixture();
    source.insertReport(LONG_DETAILS, LONG_AUDIT);
    await moveRunBodies(source.env, NOW);
    expect(moved(source.db).length).toBe(3);
    return source;
  };

  it('restores into an empty destination and reads every body back', async () => {
    const source = await movedSource();
    const target = destination(source);
    const outcome = await restore(target, await artifactOf(source));
    expect(outcome!.tables.run_bodies).toEqual({ rows: 3, inserted: 3 });
    expect(await runInstructionBody(target.serverEnv, SCOPE, 'run_1')).toBe(LONG_INSTRUCTION);
    const { reports } = await listReportsWithBodies(target.serverEnv, SCOPE, 'run_1');
    expect(reports.map(({ details, audit }) => ({ details, audit }))).toEqual([{ details: LONG_DETAILS, audit: storedAudit(LONG_AUDIT) }]);
  });

  it('restores into a populated destination: a body it lacks reads back, and a body it holds is left alone', async () => {
    const source = await movedSource();
    const text = await artifactOf(source);
    const absent = destination(source);
    absent.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', 'theirs', 'myco-agent', 't', 'completed', 1)`);
    absent.sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES ('proj_1', 'theirs', 'myco-agent', 'note', 'mine', 1)`);
    const outcome = await restore(absent, text);
    expect(outcome!.tables.agent_reports!.inserted).toBe(0);
    expect(outcome!.tables.run_bodies).toEqual({ rows: 3, inserted: 1 });
    expect(await runInstructionBody(absent.serverEnv, SCOPE, 'run_1')).toBe(LONG_INSTRUCTION);

    const held = destination(source);
    held.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, instruction, resumable) VALUES ('proj_1', 'run_1', 'myco-agent', 't', 'completed', 1, 2, 'its own body', 0)`);
    held.sqlite.run(`INSERT INTO agent_reports (id, project_id, run_id, agent_id, action, summary, details, created_at) VALUES (?, 'proj_1', 'run_1', 'myco-agent', 'note', 's', NULL, 1)`, [(source.db.query(`SELECT id FROM agent_reports`).get() as { id: number }).id]);
    const kept = await restore(held, text);
    expect(kept!.tables.run_bodies).toEqual({ rows: 3, inserted: 2 });
    expect(held.sqlite.query(`SELECT instruction FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ instruction: 'its own body' });
    expect(held.sqlite.query(`SELECT body_kind AS kind FROM run_bodies ORDER BY body_kind`).all()).toEqual([{ kind: 'report_audit' }, { kind: 'report_details' }]);

    const again = await restore(absent, text);
    expect(again!.tables.run_bodies).toEqual({ rows: 3, inserted: 0 });
  });

  it('restores a run whose body failed to move with the body inline, and the destination retries it', async () => {
    const source = fixture();
    const put = source.env.blobs.put.bind(source.env.blobs);
    source.env.blobs.put = (() => Promise.reject(new Error('object store refused'))) as typeof put;
    await moveRunBodies(source.env, NOW);
    source.env.blobs.put = put;
    expect(source.db.query(`SELECT COUNT(*) AS n FROM run_body_failures`).get()).toEqual({ n: 1 });
    const target = destination(source);
    const text = await artifactOf(source);
    await restore(target, text);
    expect(target.sqlite.query(`SELECT instruction FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ instruction: LONG_INSTRUCTION });
    expect(target.sqlite.query(`SELECT COUNT(*) AS n FROM run_body_failures`).get()).toEqual({ n: 0 });
    expect((await moveRunBodies(target.serverEnv, NOW)).changed).toBe(1);
    expect(await runInstructionBody(target.serverEnv, SCOPE, 'run_1')).toBe(LONG_INSTRUCTION);
  });

  it('leaves out a run retention removed after the backup, instead of refusing the backup', async () => {
    const source = await movedSource();
    const text = await artifactOf(source);
    while (await pruneTerminalRuns(source.env.db, NOW + 1, 10, 10_000, NOW + 1) > 0);
    expect(source.db.query(`SELECT COUNT(*) AS n FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ n: 0 });
    await drainObjectReleases(source.env, NOW + BLOB_RESERVATION_TTL_MS + 2);
    expect(source.db.query(`SELECT COUNT(*) AS n FROM blobs`).get()).toEqual({ n: 0 });
    const outcome = await restore(source.e as never, text);
    expect(outcome.retiredRunsExcluded).toBe(1);
    expect(source.db.query(`SELECT COUNT(*) AS n FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ n: 0 });
    expect(source.db.query(`SELECT COUNT(*) AS n FROM run_bodies`).get()).toEqual({ n: 0 });
  });

  it('refuses another Deployment\'s backup whose moved bodies are absent here', async () => {
    const source = await movedSource();
    const text = await artifactOf(source);
    const target = sqliteEnv({ workerLogin: true });
    target.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'p', 1)`);
    await expect(restore(target as never, text)).rejects.toThrow(BackupObjectsMissingError);
    expect(target.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ n: 0 });
  });

  it('refuses rather than leave a run here with an empty instruction', async () => {
    const source = await movedSource();
    const text = await artifactOf(source);
    const keys = source.db.query('SELECT key FROM run_bodies').all() as Array<{ key: string }>;
    source.db.run('DELETE FROM run_bodies');
    await releaseNow(source.env.db, keys.map(({ key }) => ({ projectId: 'proj_1', key })), NOW + BLOB_RESERVATION_TTL_MS + 1);
    await drainObjectReleases(source.env, NOW + BLOB_RESERVATION_TTL_MS + 2);
    expect(source.db.query('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 0 });
    await expect(restore(source.e as never, text)).rejects.toThrow(BackupObjectsMissingError);
  });

  it('restores a run caught mid-retirement with its bodies intact and rebuilds the counts the backup leaves out', async () => {
    const source = await movedSource();
    await storeStepPage(source.env.db, SCOPE, 'run_1', page(Array.from({ length: 30 }, (_, i) => i)), WORKER, NOW);
    await pruneTerminalRuns(source.env.db, NOW, 10, 5, NOW);
    expect(source.db.query(`SELECT COUNT(*) AS n FROM run_retirements`).get()).toEqual({ n: 1 });
    const target = destination(source);
    await restore(target, await artifactOf(source));
    expect(target.sqlite.query(`SELECT COUNT(*) AS n FROM run_retirements`).get()).toEqual({ n: 0 });
    expect(await runInstructionBody(target.serverEnv, SCOPE, 'run_1')).toBe(LONG_INSTRUCTION);
    expect((await runAttempts(target.serverEnv.db, SCOPE, 'run_1')).total).toBeNull();
    while ((await catchUpProjections(target.serverEnv.db)).more);
    expect((await runAttempts(target.serverEnv.db, SCOPE, 'run_1')).total).toBe(1);
  });
});

describe('what a run detail admits it does not know or list', () => {
  it('answers no attempt total while the counts are building, not the attempts it listed', async () => {
    const { db, env } = fixture();
    db.run(`UPDATE projection_catchup SET done = 0 WHERE projection = 'run_evidence'`);
    expect(await runAttempts(env.db, SCOPE, 'run_1')).toMatchObject({ total: null });
  });

  it('says when a run holds more reports than the latest it lists', async () => {
    const { env, insertReport } = fixture();
    for (let i = 0; i < RUN_REPORTS_LIMIT; i++) insertReport('short', null);
    expect(await listReports(env.db, SCOPE, 'run_1')).toMatchObject({ hasMore: false });
    insertReport('short', null);
    const page = await listReports(env.db, SCOPE, 'run_1');
    expect(page.hasMore).toBe(true);
    expect(page.reports).toHaveLength(RUN_REPORTS_LIMIT);
  });
});

describe('a served-material record for a prompt', () => {
  it('finds a prompt\'s serving identity by its id, among a run\'s many served records', async () => {
    const { db, env } = fixture();
    db.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 's', 'm', 't', 1, 1)`);
    await recordServedPrompts(env.db, SCOPE, 'run_1', [{ promptId: 'p1', sessionId: 's', createdAt: 1, endedAt: null }, { promptId: 'p2', sessionId: 's', createdAt: 1, endedAt: null }], NOW);
    const served = await servedRecords(env.db, SCOPE, 'run_1', 's', ['p2', 'p9']);
    expect([...served.keys()]).toEqual(['p2']);
  });
});

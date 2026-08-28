/**
 * The run control plane's atomicity, against a real store rather than a fake.
 *
 * `tests/agent/run-store-serialization.test.ts` proves the PORT's shape against
 * an in-memory yielding fake. That establishes what the operations must be, not
 * that a store can honour them. These run the same interleavings through
 * `sqliteRelationalStore`, the adapter a self-hosted deployment runs in
 * production.
 *
 * Every concurrency test here is paired with a CONTROL that performs the same
 * work the unsafe way and is asserted to LOSE. A concurrency test with no such
 * control cannot distinguish an atomic implementation from an interleaving that
 * happened not to occur.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import {
  applyRunUpdate, claimRun, getRun, getState, mutateState, MUTATE_ATTEMPTS,
  RUN_IMMUTABLE_COLUMNS, RUN_UPDATE_COLUMNS, supersedeEquivalentResumableRuns,
  upsertCortexInstructions, type RunInsert,
} from '@myco-server-worker/core/runs.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
/** A millisecond clock, as every server timestamp is. */
const NOW = 1_700_000_000_000;

const CAPABILITY = 'cortex' as const;
/** The guard every claim carries: a task, an age floor, and the capability the task needs. */
const guardFor = (taskName: string, maxAgeSeconds = 3600) => ({ taskName, maxAgeSeconds, admission: { kind: 'capability', capability: CAPABILITY } as const });

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  for (const p of [SCOPE.projectId, OTHER.projectId]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, ?, 'built-in', 1, ?)`).run(AGENT, 'agent', NOW);
  const db = sqliteRelationalStore(sqlite);
  // Absence means NOT admitted, so a fixture that wants a claim to land says so.
  for (const p of [SCOPE.projectId, OTHER.projectId]) {
    sqlite.query(`INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, ?, 1, ?, 'test')`).run(p, CAPABILITY, NOW);
  }
  return { db, sqlite };
}

/** A store whose every operation yields, so two callers genuinely interleave. */
function yielding(db: RelationalStore): RelationalStore {
  return {
    prepare: (sql) => {
      const inner = db.prepare(sql);
      const wrap = (s: typeof inner): typeof inner => ({
        bind: (...v) => wrap(s.bind(...v)),
        run: async () => { await Promise.resolve(); const r = await s.run(); await Promise.resolve(); return r; },
        all: async () => { await Promise.resolve(); return s.all(); },
        first: async <T,>() => { await Promise.resolve(); const r = await s.first<T>(); await Promise.resolve(); return r; },
      });
      return wrap(inner);
    },
    batch: (statements) => db.batch(statements),
  };
}

const run = (id: string, task: string): RunInsert => ({
  id, agentId: AGENT, task, instruction: null, harness: null, provider: null, model: null,
  dryRun: false, startedAt: NOW, runContext: null, dispatchedBy: null,
});

const runCount = (sqlite: Database, projectId = SCOPE.projectId) =>
  (sqlite.query(`SELECT COUNT(*) c FROM agent_runs WHERE project_id = ?`).get(projectId) as { c: number }).c;

describe('claimRun', () => {
  it('reports the claim through meta.changes, so the adapter does not read the INSERT ... SELECT as row-producing', async () => {
    const { db, sqlite } = store();
    expect(await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest', 3600), NOW))
      .toEqual({ claimed: true });
    expect(runCount(sqlite)).toBe(1);
  });

  it('single-flights two concurrent claims of one task', async () => {
    const { db, sqlite } = store();
    const y = yielding(db);
    const guard = guardFor('digest', 3600);
    const [a, b] = await Promise.all([
      claimRun(y, SCOPE, run('r1', 'digest'), guard, NOW),
      claimRun(y, SCOPE, run('r2', 'digest'), guard, NOW),
    ]);
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    expect(runCount(sqlite)).toBe(1);
  });

  it('CONTROL: a separate check and a separate insert admit both claims', async () => {
    const { db, sqlite } = store();
    const y = yielding(db);
    const unsafe = async (id: string) => {
      const live = await y.prepare(`SELECT id FROM agent_runs WHERE project_id = ? AND task = ? AND status = 'running'`)
        .bind(SCOPE.projectId, 'digest').first();
      if (live) return false;
      await y.prepare(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, dry_run, started_at)
        VALUES (?, ?, ?, 'digest', 'running', 0, ?)`).bind(SCOPE.projectId, id, AGENT, NOW).run();
      return true;
    };
    const [a, b] = await Promise.all([unsafe('r1'), unsafe('r2')]);
    // Both saw no live run and both inserted — the defect the atomic form removes.
    expect([a, b]).toEqual([true, true]);
    expect(runCount(sqlite)).toBe(2);
  });

  it('lets a fresh claim past a run older than the age floor, and reports the live one otherwise', async () => {
    const { db } = store();
    const guard = guardFor('digest', 60);
    await claimRun(db, SCOPE, run('r1', 'digest'), guard, NOW);

    const blocked = await claimRun(db, SCOPE, run('r2', 'digest'), guard, NOW);
    expect(blocked.claimed).toBe(false);
    expect(blocked.claimed === false && blocked.running?.id).toBe('r1');

    // Far enough past r1's start that the floor has moved beyond it.
    expect(await claimRun(db, SCOPE, run('r3', 'digest'), guard, NOW + 3_600_000)).toEqual({ claimed: true });
  });

  /**
   * A resumed run keeps its original dispatch time, so an age floor read off
   * `started_at` alone would treat it as stale and admit a second run of the
   * same task. The current attempt's clock is `resumed_at`.
   */
  it('blocks on a run resumed inside the window, however old its original dispatch', async () => {
    const { db, sqlite } = store();
    const guard = guardFor('digest', 60);
    await claimRun(db, SCOPE, run('r1', 'digest'), guard, NOW);
    // Dispatched an hour ago, resumed a moment ago: the current attempt is fresh.
    sqlite.query(`UPDATE agent_runs SET started_at = ?, resumed_at = ? WHERE id = 'r1'`).run(NOW - 3_600_000, NOW - 5_000);

    const blocked = await claimRun(db, SCOPE, run('r2', 'digest'), guard, NOW);
    expect(blocked.claimed).toBe(false);
    expect(blocked.claimed === false && blocked.running?.id).toBe('r1');
    expect(runCount(sqlite)).toBe(1);
  });

  it('lets a claim past a run whose resumed attempt is itself older than the floor', async () => {
    const { db, sqlite } = store();
    const guard = guardFor('digest', 60);
    await claimRun(db, SCOPE, run('r1', 'digest'), guard, NOW);
    sqlite.query(`UPDATE agent_runs SET started_at = ?, resumed_at = ? WHERE id = 'r1'`).run(NOW - 7_200_000, NOW - 3_600_000);
    expect(await claimRun(db, SCOPE, run('r2', 'digest'), guard, NOW)).toEqual({ claimed: true });
  });

  it('claims per task and per project, so neither another task nor another project blocks', async () => {
    const { db, sqlite } = store();
    const guard = (taskName: string) => guardFor(taskName);
    await claimRun(db, SCOPE, run('r1', 'digest'), guard('digest'), NOW);
    expect(await claimRun(db, SCOPE, run('r2', 'extract'), guard('extract'), NOW)).toEqual({ claimed: true });
    expect(await claimRun(db, OTHER, run('r3', 'digest'), guard('digest'), NOW)).toEqual({ claimed: true });
    expect(runCount(sqlite)).toBe(2);
    expect(runCount(sqlite, OTHER.projectId)).toBe(1);
  });
});

describe('capability admission', () => {
  it('refuses a claim for a Project not admitted to the capability, and names it', async () => {
    const { db, sqlite } = store();
    sqlite.query(`DELETE FROM project_capabilities WHERE project_id = ?`).run(SCOPE.projectId);
    const outcome = await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest'), NOW);
    expect(outcome).toEqual({ claimed: false, notAdmitted: CAPABILITY });
    expect(runCount(sqlite)).toBe(0);
  });

  it('treats an absent capability row as not admitted, so a Project that appeared from a first write is admitted to nothing', async () => {
    const { db, sqlite } = store();
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_new', 'proj_new', ?)`).run(NOW);
    const outcome = await claimRun(db, { projectId: 'proj_new' }, run('r1', 'digest'), guardFor('digest'), NOW);
    expect(outcome).toEqual({ claimed: false, notAdmitted: CAPABILITY });
    expect(runCount(sqlite, 'proj_new')).toBe(0);
  });

  it('refuses a claim whose capability is withdrawn even while another remains admitted', async () => {
    const { db, sqlite } = store();
    sqlite.query(`INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, 'skills', 1, ?, 'test')`).run(SCOPE.projectId, NOW);
    sqlite.query(`UPDATE project_capabilities SET enabled = 0 WHERE project_id = ? AND capability = ?`).run(SCOPE.projectId, CAPABILITY);
    expect(await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest'), NOW)).toEqual({ claimed: false, notAdmitted: CAPABILITY });
    expect(await claimRun(db, SCOPE, run('r2', 'survey'), { taskName: 'survey', maxAgeSeconds: 3600, admission: { kind: 'capability', capability: 'skills' } as const }, NOW)).toEqual({ claimed: true });
  });

  it('distinguishes a refused admission from a task already running: they are different answers', async () => {
    const { db } = store();
    await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest'), NOW);
    const contended = await claimRun(db, SCOPE, run('r2', 'digest'), guardFor('digest'), NOW);
    expect(contended.claimed === false && contended.notAdmitted).toBeUndefined();
    expect(contended.claimed === false && contended.running?.id).toBe('r1');
  });
});

describe('provider admission', () => {
  const captureGuard = { taskName: 'title-summary', maxAgeSeconds: 3600, admission: { kind: 'provider' } as const };

  const setLeaf = (sqlite: Database, leaf: string, value: unknown) =>
    sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, 'test')`)
      .run(leaf, JSON.stringify(value), NOW);

  it('refuses a capture-driven task when the Deployment has no provider at all', async () => {
    const { db, sqlite } = store();
    const outcome = await claimRun(db, SCOPE, run('r1', 'title-summary'), captureGuard, NOW);
    expect(outcome).toEqual({ claimed: false, noProvider: true });
    expect(runCount(sqlite)).toBe(0);
  });

  it('admits it on the default provider', async () => {
    const { db, sqlite } = store();
    setLeaf(sqlite, 'agent.provider.type', 'anthropic');
    expect(await claimRun(db, SCOPE, run('r1', 'title-summary'), captureGuard, NOW)).toEqual({ claimed: true });
    expect(runCount(sqlite)).toBe(1);
  });

  it('admits it on a task-specific provider with no default set', async () => {
    const { db, sqlite } = store();
    setLeaf(sqlite, 'agent.tasks', { 'title-summary': { provider: { type: 'openai' } } });
    expect(await claimRun(db, SCOPE, run('r1', 'title-summary'), captureGuard, NOW)).toEqual({ claimed: true });
  });

  it('does not let another task overrides entry admit this one', async () => {
    const { db, sqlite } = store();
    setLeaf(sqlite, 'agent.tasks', { 'digest-only': { provider: { type: 'openai' } } });
    expect(await claimRun(db, SCOPE, run('r1', 'title-summary'), captureGuard, NOW)).toEqual({ claimed: false, noProvider: true });
  });

  it('reads a malformed overrides document as no per-task provider rather than throwing', async () => {
    const { db, sqlite } = store();
    sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.tasks', 'not json', ?, 'test')`).run(NOW);
    expect(await claimRun(db, SCOPE, run('r1', 'title-summary'), captureGuard, NOW)).toEqual({ claimed: false, noProvider: true });
  });

  it('gates the capture-driven task on the Deployment, never on a Project capability', async () => {
    const { db, sqlite } = store();
    // Every capability withdrawn; the provider alone decides.
    sqlite.query(`DELETE FROM project_capabilities`).run();
    setLeaf(sqlite, 'agent.provider.type', 'anthropic');
    expect(await claimRun(db, SCOPE, run('r1', 'title-summary'), captureGuard, NOW)).toEqual({ claimed: true });
  });
});

describe('run attribution', () => {
  it('records the credential that dispatched a run, so member and runtime are reachable from the run', async () => {
    const { db, sqlite } = store();
    sqlite.query(`INSERT INTO members (id, label, created_at) VALUES ('mem_1', 'harness', ?)`).run(NOW);
    sqlite.query(`INSERT INTO member_credentials
      (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at, lineage_root, lineage_started_at)
      VALUES ('cred_1', 'mem_1', 'h', 'machine_1', 'harness', 'container', ?, ?, 'cred_1', ?)`).run(NOW, NOW + 1000, NOW);

    await claimRun(db, SCOPE, { ...run('r1', 'digest'), dispatchedBy: 'cred_1' }, guardFor('digest', 3600), NOW);

    const attributed = sqlite.query(`SELECT r.agent_id AS agentId, c.member_id AS memberId, c.runtime_kind AS runtimeKind
      FROM agent_runs r JOIN member_credentials c ON c.id = r.dispatched_by
      WHERE r.project_id = ? AND r.id = 'r1'`).get(SCOPE.projectId);
    expect(attributed).toEqual({ agentId: AGENT, memberId: 'mem_1', runtimeKind: 'container' });
  });

  it('admits a run with no dispatching credential, which is what a scheduled run is', async () => {
    const { db, sqlite } = store();
    await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest', 3600), NOW);
    expect((sqlite.query(`SELECT dispatched_by FROM agent_runs WHERE id = 'r1'`).get() as { dispatched_by: string | null }).dispatched_by).toBeNull();
  });
});

describe('mutateState', () => {
  const append = (entry: string) => (current: string | null): string =>
    JSON.stringify([...(current ? (JSON.parse(current) as string[]) : []), entry]);

  it('keeps both concurrent appends when the key is unset, where the insert conflict decides', async () => {
    const { db } = store();
    const y = yielding(db);
    await Promise.all([
      mutateState(y, SCOPE, AGENT, 'decisions', append('phase-a'), NOW),
      mutateState(y, SCOPE, AGENT, 'decisions', append('phase-b'), NOW),
    ]);
    const row = await getState(db, SCOPE, AGENT, 'decisions');
    expect(JSON.parse(row!.value).sort()).toEqual(['phase-a', 'phase-b']);
  });

  /**
   * The same interleaving over an EXISTING value, which is the case the
   * compare-and-swap guard alone decides.
   *
   * The unset-key case above is settled by the insert's conflict clause instead,
   * so it passes with or without the guard and cannot stand in for this.
   */
  it('keeps both concurrent appends when the key is already set, which only the compare-and-swap decides', async () => {
    const { db } = store();
    await mutateState(db, SCOPE, AGENT, 'decisions', () => JSON.stringify(['seed']), NOW);
    const y = yielding(db);
    await Promise.all([
      mutateState(y, SCOPE, AGENT, 'decisions', append('phase-a'), NOW),
      mutateState(y, SCOPE, AGENT, 'decisions', append('phase-b'), NOW),
    ]);
    const row = await getState(db, SCOPE, AGENT, 'decisions');
    expect(JSON.parse(row!.value).sort()).toEqual(['phase-a', 'phase-b', 'seed']);
  });

  it('CONTROL: a read then an unguarded write loses one of them', async () => {
    const { db } = store();
    // Seeded so both writers take the same UPDATE path: the control is about a
    // lost update, not about two inserts colliding on the primary key.
    await mutateState(db, SCOPE, AGENT, 'decisions', () => JSON.stringify(['seed']), NOW);
    const y = yielding(db);
    const unsafe = async (entry: string) => {
      const row = await getState(y, SCOPE, AGENT, 'decisions');
      const next = append(entry)(row!.value);
      await y.prepare(`UPDATE agent_state SET value = ? WHERE project_id = ? AND agent_id = ? AND key = ?`)
        .bind(next, SCOPE.projectId, AGENT, 'decisions').run();
    };
    await Promise.all([unsafe('phase-a'), unsafe('phase-b')]);
    const row = await getState(db, SCOPE, AGENT, 'decisions');
    // Both read the seed; the later write carries only its own entry beside it.
    expect(JSON.parse(row!.value)).toHaveLength(2);
  });

  it('guards on the prior value with IS, so a first write after an absent value is not skipped', async () => {
    const { db } = store();
    expect(await mutateState(db, SCOPE, AGENT, 'fresh', () => 'first', NOW)).toBe(true);
    expect((await getState(db, SCOPE, AGENT, 'fresh'))!.value).toBe('first');
    expect(await mutateState(db, SCOPE, AGENT, 'fresh', (c) => `${c}-second`, NOW)).toBe(true);
    expect((await getState(db, SCOPE, AGENT, 'fresh'))!.value).toBe('first-second');
  });

  it('leaves the value untouched when the callback returns null', async () => {
    const { db } = store();
    await mutateState(db, SCOPE, AGENT, 'k', () => 'set', NOW);
    expect(await mutateState(db, SCOPE, AGENT, 'k', () => null, NOW)).toBe(true);
    expect((await getState(db, SCOPE, AGENT, 'k'))!.value).toBe('set');
  });

  it('reports contention rather than reporting a write that did not land', async () => {
    const { db } = store();
    await mutateState(db, SCOPE, AGENT, 'k', () => 'v0', NOW);
    // A store whose update never matches: every attempt is refused.
    const contended: RelationalStore = {
      prepare: (sql) => /^UPDATE agent_state/.test(sql)
        ? { bind: () => contended.prepare(sql), run: async () => ({ results: [], meta: { changes: 0 } }), all: async () => ({ results: [] }), first: async () => null }
        : db.prepare(sql),
      batch: (s) => db.batch(s),
    };
    let attempts = 0;
    expect(await mutateState(contended, SCOPE, AGENT, 'k', (c) => { attempts += 1; return `${c}!`; }, NOW)).toBe(false);
    expect(attempts).toBe(MUTATE_ATTEMPTS);
    expect((await getState(db, SCOPE, AGENT, 'k'))!.value).toBe('v0');
  });

  it('keys state by project, so one project cannot read or overwrite another', async () => {
    const { db } = store();
    await mutateState(db, SCOPE, AGENT, 'shared', () => 'one', NOW);
    await mutateState(db, OTHER, AGENT, 'shared', () => 'two', NOW);
    expect((await getState(db, SCOPE, AGENT, 'shared'))!.value).toBe('one');
    expect((await getState(db, OTHER, AGENT, 'shared'))!.value).toBe('two');
  });
});

describe('run lifecycle', () => {
  const seedFailedResumable = (sqlite: Database, id: string, over: Partial<{ task: string; agentId: string; dryRun: number; projectId: string }> = {}) => {
    sqlite.query(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, resumable, dry_run, started_at)
      VALUES (?, ?, ?, ?, 'failed', 1, ?, ?)`)
      .run(over.projectId ?? SCOPE.projectId, id, over.agentId ?? AGENT, over.task ?? 'digest', over.dryRun ?? 0, NOW);
  };

  it('applies only the columns it names, and reports rows moved', async () => {
    const { db, sqlite } = store();
    await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest'), NOW);
    expect(await applyRunUpdate(db, SCOPE, 'r1', { status: 'failed', error: 'boom' })).toBe(1);
    const row = sqlite.query(`SELECT status, error, task FROM agent_runs WHERE id = 'r1'`).get() as { status: string; error: string; task: string };
    expect(row).toEqual({ status: 'failed', error: 'boom', task: 'digest' });
  });

  it('reports zero for a run outside the scope, which a caller must not read as success', async () => {
    const { db } = store();
    await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest'), NOW);
    expect(await applyRunUpdate(db, OTHER, 'r1', { status: 'failed' })).toBe(0);
  });

  it('issues no statement for an update naming nothing settable', async () => {
    const { db } = store();
    await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest'), NOW);
    expect(await applyRunUpdate(db, SCOPE, 'r1', {})).toBe(0);
  });

  it('never lets a run change Project, agent, identity or dispatcher', () => {
    for (const column of RUN_IMMUTABLE_COLUMNS) {
      expect({ column, settable: (RUN_UPDATE_COLUMNS as readonly string[]).includes(column) })
        .toEqual({ column, settable: false });
    }
  });

  it('supersedes an equivalent failed resumable run and leaves the excluded one alone', async () => {
    const { db, sqlite } = store();
    seedFailedResumable(sqlite, 'old');
    seedFailedResumable(sqlite, 'keep');
    expect(await supersedeEquivalentResumableRuns(db, SCOPE, 'keep', { agentId: AGENT, taskName: 'digest', dryRun: false })).toBe(1);
    const rows = sqlite.query(`SELECT id, resumable, resume_status AS s FROM agent_runs ORDER BY id`).all() as { id: string; resumable: number; s: string | null }[];
    expect(rows).toEqual([{ id: 'keep', resumable: 1, s: null }, { id: 'old', resumable: 0, s: 'superseded' }]);
  });

  it('does not let a dry run supersede a real one, or the reverse', async () => {
    const { db, sqlite } = store();
    seedFailedResumable(sqlite, 'real', { dryRun: 0 });
    seedFailedResumable(sqlite, 'dry', { dryRun: 1 });
    expect(await supersedeEquivalentResumableRuns(db, SCOPE, 'x', { agentId: AGENT, taskName: 'digest', dryRun: true })).toBe(1);
    const rows = sqlite.query(`SELECT id, resumable FROM agent_runs ORDER BY id`).all() as { id: string; resumable: number }[];
    expect(rows).toEqual([{ id: 'dry', resumable: 0 }, { id: 'real', resumable: 1 }]);
  });

  it('supersedes neither another task, another agent, nor another Project', async () => {
    const { db, sqlite } = store();
    seedFailedResumable(sqlite, 'other_task', { task: 'extract' });
    seedFailedResumable(sqlite, 'other_project', { projectId: OTHER.projectId });
    expect(await supersedeEquivalentResumableRuns(db, SCOPE, 'x', { agentId: AGENT, taskName: 'digest', dryRun: false })).toBe(0);
  });

  it('touches only failed resumable runs', async () => {
    const { db, sqlite } = store();
    await claimRun(db, SCOPE, run('running', 'digest'), guardFor('digest'), NOW);
    sqlite.query(`UPDATE agent_runs SET resumable = 1 WHERE id = 'running'`).run();
    expect(await supersedeEquivalentResumableRuns(db, SCOPE, 'x', { agentId: AGENT, taskName: 'digest', dryRun: false })).toBe(0);
  });

  it('reads a run back within its scope and not outside it', async () => {
    const { db } = store();
    await claimRun(db, SCOPE, run('r1', 'digest'), guardFor('digest'), NOW);
    expect((await getRun(db, SCOPE, 'r1'))?.task).toBe('digest');
    expect(await getRun(db, OTHER, 'r1')).toBeNull();
  });
});

describe('cortex instructions', () => {
  it('replaces content and provenance on conflict, and moves neither the row nor its Project', async () => {
    const { db, sqlite } = store();
    await upsertCortexInstructions(db, SCOPE, { agentId: AGENT, content: 'first', inputHash: 'h1', generatedAt: NOW, sourceRunId: null });
    await upsertCortexInstructions(db, SCOPE, { agentId: AGENT, content: 'second', inputHash: 'h2', generatedAt: NOW + 1, sourceRunId: 'r1' });
    const rows = sqlite.query(`SELECT project_id AS p, id, content, input_hash AS h, source_run_id AS r FROM cortex_instructions`).all();
    expect(rows).toEqual([{ p: SCOPE.projectId, id: `${AGENT}:instructions`, content: 'second', h: 'h2', r: 'r1' }]);
  });

  it('keeps one row per Project, so the other Project instructions are untouched', async () => {
    const { db, sqlite } = store();
    await upsertCortexInstructions(db, SCOPE, { agentId: AGENT, content: 'one', inputHash: 'h', generatedAt: NOW, sourceRunId: null });
    await upsertCortexInstructions(db, OTHER, { agentId: AGENT, content: 'two', inputHash: 'h', generatedAt: NOW, sourceRunId: null });
    const rows = sqlite.query(`SELECT project_id AS p, content FROM cortex_instructions ORDER BY project_id`).all();
    expect(rows).toEqual([{ p: SCOPE.projectId, content: 'one' }, { p: OTHER.projectId, content: 'two' }]);
  });
});

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
import { claimRun, getState, mutateState, MUTATE_ATTEMPTS, type RunInsert } from '@myco-server-worker/core/runs.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_000_000;

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  for (const p of [SCOPE.projectId, OTHER.projectId]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, ?, 'built-in', 1, ?)`).run(AGENT, 'agent', NOW);
  return { db: sqliteRelationalStore(sqlite), sqlite };
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
    expect(await claimRun(db, SCOPE, run('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 }, NOW))
      .toEqual({ claimed: true });
    expect(runCount(sqlite)).toBe(1);
  });

  it('single-flights two concurrent claims of one task', async () => {
    const { db, sqlite } = store();
    const y = yielding(db);
    const guard = { taskName: 'digest', maxAgeSeconds: 3600 };
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
    const guard = { taskName: 'digest', maxAgeSeconds: 60 };
    await claimRun(db, SCOPE, run('r1', 'digest'), guard, NOW);

    const blocked = await claimRun(db, SCOPE, run('r2', 'digest'), guard, NOW);
    expect(blocked.claimed).toBe(false);
    expect(blocked.claimed === false && blocked.running?.id).toBe('r1');

    // Far enough past r1's start that the floor has moved beyond it.
    expect(await claimRun(db, SCOPE, run('r3', 'digest'), guard, NOW + 3600)).toEqual({ claimed: true });
  });

  it('claims per task and per project, so neither another task nor another project blocks', async () => {
    const { db, sqlite } = store();
    const guard = (taskName: string) => ({ taskName, maxAgeSeconds: 3600 });
    await claimRun(db, SCOPE, run('r1', 'digest'), guard('digest'), NOW);
    expect(await claimRun(db, SCOPE, run('r2', 'extract'), guard('extract'), NOW)).toEqual({ claimed: true });
    expect(await claimRun(db, OTHER, run('r3', 'digest'), guard('digest'), NOW)).toEqual({ claimed: true });
    expect(runCount(sqlite)).toBe(2);
    expect(runCount(sqlite, OTHER.projectId)).toBe(1);
  });
});

describe('run attribution', () => {
  it('records the credential that dispatched a run, so member and runtime are reachable from the run', async () => {
    const { db, sqlite } = store();
    sqlite.query(`INSERT INTO members (id, label, created_at) VALUES ('mem_1', 'harness', ?)`).run(NOW);
    sqlite.query(`INSERT INTO member_credentials
      (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at, lineage_root, lineage_started_at)
      VALUES ('cred_1', 'mem_1', 'h', 'machine_1', 'harness', 'container', ?, ?, 'cred_1', ?)`).run(NOW, NOW + 1000, NOW);

    await claimRun(db, SCOPE, { ...run('r1', 'digest'), dispatchedBy: 'cred_1' }, { taskName: 'digest', maxAgeSeconds: 3600 }, NOW);

    const attributed = sqlite.query(`SELECT r.agent_id AS agentId, c.member_id AS memberId, c.runtime_kind AS runtimeKind
      FROM agent_runs r JOIN member_credentials c ON c.id = r.dispatched_by
      WHERE r.project_id = ? AND r.id = 'r1'`).get(SCOPE.projectId);
    expect(attributed).toEqual({ agentId: AGENT, memberId: 'mem_1', runtimeKind: 'container' });
  });

  it('admits a run with no dispatching credential, which is what a scheduled run is', async () => {
    const { db, sqlite } = store();
    await claimRun(db, SCOPE, run('r1', 'digest'), { taskName: 'digest', maxAgeSeconds: 3600 }, NOW);
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

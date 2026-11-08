import { readAttemptSpendOracle as readSpendRows } from './helpers/attempt-spend-oracle.js';
import { describe, expect, it } from 'bun:test';
import { budgetFixture } from './helpers/budget-fixture.js';
import { readBudgetStatus } from '@myco-server-worker/read/budget.js';
import { automaticFits, budgetHold } from '@myco-server-worker/core/run-budget.js';
import { BUDGET_WINDOW_MS } from '@myco-server-worker/core/budget-policy.js';
import { catchUpProjections, projectionReadiness } from '@myco-server-worker/db/projections/catchup.js';
import { SPEND_DUE_READ_LIMIT, SPEND_EXPIRY_PAGE, expireSpend, spendSchemaStatements, spendTriggers } from '@myco-server-worker/db/runs/admission.js';
import { V714_STATEMENTS } from '@myco-server-worker/db/schema-v714.js';
import { restoreAttemptStatement } from '@myco-server-worker/core/attempt-accounting.js';
import { holdSentence } from '@goondocks/myco-shared/run-holds';

type Fixture = Awaited<ReturnType<typeof budgetFixture>>;
const spent = async (f: Fixture, now = f.now) => {
  const status = await readBudgetStatus(f.db, now);
  return { state: status.state, automatic: status.automaticUsd, manual: status.manualUsd, live: status.liveUsd, unconfirmed: status.unconfirmed?.count ?? null };
};
const catchUp = (f: Fixture, now = f.now) => catchUpProjections(f.db, { budget: { calls: 10_000, wallMs: 60_000 }, clock: () => now });
const rebuild = (f: Fixture) => {
  f.sqlite.run('DELETE FROM attempt_spend');
  f.sqlite.run("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='budget'");
};

describe('rolling spend accounting', () => {
  it('counts every window attempt and every live attempt from maintained totals, and settles a live attempt once', async () => {
    const f = await budgetFixture();
    try {
      expect(await projectionReadiness(f.db, 'budget')).toBe('ready');
      f.history('a', 0.25);
      f.history('b', null, 'manual');
      f.history('old', 5, 'automatic', f.now - BUDGET_WINDOW_MS - 1);
      f.history('live', null, 'automatic', f.now - BUDGET_WINDOW_MS - 10, 0.40);
      f.sqlite.run("UPDATE agent_runs SET status='running' WHERE id='live'");
      f.sqlite.run("UPDATE agent_run_attempts SET cost_usd=NULL,cost_source=NULL WHERE attempt_id='live'");
      expect(await spent(f)).toEqual({ state: 'ready', automatic: 0.65, manual: 0.10, live: 0.40, unconfirmed: 1 });

      // The live attempt settles long after its claim left the window: it stops counting, exactly once.
      f.sqlite.run("UPDATE agent_run_attempts SET cost_usd=0.30,cost_source='actual' WHERE attempt_id='live'");
      f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE id='live'");
      expect(await spent(f)).toEqual({ state: 'ready', automatic: 0.25, manual: 0.10, live: 0, unconfirmed: 1 });
      expect((await readSpendRows(f.db, f.now)).map(row => row.attemptId).sort()).toEqual(['a', 'b']);

      // Claims leave the window as time passes; the read at a later instant subtracts them before any expiry write.
      expect(await spent(f, f.now + BUDGET_WINDOW_MS)).toEqual({ state: 'ready', automatic: 0, manual: 0, live: 0, unconfirmed: 0 });
    } finally { f.sqlite.close(); }
  });

  it('admits automatic work only with room in the window and holds it while accounting catches up', async () => {
    const f = await budgetFixture();
    try {
      await f.setting(1);
      f.history('spent', 0.85);
      const candidate = f.queue('candidate');
      expect(await automaticFits(f.db, 0.15, f.now)).toBe(true);
      expect(await automaticFits(f.db, 0.16, f.now)).toBe(false);
      expect(await budgetHold(f.db, candidate.projectId, candidate.id, 0.16, f.now)).toBe('budget');
      expect(await budgetHold(f.db, candidate.projectId, candidate.id, 0.15, f.now)).toBeNull();
      // Once the spend leaves the window, the same estimate is admitted.
      expect(await automaticFits(f.db, 0.16, f.now + BUDGET_WINDOW_MS)).toBe(true);

      rebuild(f);
      expect(await spent(f)).toEqual({ state: 'building', automatic: null, manual: null, live: null, unconfirmed: null });
      expect(await automaticFits(f.db, 0.01, f.now)).toBe(false);
      expect(await budgetHold(f.db, candidate.projectId, candidate.id, 0.01, f.now)).toBe('admission_building');
      expect(holdSentence('admission_building')).toContain('Measuring recent spend');

      await catchUp(f);
      expect(await projectionReadiness(f.db, 'budget')).toBe('ready');
      expect(await automaticFits(f.db, 0.15, f.now)).toBe(true);
      expect(await automaticFits(f.db, 0.16, f.now)).toBe(false);
    } finally { f.sqlite.close(); }
  });

  it('catches up history to the same totals the triggers keep, through interleaved writes and replay', async () => {
    const totals = (f: Fixture) => f.sqlite.query('SELECT project_id,origin,usd+usd_carry AS usd,live_usd+live_usd_carry AS live,unconfirmed,unconfirmed_estimate_usd+unconfirmed_estimate_usd_carry AS estimate FROM budget_totals ORDER BY 1,2').all();
    const scenario = async (rebuildMidway: boolean) => {
      const f = await budgetFixture();
      for (let i = 0; i < 70; i++) f.history(`h${i}`, i % 3 === 0 ? null : 0.01 * (i % 7), i % 2 === 0 ? 'automatic' : 'manual', f.now - i * 60_000);
      for (let i = 0; i < 5; i++) f.history(`expired${i}`, 1, 'automatic', f.now - BUDGET_WINDOW_MS - 1 - i);
      f.history('running', null, 'automatic', f.now - 5, 0.07);
      f.sqlite.run("UPDATE agent_runs SET status='running' WHERE id='running'");
      if (rebuildMidway) {
        rebuild(f);
        await catchUpProjections(f.db, { budget: { calls: 8, wallMs: 60_000 }, clock: () => f.now });
        expect((await spent(f)).state).toBe('building');
      }
      // Writes before and after the cursor while a catch-up is part way through.
      f.sqlite.run("UPDATE agent_runs SET status='completed' WHERE id='running'");
      f.history('late', 0.5);
      f.sqlite.run("DELETE FROM agent_runs WHERE id='h1'");
      if (rebuildMidway) await catchUp(f);
      return f;
    };
    const kept = await scenario(false), rebuilt = await scenario(true);
    try {
      expect((await spent(rebuilt)).state).toBe('ready');
      expect(await spent(rebuilt)).toEqual(await spent(kept));
      expect(totals(rebuilt)).toEqual(totals(kept));
      // Replaying every page changes nothing.
      rebuilt.sqlite.run("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='budget'");
      await catchUp(rebuilt);
      expect(totals(rebuilt)).toEqual(totals(kept));
    } finally { kept.sqlite.close(); rebuilt.sqlite.close(); }
  });

  it('expires settled claims in bounded pages as new attempts arrive and keeps restored settlements exact', async () => {
    const f = await budgetFixture();
    try {
      for (let i = 0; i < 3 * SPEND_EXPIRY_PAGE; i++) f.history(`aging${i}`, 0.01, 'automatic', f.now - BUDGET_WINDOW_MS + i);
      const due = () => (f.sqlite.query(`SELECT COUNT(*) AS n FROM attempt_spend WHERE counted=1 AND live=0 AND claimed_at<=?`).get(f.now + BUDGET_WINDOW_MS) as { n: number }).n;
      expect(due()).toBe(3 * SPEND_EXPIRY_PAGE);
      f.history('next', 0.02, 'automatic', f.now + 3 * SPEND_EXPIRY_PAGE);
      expect(due()).toBe(2 * SPEND_EXPIRY_PAGE + 1);
      expect((await spent(f, f.now + 3 * SPEND_EXPIRY_PAGE)).automatic).toBe(0.02);

      // A restored settlement for an attempt still in the window moves the totals to its priced cost.
      f.history('restored', null, 'automatic', f.now + 3 * SPEND_EXPIRY_PAGE, 0.10);
      f.sqlite.run("UPDATE agent_run_attempts SET cost_usd=NULL,cost_source=NULL WHERE attempt_id='restored'");
      expect((await spent(f, f.now + 3 * SPEND_EXPIRY_PAGE)).automatic).toBe(0.02 + 0.10);
      const restoredRow = f.sqlite.query("SELECT * FROM agent_run_attempts WHERE attempt_id='restored'").get() as Record<string, unknown>;
      await restoreAttemptStatement(f.db, { ...restoredRow, cost_usd: 0.04, cost_source: 'actual' }).run();
      expect((await spent(f, f.now + 3 * SPEND_EXPIRY_PAGE)).automatic).toBe(0.06);
      // Deleting a run removes its attempts' contribution with it.
      f.sqlite.run("DELETE FROM agent_runs WHERE id='restored'");
      expect((await spent(f, f.now + 3 * SPEND_EXPIRY_PAGE)).automatic).toBe(0.02);
    } finally { f.sqlite.close(); }
  });

  it('compares source precision exactly at the budget boundary, as a recount of the attempts does', async () => {
    for (const [spentUsd, estimate, admitted] of [[0.9000004, 0.10, false], [0.8999996, 0.1000002, true]] as const) {
      const f = await budgetFixture();
      try {
        await f.setting(1);
        f.history('settled', spentUsd);
        const candidate = f.queue('candidate');
        expect(await automaticFits(f.db, estimate, f.now)).toBe(admitted);
        expect(await budgetHold(f.db, candidate.projectId, candidate.id, estimate, f.now)).toBe(admitted ? null : 'budget');
        expect((await spent(f)).automatic).toBe(spentUsd);
      } finally { f.sqlite.close(); }
    }
  });

  it('keeps the rollup equal to a fresh sum of its facts through many additions and removals', async () => {
    const f = await budgetFixture();
    try {
      for (let i = 0; i < 300; i++) f.history(`churn${i}`, [0.1, 0.2, 0.3, 0.7][i % 4]!, 'automatic', f.now - i);
      for (let i = 0; i < 300; i += 2) f.sqlite.run('DELETE FROM agent_runs WHERE id=?', [`churn${i}`]);
      const recount = (f.sqlite.query("SELECT SUM(value) AS usd FROM attempt_spend WHERE counted=1 AND origin='automatic'").get() as { usd: number }).usd;
      expect((await spent(f)).automatic).toBe(recount);
    } finally { f.sqlite.close(); }
  });

  it('waits for the expiry job after an idle day instead of summing the overdue backlog, then admits on exact totals', async () => {
    const f = await budgetFixture();
    try {
      await f.setting(1000);
      const busy = 3 * SPEND_DUE_READ_LIMIT;
      for (let i = 0; i < busy; i++) f.history(`busy${i}`, 0.5, 'automatic', f.now + i);
      f.history('recent', 0.25, 'automatic', f.now + 2 * BUDGET_WINDOW_MS - 10);
      const later = f.now + 2 * BUDGET_WINDOW_MS;
      const candidate = f.queue('candidate', 'automatic', 'proj_1', 'title-summary', later);
      expect(await automaticFits(f.db, 0.1, later)).toBe(false);
      expect(await budgetHold(f.db, candidate.projectId, candidate.id, 0.1, later)).toBe('admission_building');
      expect((await readBudgetStatus(f.db, later)).state).toBe('building');
      const retired = await expireSpend(f.db, later);
      expect(retired.more).toBe(false);
      expect(retired.changed).toBeGreaterThan(SPEND_DUE_READ_LIMIT);
      expect(await spent(f, later)).toEqual({ state: 'ready', automatic: 0.25, manual: 0, live: 0, unconfirmed: 0 });
      expect(await automaticFits(f.db, 0.1, later)).toBe(true);
    } finally { f.sqlite.close(); }
  });

  it('installs exactly the generator output in its schema step', () => {
    expect([...V714_STATEMENTS]).toEqual(spendSchemaStatements());
    expect(spendTriggers().every(trigger => V714_STATEMENTS.includes(trigger.sql))).toBe(true);
  });
});

it('budget status names every held Project head and keeps each run quote with its own origin', async () => {
  const f = await budgetFixture();
  try {
    await f.setting(1);
    f.queue('first', 'automatic', 'proj_1');
    f.queue('next', 'automatic', 'proj_1', 'title-summary', f.now + 1);
    f.queue('other-project', 'automatic', 'proj_2');
    f.queue('manual', 'manual', 'proj_1');
    const { recordQueueHolder } = await import('@myco-server-worker/core/runs.js');
    await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'first', 'budget', { usd: 2, at: f.now });
    await recordQueueHolder(f.db, { projectId: 'proj_2' }, 'other-project', 'budget', { usd: 0.5, at: f.now });
    await recordQueueHolder(f.db, { projectId: 'proj_1' }, 'manual', 'budget', { usd: 3, at: f.now });
    const status = await readBudgetStatus(f.db, f.now);
    expect(status.heldHeads?.map(head => [head.runId, head.reason, head.requiredUsd]).sort()).toEqual([
      ['first', 'budget_too_small', 2], ['other-project', 'budget', 0.5],
    ]);
    expect(await budgetHold(f.db, 'proj_1', 'manual', 3, f.now)).toBeNull();
    f.sqlite.run("UPDATE agent_runs SET status='skipped',completed_at=? WHERE id='first'", [f.now + 2]);
    expect((await readBudgetStatus(f.db, f.now + 2)).heldHeads?.map(head => head.runId)).toEqual(['other-project']);
  } finally { f.sqlite.close(); }
});

it('budget status reports building while queue heads are incomplete', async () => {
  const f = await budgetFixture();
  try {
    f.queue('waiting');
    f.sqlite.run("UPDATE projection_catchup SET done=0 WHERE projection='run_admission'");
    expect(await readBudgetStatus(f.db, f.now)).toMatchObject({ state: 'building', automaticUsd: null });
  } finally { f.sqlite.close(); }
});

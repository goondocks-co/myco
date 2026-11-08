import { afterEach, describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { catchUpProjections, resetProjectionCatchup } from '@myco-server-worker/db/projections/catchup.js';
import { activeSporesAtLeast, sporeTotal, sporeTotalAndFacets } from '@myco-server-worker/db/spores/counts.js';
import { planStatusTotals } from '@myco-server-worker/db/plans/counts.js';

configureSqliteLibrary();
const DAY = 86_400_000;
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

function fixture() {
  const f = sqliteEnv(); opened.push(f);
  const insert = (table: string, row: Record<string, unknown>) => f.sqlite.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as never[]);
  for (const p of ['p', 'q']) insert('projects', { project_id: p, name: p, created_at: 1 });
  insert('agents', { id: 'a', name: 'agent', source: 'built-in', enabled: 1, created_at: 1 });
  // Sessions are only named here, never read: the counters key by the id a spore carries.
  f.sqlite.run('PRAGMA foreign_keys=OFF');
  const spore = (id: string, o: { project?: string; type?: string; status?: string; session?: string | null; at?: number } = {}) => insert('spores', {
    project_id: o.project ?? 'p', id, agent_id: 'a', content: `knowledge ${id}`, observation_type: o.type ?? 'decision',
    status: o.status ?? 'active', session_id: o.session === undefined ? 's1' : o.session, created_at: o.at ?? 10 * DAY + 5 });
  const plan = (key: string, status: string, project = 'p') => insert('plans', { project_id: project, plan_key: key, session_id: 's1', event_id: `e-${key}`, machine_id: 'm', content_hash: 'h', token_id: 't', received_at: 1, title: key, status, created_at: 1, updated_at: 1 });
  /** The totals a fresh count of the stored spores gives, by the same dimensions the counters hold. */
  const recount = (where = '1') => Number((f.sqlite.query(`SELECT COUNT(*) AS n FROM spores WHERE ${where}`).get() as { n: number }).n);
  return { ...f, insert, spore, plan, recount };
}

describe('spore and plan totals from counters', () => {
  it('answers every counted total exactly through inserts, edits, moves and deletes', async () => {
    const f = fixture();
    f.spore('a'); f.spore('b', { type: 'gotcha' }); f.spore('c', { session: 's2', at: 11 * DAY }); f.spore('d', { project: 'q', session: null });
    f.sqlite.run("UPDATE spores SET status='superseded' WHERE id='b'");
    f.sqlite.run("UPDATE spores SET observation_type='gotcha', session_id='s2', created_at=? WHERE id='a'", [12 * DAY + 1]);
    f.sqlite.run("UPDATE spores SET content='edited', agent_line='line' WHERE id='c'");
    f.spore('e'); f.sqlite.run("DELETE FROM spores WHERE id='e'");

    const total = async (scope: Parameters<typeof sporeTotal>[1], filters: Parameters<typeof sporeTotal>[2]) => sporeTotal(f.db, scope, filters);
    expect(await total({ projectId: 'p' }, {})).toEqual({ state: 'ready', value: f.recount("project_id='p'") });
    expect(await total({ projectId: 'p' }, { status: 'active' })).toEqual({ state: 'ready', value: f.recount("project_id='p' AND status='active'") });
    expect(await total({ projectId: 'p' }, { observationType: 'gotcha' })).toEqual({ state: 'ready', value: 2 });
    expect(await total({ projectId: 'p' }, { sessionId: 's2' })).toEqual({ state: 'ready', value: f.recount("project_id='p' AND session_id='s2'") });
    expect(await total({ projectId: 'p' }, { sessionId: 's2', status: 'active', observationType: 'gotcha' })).toEqual({ state: 'ready', value: 1 });
    expect(await total({ projectId: 'p' }, { fromDay: 11, toDay: 13 })).toEqual({ state: 'ready', value: f.recount(`project_id='p' AND created_at >= ${11 * DAY} AND created_at < ${13 * DAY}`) });
    expect(await total({ projectId: 'p' }, { fromDay: 12 })).toEqual({ state: 'ready', value: 1 });
    expect(await total({ all: true }, {})).toEqual({ state: 'ready', value: f.recount() });
    expect(await total({ all: false, projectIds: ['q'] }, {})).toEqual({ state: 'ready', value: 1 });
    expect(await total({ projectId: 'p' }, { sessionId: 's2', fromDay: 11, toDay: 12 })).toEqual({ state: 'ready', value: f.recount(`project_id='p' AND session_id='s2' AND created_at >= ${11 * DAY} AND created_at < ${12 * DAY}`) });
    expect(await total({ projectId: 'p' }, { sessionId: 's2', fromDay: 12 })).toEqual({ state: 'ready', value: 1 });

    const both = await sporeTotalAndFacets(f.db, { all: false, projectIds: ['p'] }, { observationType: 'gotcha' });
    expect(both).toEqual({ state: 'ready', value: { total: 2, facets: { type: { decision: 1, gotcha: 2 }, project: { p: 2 } } } });
  });

  it('answers building until existing spores and plans are counted, then exact totals with live writes interleaved', async () => {
    const f = fixture();
    for (let i = 0; i < 120; i++) f.spore(`s${String(i).padStart(3, '0')}`, { type: i % 3 === 0 ? 'gotcha' : 'decision', at: (i % 5) * DAY });
    for (let i = 0; i < 70; i++) f.plan(`plan${i}`, i % 2 === 0 ? 'active' : 'completed');
    // As a Deployment holding spores and plans before the counters existed: no facts, and the catch-up not yet run.
    f.sqlite.run('DELETE FROM spore_count_facts'); f.sqlite.run('DELETE FROM plan_count_facts');
    await resetProjectionCatchup(f.db);
    expect(await sporeTotal(f.db, { projectId: 'p' }, {})).toEqual({ state: 'building' });
    expect(await planStatusTotals(f.db, { projectId: 'p' })).toEqual({ state: 'building' });

    // Writes landing while the catch-up runs are counted once, wherever their keys fall.
    await catchUpProjections(f.db, { budget: { calls: 40, wallMs: 60_000 } });
    f.spore('s000a'); f.spore('zzz'); f.sqlite.run("UPDATE spores SET status='obsolete' WHERE id IN ('s001','s119')");
    f.sqlite.run("DELETE FROM spores WHERE id='s050'"); f.plan('plan-new', 'abandoned'); f.sqlite.run("UPDATE plans SET status='completed' WHERE plan_key='plan0'");
    for (let i = 0; i < 50 && (await catchUpProjections(f.db, { budget: { calls: 120, wallMs: 60_000 } })).more; i++) { /* drain */ }

    expect(await sporeTotal(f.db, { projectId: 'p' }, {})).toEqual({ state: 'ready', value: f.recount() });
    expect(await sporeTotal(f.db, { projectId: 'p' }, { status: 'obsolete' })).toEqual({ state: 'ready', value: 2 });
    expect(await sporeTotal(f.db, { projectId: 'p' }, { observationType: 'gotcha', fromDay: 0, toDay: 2 }))
      .toEqual({ state: 'ready', value: f.recount(`observation_type='gotcha' AND created_at < ${2 * DAY}`) });
    const plans = Object.fromEntries((f.sqlite.query("SELECT status,COUNT(*) AS n FROM plans GROUP BY status").all() as { status: string; n: number }[]).map(r => [r.status, r.n]));
    expect(await planStatusTotals(f.db, { all: true })).toEqual({ state: 'ready', value: plans });
    // Replaying the catch-up changes nothing.
    await resetProjectionCatchup(f.db);
    for (let i = 0; i < 50 && (await catchUpProjections(f.db, { budget: { calls: 120, wallMs: 60_000 } })).more; i++) { /* drain */ }
    expect(await sporeTotal(f.db, { projectId: 'p' }, {})).toEqual({ state: 'ready', value: f.recount() });
    expect(await planStatusTotals(f.db, { projectId: 'p' })).toEqual({ state: 'ready', value: plans });
  });

  it('probes an active floor without counting past it', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) f.spore(`a${i}`);
    f.spore('gone', { status: 'superseded' });
    expect(await activeSporesAtLeast(f.db, 'p', 3)).toBe(true);
    expect(await activeSporesAtLeast(f.db, 'p', 4)).toBe(false);
  });
});

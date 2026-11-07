import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { commit } from '@myco-server-worker/db/index.js';
import { KPI_MEASURES, kpiTriggers, reconcileKpi } from '@myco-server-worker/db/insights/kpi-reconcile.js';
import { catchUpKpiPhase, catchUpProjections, kpiCatchupSeed, kpiPageStatements, projectionReadiness, resetProjectionCatchup, PROJECTION_PAGE_SIZE } from '@myco-server-worker/db/projections/catchup.js';
import { VNEXT_STATEMENTS } from '@myco-server-worker/db/schema-vNEXT.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { readKpis, KPI_METRIC_VERSION, type KpiWindow } from '@myco-server-worker/read/kpis.js';
import { kpis_readKpis as sourceKpis } from './helpers/kpi-oracle.js';
import { BACKUP_FORMAT, deploymentId, EXCLUDED_TABLES, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { rig, NOW, DAY, PROJECT, OTHER } from './helpers/kpi-fixture.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';

type Fixture = ReturnType<typeof rig>;
const TODAY = Math.floor(NOW / DAY);
const rate = (n: number, d: number) => ({ value: d === 0 ? null : n / d, sampleSize: d });

async function measured(r: Fixture, window: KpiWindow, today = TODAY) {
  const answer = await readKpis(r.db, { window, now: today * DAY });
  expect(answer.state).toBe('ready');
  if (answer.state !== 'ready') throw new Error('KPI projection is building');
  return answer;
}

function transcript(r: Fixture, session: string, id: string, agent: string, scheme: string | null, at: number, primary = false, project = PROJECT) {
  r.sqlite.query(`INSERT INTO transcripts(project_id,session_id,transcript_id,machine_id,agent,size,segment_count,first_received_at,last_received_at,token_id,role,prompt_identity_scheme)
    VALUES(?,?,?,'m1',?,0,0,?,?,'cred_1',?,?)`).run(project, session, id, agent, at, at, primary ? 'primary' : 'subagent', scheme);
}

function answer(r: Fixture, id: string, skipped: string[] | string, at = NOW) {
  r.sqlite.query(`INSERT INTO prompt_context_answers(project_id,session_id,id,prompt_id,ask_protocol,asked_at,outcome,context_chars,parts,skipped,failures,selection,created_at)
    VALUES(?,'a',?,'p1','v1',?,'empty',0,'[]',?,'[]','{}',?)`).run(PROJECT, id, at, typeof skipped === 'string' ? skipped : JSON.stringify(skipped), at);
}

function clearProjection(r: Fixture) {
  r.sqlite.exec('DELETE FROM kpi_fact; DELETE FROM kpi_lineage');
}

async function drain(r: Fixture) {
  for (let n = 0; n < 20 && await projectionReadiness(r.db, 'kpi') === 'building'; n++) await catchUpProjections(r.db);
  expect(await projectionReadiness(r.db, 'kpi')).toBe('ready');
}

function snapshot(r: Fixture) {
  return {
    facts: r.sqlite.query('SELECT * FROM kpi_fact ORDER BY project_id,session_id,grain,key').all(),
    daily: r.sqlite.query(`SELECT * FROM kpi_daily WHERE ${KPI_MEASURES.map(c => `${c}<>0`).join(' OR ')} ORDER BY day,harness`).all(),
    lineage: r.sqlite.query('SELECT * FROM kpi_lineage ORDER BY lineage_root').all(),
  };
}

async function oracle(r: Fixture, windowDays: KpiWindow, today = TODAY) {
  const copy = Database.deserialize(r.sqlite.serialize());
  try {
    const report = await sourceKpis(sqliteRelationalStore(copy), { windowDays, now: today * DAY });
    return {
      ...report, state: 'ready' as const, windowStart: report.since,
      windowEnd: (today + 1) * DAY - 1, asOf: today * DAY, metricVersion: KPI_METRIC_VERSION,
    };
  } finally { copy.close(); }
}

function seed() {
  const r = rig();
  r.credential('cred_1', { startedAt: NOW - 40 * DAY });
  r.credential('rotated', { lineage: 'cred_1', startedAt: NOW - 40 * DAY });
  r.credential('negative', { startedAt: NOW - 100 });
  r.credential('revoked', { startedAt: NOW - DAY });
  r.session('a', { agent: null });
  r.session('b', { agent: 'codex' });
  r.session('c', { tokenId: 'revoked' });
  r.session('convert');
  r.session('e', { project: OTHER });
  r.session('negative', { tokenId: 'negative', agent: null });
  r.session('rotated', { tokenId: 'rotated', agent: null });
  r.sqlite.query('UPDATE projects SET archived_at=? WHERE project_id=?').run(NOW, OTHER);
  for (let i = 0; i <= PROJECTION_PAGE_SIZE; i++) r.session(`z${String(i).padStart(3, '0')}`, { agent: null });
  r.prompt('p1', 'a');
  r.prompt('p3', 'a');
  r.prompt('future', 'a', { at: NOW + DAY });
  for (const kind of ['unrecognized', 'unmarked', 'opener_conflict', 'contract_violation']) {
    r.prompt(kind, 'a');
    r.sqlite.query('UPDATE session_prompts SET claim=?,prompt_kind=? WHERE project_id=? AND session_id=? AND prompt_id=?')
      .run(kind === 'unmarked' ? 'reused' : 'owner', kind, PROJECT, 'a', kind);
  }
  r.prompt('old', 'b'); r.call('old', 'b', { tool: 'myco_plans', op: 'get' });
  r.prompt('deleted', 'c');
  r.prompt('hidden', 'convert'); r.call('hidden', 'convert');
  r.sqlite.query("UPDATE session_documents SET state='convert' WHERE project_id=? AND session_id='convert'").run(PROJECT);
  r.prompt('archived', 'e', { project: OTHER }); r.call('save', 'e', { project: OTHER, tool: 'myco_plans', op: 'save' });
  r.call('list', 'a', { tool: 'myco_plans' });
  r.call('failed', 'a');
  r.sqlite.query("UPDATE myco_tool_calls SET success=0 WHERE project_id=? AND session_id='a' AND tool_call_id='failed'").run(PROJECT);
  r.sporeInjection('a', 'p1', ['spore']);
  r.sporeInjection('a', 'late', ['spore'], { at: NOW - 30 * DAY, deliveredTo: 'p2', deliveredAt: NOW });
  r.sporeInjection('b', 'pending', ['spore'], { deliveredTo: null });
  r.sporeInjection('c', 'deleted', ['spore'], { at: NOW - 100 });
  r.sporeInjection('negative', 'negative', [], { at: NOW - 200, deliveredTo: null });
  r.sessionInjection('a', 'cortex');
  r.sessionInjection('a', 'plan-nudge');
  r.sqlite.query("UPDATE session_injections SET delivered_at=?,delivered_prompt_id='p3' WHERE project_id=? AND session_id='a' AND kind='plan-nudge'").run(NOW, PROJECT);
  r.sqlite.query("INSERT INTO prompt_identity_conflicts(project_id,session_id,prompt_id,source_key,source_thread,source_record,created_at) VALUES(?,'a','p1','key','thread','record',?)").run(PROJECT, NOW);
  answer(r, 'kept', ['spores:duplicate_prompt']); answer(r, 'pruned', ['spores:duplicate_prompt'], NOW - 31 * DAY);
  transcript(r, 'b', 'old-scheme', 'codex', 'old', NOW - 10 * DAY);
  transcript(r, 'b', 'other-scheme', 'codex', 'different', NOW - DAY);
  transcript(r, 'e', 'unpinned', 'claude-code', null, NOW, false, OTHER);
  return r;
}

describe('KPI projection critical flow', () => {
  it('projects late document arrival from only its live generation and replays without writes', async () => {
    const r = seed();
    try {
      for (const [state, generation] of [['live', 1], ['live', 2], ['convert', 1]] as const) {
        r.sqlite.query("DELETE FROM session_documents WHERE project_id=? AND session_id='a'").run(PROJECT);
        expect(projected(r, null)).toEqual(await oracle(r, null));
        r.sqlite.query("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES(?,'a',?,?,?)")
          .run(PROJECT, state, generation, NOW);
        expect(projected(r, null)).toEqual(await oracle(r, null));
        const writes = r.sqlite.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
        r.sqlite.query("INSERT OR IGNORE INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES(?,'a',?,?,?)")
          .run(PROJECT, state, generation, NOW);
        expect(r.sqlite.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n).toBe(writes);
      }
    } finally { r.sqlite.close(); }
  });

  it('converges after late arrivals, generation replacement, deletion, reattribution and interrupted catch-up', async () => {
    const r = seed();
    try {
      expect(await projectionReadiness(r.db, 'kpi')).toBe('ready');
      for (const window of [null, 7] as const) expect(await measured(r, window)).toEqual(await oracle(r, window));
      clearProjection(r); await resetProjectionCatchup(r.db);
      expect(await catchUpKpiPhase(r.db, 'sessions')).toBe(PROJECTION_PAGE_SIZE);
      expect(await projectionReadiness(r.db, 'kpi')).toBe('building');

      r.prompt('p2', 'a');
      transcript(r, 'a', 'older-primary', 'cursor', 'cursor-v1', NOW - DAY, true);
      r.sqlite.transaction(() => {
        r.sqlite.query("DELETE FROM session_prompts WHERE project_id=? AND session_id='b'").run(PROJECT);
        r.sqlite.query("DELETE FROM myco_tool_calls WHERE project_id=? AND session_id='b'").run(PROJECT);
        r.sqlite.query("UPDATE session_documents SET generation=2 WHERE project_id=? AND session_id='b'").run(PROJECT);
        r.sqlite.query("INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at) VALUES(?,'b',2,'replacement','replacement',0,'user',?)").run(PROJECT, NOW);
        r.sqlite.query("INSERT INTO myco_tool_calls(project_id,session_id,generation,tool_call_id,myco_tool,myco_op,success,created_at) VALUES(?,'b',2,'replacement','myco_plans','get',1,?)").run(PROJECT, NOW);
      })();
      r.sqlite.query("UPDATE spore_injections SET delivered_at=?,delivered_prompt_id='replacement',delivered_scope_reason=NULL WHERE project_id=? AND session_id='b'").run(NOW, PROJECT);
      expect((await tombstoneSession({ db: r.db }, { projectId: PROJECT }, 'c', 'mem_1', NOW)).applied).toBe(true);
      r.sqlite.query("DELETE FROM member_credentials WHERE id='revoked'").run();
      r.sqlite.query("DELETE FROM prompt_context_answers WHERE id='pruned'").run();
      r.sqlite.query("UPDATE sessions SET first_received_at=? WHERE project_id=? AND session_id IN ('a','z050')").run(NOW - 9 * DAY, PROJECT);

      const before = snapshot(r);
      // The cursor statement fails inside the native transaction after fact statements execute.
      const failDb: RelationalStore = { ...r.db, prepare: sql => sql.startsWith('UPDATE projection_catchup SET after_key=')
        ? r.db.prepare('UPDATE projection_catchup SET done=2 WHERE ?1 IS NOT NULL AND ?2 IS NOT NULL AND ?3 IS NOT NULL AND ?4 IS NOT NULL AND ?5 IS NOT NULL')
        : r.db.prepare(sql) };
      await expect(catchUpKpiPhase(failDb, 'documents')).rejects.toThrow();
      expect(snapshot(r)).toEqual(before);
      expect(r.sqlite.query("SELECT after_key,done FROM projection_catchup WHERE phase='documents'").get()).toEqual({ after_key: '[]', done: 0 });

      // A mutation between the key read and commit must be read by reconciliation itself.
      let mutated = false;
      const racing: RelationalStore = { ...r.db, batch: async statements => {
        const result = await r.db.batch(statements);
        if (!mutated) {
          mutated = true;
          r.sqlite.query("UPDATE session_prompts SET created_at=? WHERE project_id=? AND session_id='a' AND prompt_id='p1'").run(NOW - 8 * DAY, PROJECT);
        }
        return result;
      } };
      await catchUpKpiPhase(racing, 'documents');
      await drain(r);
      for (const window of [null, 7] as const) expect(await measured(r, window)).toEqual(await oracle(r, window));
      const report = await measured(r, null);
      expect(report.promptsServed).toBe(4);
      expect(report.deliveries).toEqual({ placed: 3, unplaced: 0 });
      expect(report.servedShare).toEqual(rate(4, 9));
      expect(report.sporeServeRate).toEqual(rate(3, 9));
      expect(report.callsPerPrompt).toEqual(rate(4, 9));
      expect(report.planReadsPerSession).toEqual(rate(2, 58));
      expect(report.sessionStartPresent).toEqual(rate(1, 58));
      expect(report.firstInjectionMs).toEqual({ value: 10 * DAY, sampleSize: 1 });
      expect((await measured(r, null, TODAY + 1)).servedShare.sampleSize).toBe(10);
      expect((await measured(r, 7)).servedShare).toEqual(rate(3, 8));
      expect(report.promptIdentity.find(row => row.harness === 'cursor')).toEqual({ harness: 'cursor', sampleSize: 4, unrecognized: 1, unmarked: 1, openerConflict: 1, contractViolation: 1, reused: 1, identityConflicts: 1, duplicatePromptSkips: 1, schemeConflicts: 0, mixedSchemeSessions: 0 });
      const settled = snapshot(r);
      const writes = r.sqlite.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
      await commit(r.db, ...kpiPageStatements('documents', JSON.stringify([[PROJECT, 'a'], [PROJECT, 'b']])));
      const last = r.sqlite.query<{ after_key: string }, []>("SELECT after_key FROM projection_catchup WHERE projection='kpi' AND phase='documents'").get()!;
      await commit(r.db, ...kpiPageStatements('documents', `[${last.after_key}]`));
      expect(r.sqlite.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n).toBe(writes);
      expect(snapshot(r)).toEqual(settled);
      clearProjection(r); await resetProjectionCatchup(r.db); await drain(r);
      expect(snapshot(r)).toEqual(settled);
    } finally { r.sqlite.close(); }
  });

  it('pins frozen trigger SQL, derived backup exclusions and fresh-store readiness', async () => {
    expect(VNEXT_STATEMENTS.filter(sql => sql.startsWith('CREATE TRIGGER'))).toEqual(kpiTriggers().map(t => t.sql));
    expect(VNEXT_STATEMENTS.filter(sql => sql.startsWith('INSERT INTO projection_catchup'))).toEqual(kpiCatchupSeed());
    for (const table of ['kpi_fact', 'kpi_daily', 'kpi_lineage', 'projection_catchup']) expect(EXCLUDED_TABLES.has(table)).toBe(true);
    const r = rig();
    try { expect(await projectionReadiness(r.db, 'kpi')).toBe('ready'); } finally { r.sqlite.close(); }
  });

  it('preserves malformed skipped text on answer insert and update without counting it', async () => {
    const r = rig();
    try {
      r.session('a');
      answer(r, 'malformed', 'not json');
      const source = () => r.sqlite.query("SELECT skipped FROM prompt_context_answers WHERE id='malformed'").get();
      const count = () => r.sqlite.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM kpi_fact WHERE grain='a'").get()!.n;
      expect(source()).toEqual({ skipped: 'not json' });
      expect(count()).toBe(0);
      r.sqlite.query("UPDATE prompt_context_answers SET skipped=? WHERE id='malformed'").run('["spores:duplicate_prompt"]');
      expect(count()).toBe(1);
      r.sqlite.query("UPDATE prompt_context_answers SET skipped=? WHERE id='malformed'").run('x');
      expect(source()).toEqual({ skipped: 'x' });
      expect(count()).toBe(0);
      expect((await measured(r, null)).promptIdentity).toEqual([]);
    } finally { r.sqlite.close(); }
  });

  it('drains multiple five-session document pages within budget and requests more until done', async () => {
    const r = rig();
    try {
      for (let i = 0; i < 11; i++) {
        const session = `s${String(i).padStart(2, '0')}`;
        r.session(session, { agent: null }); r.prompt('p', session);
      }
      r.sqlite.exec("DELETE FROM kpi_fact WHERE grain='p'; UPDATE projection_catchup SET done=0,frontier=NULL,after_key='[]' WHERE projection='kpi' AND phase='documents'");
      let calls = 0;
      const counted: RelationalStore = { ...r.db, batch: statements => { calls += statements.length; return r.db.batch(statements); } };
      expect(await catchUpProjections(counted, { budget: { calls: 19, wallMs: 100 }, clock: () => 0 })).toEqual({ changed: 10, more: true });
      expect(calls).toBe(19);
      expect(r.sqlite.query("SELECT COUNT(*) AS n FROM kpi_fact WHERE grain='p'").get()).toEqual({ n: 10 });
      expect(await projectionReadiness(r.db, 'kpi')).toBe('building');
      expect(await catchUpProjections(r.db, { budget: { calls: 19, wallMs: 0 }, clock: () => 0 })).toEqual({ changed: 0, more: true });
      expect(await catchUpProjections(r.db, { budget: { calls: 10, wallMs: 100 }, clock: () => 0 })).toEqual({ changed: 1, more: false });
      expect(await projectionReadiness(r.db, 'kpi')).toBe('ready');
      expect(await catchUpProjections(r.db)).toEqual({ changed: 0, more: false });
      expect(await measured(r, null)).toEqual(await oracle(r, null));
    } finally { r.sqlite.close(); }
  });

  it('invalidates readiness through the restore path and converges again through the wake job', async () => {
    const r = rig();
    try {
      r.session('a'); r.prompt('p1', 'a');
      const before = snapshot(r);
      const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(r.db), schemaVersion: SERVER_SCHEMA_VERSION, createdAt: NOW, producer: 'test', counts: {} };
      await restoreArtifact(r.db, { authorization: { kind: 'recovery' }, text: JSON.stringify(header) + '\n' });
      expect(await projectionReadiness(r.db, 'kpi')).toBe('building');
      const { JOB_IMPLEMENTATIONS } = await import('@myco-server-worker/core/jobs-run.js');
      const { sqliteEnv } = await import('./helpers/fixtures.js');
      const runtime = sqliteEnv();
      try {
        await JOB_IMPLEMENTATIONS['projection-catch-up']!({ ...runtime.serverEnv, db: r.db }, NOW, 'sleep');
      } finally { runtime.sqlite.close(); }
      expect(await projectionReadiness(r.db, 'kpi')).toBe('ready');
      expect(snapshot(r)).toEqual(before);
    } finally { r.sqlite.close(); }
  });

  it('measures extra native row writes for every source mechanism and no-op replay', () => {
    const maintained = rig();
    const baseline = rig();
    try {
      for (const trigger of kpiTriggers()) baseline.sqlite.exec(`DROP TRIGGER ${trigger.name}`);
      const changes = (r: Fixture) => r.sqlite.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
      const costs: Record<string, number> = {};
      const measure = (name: string, mutate: (r: Fixture) => void) => {
        const run = (r: Fixture) => { const before = changes(r); mutate(r); return changes(r) - before; };
        costs[name] = run(maintained) - run(baseline);
      };
      for (const r of [maintained, baseline]) r.credential('cred_1', { startedAt: NOW - DAY });
      measure('session', r => r.session('a', { agent: null }));
      measure('prompt', r => r.prompt('p1', 'a'));
      measure('call', r => r.call('call', 'a'));
      measure('receipt', r => r.sporeInjection('a', 'p1', ['spore'], { deliveredTo: null }));
      measure('delivery', r => r.sqlite.query("UPDATE spore_injections SET delivered_at=?,delivered_prompt_id='p1' WHERE project_id=? AND session_id='a'").run(NOW, PROJECT));
      measure('cortex', r => r.sessionInjection('a', 'cortex', { at: NOW - 1 }));
      measure('primary', r => transcript(r, 'a', 'primary', 'claude-code', 'scheme-one', NOW, true));
      measure('unpinned', r => transcript(r, 'a', 'unpinned', 'claude-code', null, NOW));
      measure('mixed', r => transcript(r, 'a', 'mixed', 'claude-code', 'scheme-two', NOW));
      measure('unchanged', r => r.sqlite.query("UPDATE session_prompts SET created_at=created_at,claim=claim WHERE project_id=? AND session_id='a'").run(PROJECT));
      expect(costs).toEqual({ session: 3, prompt: 2, call: 2, receipt: 1, delivery: 5, cortex: 4, primary: 12, unpinned: 2, mixed: 2, unchanged: 0 });
      console.info('KPI_NATIVE_EXTRA_WRITES ' + JSON.stringify(costs));
    } finally { maintained.sqlite.close(); baseline.sqlite.close(); }
  });

  it('seeks the complete live source key for prompts, calls and delivery placement', () => {
    const r = rig();
    try {
      const keys = `SELECT '${PROJECT}' AS project_id,'a' AS session_id,'key' AS k`;
      for (const grain of ['p', 'c'] as const) {
        for (const sql of reconcileKpi(grain, keys)) {
          const plan = r.sqlite.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail);
          expect(plan.some(detail => detail.includes(`generation=? AND ${grain === 'p' ? 'prompt_id' : 'tool_call_id'}=?)`))).toBe(true);
          if (sql.startsWith('DELETE')) expect(plan).toContain('SEARCH kpi_fact USING PRIMARY KEY (project_id=? AND session_id=? AND grain=? AND key=?)');
        }
      }
      const placement = r.sqlite.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${reconcileKpi('d', keys)[1]}`).all();
      expect(placement.some(row => row.detail.includes('generation=? AND prompt_id=?)'))).toBe(true);
    } finally { r.sqlite.close(); }
  });

  it('keeps exact lineage minima across corrections, rotation, reassignment and deletion', async () => {
    const r = rig();
    try {
      r.credential('cred_1', { startedAt: NOW - DAY });
      r.credential('rotated', { lineage: 'cred_1', startedAt: NOW - DAY });
      r.credential('other', { startedAt: NOW - DAY });
      r.session('a', { agent: null }); r.session('b', { tokenId: 'rotated', agent: null });
      r.sporeInjection('a', 'p1', [], { deliveredTo: null, at: NOW - 10 });
      r.sessionInjection('b', 'cortex', { at: NOW - 20 });
      const compare = async () => expect(await measured(r, null)).toEqual(await oracle(r, null));
      await compare();
      r.sqlite.query("UPDATE session_injections SET created_at=? WHERE project_id=? AND session_id='b'").run(NOW, PROJECT);
      await compare();
      r.sqlite.query("UPDATE spore_injections SET created_at=? WHERE project_id=? AND session_id='a'").run(NOW - 30, PROJECT);
      await compare();
      r.sqlite.query("DELETE FROM spore_injections WHERE project_id=? AND session_id='a'").run(PROJECT);
      await compare();
      r.sqlite.query("UPDATE sessions SET created_by_token_id='other' WHERE project_id=? AND session_id='b'").run(PROJECT);
      await compare();
      r.sqlite.query("DELETE FROM member_credentials WHERE id IN ('cred_1','rotated')").run();
      await compare();
      expect(r.sqlite.query('SELECT lineage_root FROM kpi_lineage').all()).toEqual([{ lineage_root: 'other' }]);
      r.sqlite.query("DELETE FROM member_credentials WHERE id='other'").run();
      expect(r.sqlite.query('SELECT * FROM kpi_lineage').all()).toEqual([]);
      await compare();
      r.credential('restore', { startedAt: NOW - DAY });
      r.sporeInjection('restored-session', 'receipt-before-session', [], { deliveredTo: null });
      r.session('restored-session', { tokenId: 'restore', agent: null });
      await compare();
      expect((await measured(r, null)).firstInjectionMs).toEqual({ value: DAY, sampleSize: 1 });
    } finally { r.sqlite.close(); }
  });

  it('orders equal primary receipts by transcript id and uses UTC day boundaries', async () => {
    const r = rig();
    try {
      r.session('a', { agent: null });
      r.prompt('today', 'a', { at: (TODAY + 1) * DAY - 1 });
      r.prompt('boundary', 'a', { at: (TODAY - 7) * DAY });
      r.prompt('outside', 'a', { at: (TODAY - 7) * DAY - 1 });
      transcript(r, 'a', 'z', 'claude-code', 'one', NOW, true);
      transcript(r, 'a', 'a', 'codex', 'two', NOW, true);
      expect((await measured(r, 7)).callsPerPromptByHarness).toEqual([{ harness: 'codex', calls: 0, value: 0, sampleSize: 2 }]);
      r.sqlite.query("DELETE FROM transcripts WHERE project_id=? AND transcript_id='a'").run(PROJECT);
      expect((await measured(r, 7)).callsPerPromptByHarness[0]!.harness).toBe('claude-code');
      expect(await measured(r, 7)).toEqual(await oracle(r, 7));
      r.sqlite.query("DELETE FROM transcripts WHERE project_id=? AND transcript_id='z'").run(PROJECT);
      expect((await measured(r, 7)).callsPerPromptByHarness[0]!.harness).toBe('unrecorded');
    } finally { r.sqlite.close(); }
  });
});

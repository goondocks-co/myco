import { afterEach, describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '@myco-server-worker/platform/bun/vectors.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { EmbeddingUnavailable, type EmbeddingProvider } from '@myco-server-worker/core/embedding/provider.js';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/work.js';
import { embeddingProviderReady, recordEmbeddingProviderFailure, clearEmbeddingProviderHold } from '@myco-server-worker/core/embedding/provider-state.js';
import { prepareEmbeddingDue, retainEmbeddingModels, journalSourceAttempt, resetEmbeddingIndex } from '@myco-server-worker/db/embeddings/work.js';
import { modelProgress, modelReadiness } from '@myco-server-worker/db/embeddings/status.js';
import { sourceStateTriggers } from '@myco-server-worker/db/embeddings/state.js';
import { catchUpPhase, catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { V716_STATEMENTS } from '@myco-server-worker/db/schema-v716.js';
import { INPUT_REFUSAL_RETRY_MS } from '@myco-server-worker/db/embedding-due.js';

configureSqliteLibrary();
const MODEL = 'state-model';
const NOW = 1_000_000;
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

function fixture() {
  const f = sqliteEnv(); opened.push(f);
  const insert = (table: string, row: Record<string, unknown>) => f.sqlite.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as never[]);
  insert('projects', { project_id: 'p', name: 'project', created_at: 1 });
  insert('agents', { id: 'a', name: 'agent', source: 'built-in', enabled: 1, created_at: 1 });
  const spore = (id: string, content = `knowledge ${id}`) => insert('spores', { project_id: 'p', id, agent_id: 'a', content, observation_type: 'decision', created_at: 1 });
  const refused = new Set<string>();
  const provider: EmbeddingProvider = { modelKey: MODEL, embed: async (text) => {
    if ([...refused].some(word => text.includes(word))) throw new EmbeddingUnavailable('input refused', { kind: 'input', detail: null });
    return [1, 0];
  } };
  const context = { db: f.db, blobs: f.bucket, vectors: sqliteVectorStore(f.sqlite), provider };
  const settle = async (now = NOW) => { for (let i = 0; i < 400; i++) if ((await reconcileEmbedding(context, 'p', now)).processed === 0) return; };
  const ready = () => modelReadiness(f.db, 'p', MODEL, NOW);
  const recount = () => f.sqlite.query(`SELECT state,COUNT(*) AS n FROM embedding_source_state WHERE project_id='p' AND model_key=? GROUP BY state ORDER BY state`).all(MODEL);
  const totals = () => f.sqlite.query(`SELECT state,n FROM embedding_model_totals WHERE project_id='p' AND model_key=? AND n<>0 ORDER BY state`).all(MODEL);
  return { ...f, insert, spore, refused, context, settle, ready, recount, totals };
}

/** Drives one source lifecycle and returns what status reads after each transition. */
async function lifecycle(f: ReturnType<typeof fixture>) {
  const seen: unknown[] = [];
  const observe = async () => {
    const r = await f.ready();
    expect(f.totals()).toEqual(f.recount());
    seen.push({ state: r.state, ready: r.ready, total: r.total, byState: r.byState });
  };
  f.spore('a'); f.spore('b'); f.spore('c');
  await observe();
  await f.settle();
  await observe();
  f.sqlite.run("UPDATE spores SET content='edited' WHERE project_id='p' AND id='a'");
  await observe();
  f.sqlite.run("UPDATE spores SET status='superseded' WHERE project_id='p' AND id='b'");
  await observe();
  f.sqlite.run("UPDATE embedding_receipts SET ready=0,rewrites=1 WHERE project_id='p' AND record_id='c' AND ready=1");
  await observe();
  f.sqlite.run("UPDATE embedding_receipts SET ready=-1 WHERE project_id='p' AND record_id='c'");
  await observe();
  f.sqlite.run("DELETE FROM spores WHERE project_id='p' AND id='c'");
  await observe();
  await f.settle();
  await observe();
  await retainEmbeddingModels(f.db, 'p', []);
  await observe();
  while ((await prepareEmbeddingDue(f.db, 'p', MODEL)).more);
  await observe();
  return seen;
}

describe('per-model embedding source state', () => {
  it('follows every source through writes, edits, eligibility, rewrites, deletion claims and model activation', async () => {
    const f = fixture();
    const seen = await lifecycle(f);
    const at = (i: number) => seen[i] as { state: string; ready: number; total: number; byState: Record<string, number> };
    expect(at(0)).toMatchObject({ state: 'building', ready: 0, total: 0 });
    expect(at(1)).toMatchObject({ state: 'ready', ready: 3, total: 3 });
    expect(at(2)).toMatchObject({ state: 'ready', ready: 2, total: 3, byState: { unwritten: 1 } });
    expect(at(3)).toMatchObject({ ready: 1, total: 2 });
    expect(at(4)).toMatchObject({ ready: 0, total: 2, byState: { rewriting: 1, unwritten: 1 } });
    expect(at(5)).toMatchObject({ byState: { unavailable: 1, unwritten: 1 } });
    expect(at(6)).toMatchObject({ ready: 0, total: 1 });
    expect(at(7)).toMatchObject({ state: 'ready', ready: 1, total: 1 });
    expect(at(8)).toMatchObject({ state: 'building' });
    expect(at(9)).toMatchObject({ state: 'ready', ready: 1, total: 1 });
    expect(await modelProgress(f.db, MODEL, NOW)).toMatchObject({ state: 'ready', ready: 1, total: 1 });
    f.sqlite.run("UPDATE projects SET archived_at=1 WHERE project_id='p'");
    expect(await modelProgress(f.db, MODEL, NOW)).toMatchObject({ state: 'ready', ready: 0, total: 0 });
  });

  it('answers the same through triggers rebuilt from their generator', async () => {
    const frozen = await lifecycle(fixture());
    const f = fixture();
    for (const trigger of sourceStateTriggers()) { f.sqlite.run(`DROP TRIGGER ${trigger.name}`); f.sqlite.run(trigger.sql); }
    expect(await lifecycle(f)).toEqual(frozen);
  });

  it('installs over existing sources without changing them, reads building, then catches up exactly', async () => {
    const f = fixture();
    for (let i = 0; i < 120; i++) f.spore(`s${String(i).padStart(3, '0')}`);
    await f.settle();
    f.spore('late');
    const tables = ['spores', 'embedding_versions', 'embedding_receipts', 'embedding_due', 'embedding_source_failures'];
    const snapshot = () => tables.map(table => f.sqlite.query(`SELECT * FROM ${table} ORDER BY 1,2,3`).all());
    const before = snapshot();
    const expected = { ...(await f.ready()), asOf: NOW };
    for (const trigger of sourceStateTriggers()) f.sqlite.run(`DROP TRIGGER ${trigger.name}`);
    f.sqlite.run('DROP TABLE embedding_source_state');
    f.sqlite.run('DROP TABLE embedding_model_totals');
    f.sqlite.run("DELETE FROM projection_catchup WHERE projection='embedding_state'");
    const stateStatements = V716_STATEMENTS.filter(sql => /embedding_source_state|embedding_model_totals|'embedding_state'/.test(sql) && !sql.startsWith('ALTER TABLE'));
    for (const sql of stateStatements) f.sqlite.run(sql);
    expect(snapshot()).toEqual(before);
    expect(await f.ready()).toMatchObject({ state: 'building' });
    expect(await modelProgress(f.db, MODEL, NOW)).toMatchObject({ state: 'building' });
    let pages = 0;
    while ((await catchUpProjections(f.db, { budget: { calls: 12, wallMs: 10_000 } })).more) {
      pages++;
      if (pages === 1) { f.spore('during'); f.sqlite.run("UPDATE spores SET content='moved' WHERE id='s000'"); }
    }
    expect(pages).toBeGreaterThan(0);
    expect(f.totals()).toEqual(f.recount());
    expect(await f.ready()).toMatchObject({ state: 'ready', ready: expected.ready - 1, total: expected.total + 1 });
    expect(snapshot()[0]).toHaveLength((before[0] as unknown[]).length + 1);
  });
});

describe('due-only embedding work', () => {
  it('finds work from maintained due rows, waits for refusals to expire, and schedules no idle sweep', async () => {
    const f = fixture();
    for (let i = 0; i < 40; i++) f.spore(`s${i}`);
    f.spore('refused text');
    f.refused.add('refused text');
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW)).toBe(true);
    await f.settle();
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW)).toBe(false);
    for (const later of [NOW + 5 * 60_000, NOW + 60 * 60_000, NOW + INPUT_REFUSAL_RETRY_MS - 1]) {
      expect(await hasEmbeddingWork(f.db, 'p', MODEL, later)).toBe(false);
    }
    expect(f.sqlite.query("SELECT sweep_cursor FROM embedding_work_state WHERE project_id='p' AND kind='embedding'").all()).toEqual([{ sweep_cursor: null }]);
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW + INPUT_REFUSAL_RETRY_MS)).toBe(true);
    f.refused.clear();
    await f.settle(NOW + INPUT_REFUSAL_RETRY_MS);
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW + INPUT_REFUSAL_RETRY_MS)).toBe(false);
    f.spore('new');
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW + INPUT_REFUSAL_RETRY_MS)).toBe(true);
  });

  it('a Project with nothing to embed needs no run, however many ineligible sources it holds, until one becomes eligible', async () => {
    const f = fixture();
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW)).toBe(false);
    expect(await f.ready()).toMatchObject({ state: 'ready', total: 0 });
    f.insert('sessions', { project_id: 'p', session_id: 'unsummarized', machine_id: 'm', created_by_token_id: 't', first_received_at: 1, last_received_at: 1 });
    f.insert('spores', { project_id: 'p', id: 'retired', agent_id: 'a', content: 'body', observation_type: 'decision', created_at: 1, status: 'superseded' });
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW + 1)).toBe(false);
    expect(await f.ready()).toMatchObject({ state: 'ready', total: 0 });
    f.sqlite.run("UPDATE spores SET status='active' WHERE project_id='p' AND id='retired'");
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW + 2)).toBe(true);
    expect(await f.ready()).toMatchObject({ state: 'building' });
    await f.settle(NOW + 2);
    expect(await hasEmbeddingWork(f.db, 'p', MODEL, NOW + 3)).toBe(false);
    expect(await f.ready()).toMatchObject({ state: 'ready', ready: 1, total: 1 });
  });
});

/** A store whose first batch commits, then parks until released, as a request paused between its read and its write. */
function pausedAfterFirstBatch(db: ReturnType<typeof fixture>['db']) {
  let release!: () => void, arrive!: () => void;
  const reached = new Promise<void>(resolve => { arrive = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  let batches = 0;
  const held: typeof db = { prepare: (sql) => db.prepare(sql), batch: async (statements) => {
    const results = await db.batch(statements);
    if (++batches === 1) { arrive(); await resume; }
    return results;
  } };
  return { db: held, reached, release };
}

/** Two overlapping reconciles: the first parks inside its provider call until released. */
function overlapping(kind: 'refusal' | 'busy') {
  const f = fixture();
  f.insert('plans', { project_id: 'p', plan_key: 'plan', session_id: 's', event_id: 'e', machine_id: 'm', content: 'body', content_hash: 'h', status: 'active', created_at: 1, updated_at: 1, token_id: 't', received_at: 1 });
  let enter!: () => void, release!: (values: number[]) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const parked = new Promise<number[]>(resolve => { release = resolve; });
  let calls = 0;
  const provider: EmbeddingProvider = { modelKey: MODEL, embed: async () => {
    if (++calls === 1) { enter(); return parked; }
    if (kind === 'refusal') throw new EmbeddingUnavailable('refused', { kind: 'input', detail: null });
    throw new EmbeddingUnavailable('busy', { kind: 'timeout' });
  } };
  const context = { ...f.context, provider };
  return { f, context, entered, release };
}

describe('settlement fences', () => {
  for (const delta of [0, 10]) {
    it(`a late success never erases a newer revision's failure, ${delta} ms apart (B22)`, async () => {
      const { f, context, entered, release } = overlapping('refusal');
      const older = reconcileEmbedding(context, 'p', NOW);
      await entered;
      f.sqlite.run("UPDATE plans SET content='new revision' WHERE project_id='p' AND plan_key='plan'");
      expect(await reconcileEmbedding(context, 'p', NOW + delta)).toMatchObject({ phase: 'passed-over', processed: 1 });
      const failure = f.sqlite.query("SELECT f.reason FROM embedding_source_failures f JOIN embedding_versions v USING(project_id,type,record_id) WHERE f.revision=v.revision").all();
      expect(failure).toHaveLength(1);
      release([1, 0]);
      await older;
      expect(f.sqlite.query("SELECT f.reason FROM embedding_source_failures f JOIN embedding_versions v USING(project_id,type,record_id) WHERE f.revision=v.revision").all()).toEqual(failure);
    });

    it(`a late success never clears a newer attempt's provider hold, ${delta} ms apart (B23)`, async () => {
      const { f, context, entered, release } = overlapping('busy');
      const older = reconcileEmbedding(context, 'p', NOW);
      await entered;
      await expect(reconcileEmbedding(context, 'p', NOW + delta)).rejects.toThrow('busy');
      expect(await embeddingProviderReady(f.db, MODEL, NOW + delta + 1)).toBe(false);
      release([1, 0]);
      await older;
      expect(await embeddingProviderReady(f.db, MODEL, NOW + delta + 1)).toBe(false);
    });
  }

  it('a failure arriving out of order never lowers the fence a success must pass (B23, three attempts)', async () => {
    const f = fixture();
    f.spore('a');
    while ((await prepareEmbeddingDue(f.db, 'p', MODEL)).more);
    const version = f.sqlite.query("SELECT revision FROM embedding_versions WHERE project_id='p' AND record_id='a'").get() as { revision: string };
    const begin = (at: number) => journalSourceAttempt(f.db, { projectId: 'p', model: MODEL, id: `vector-${at}`, type: 'spore', recordId: 'a', revision: version.revision, at }, 0);
    const [a, b, c] = [await begin(NOW), await begin(NOW), await begin(NOW)];
    await recordEmbeddingProviderFailure(f.db, MODEL, c.config, new Error('newest attempt failed'), NOW, c.seq);
    await recordEmbeddingProviderFailure(f.db, MODEL, a.config, new Error('oldest attempt failed last'), NOW, a.seq);
    await clearEmbeddingProviderHold(f.db, MODEL, b.seq, b.config);
    expect(await embeddingProviderReady(f.db, MODEL, NOW + 1)).toBe(false);
    const d = await begin(NOW);
    await clearEmbeddingProviderHold(f.db, MODEL, d.seq, d.config);
    expect(await embeddingProviderReady(f.db, MODEL, NOW + 1)).toBe(true);
    await recordEmbeddingProviderFailure(f.db, MODEL, d.config, new Error('failed'), NOW, d.seq + 1);
    f.sqlite.run("UPDATE schema_meta SET value=CAST(value AS INTEGER)+1 WHERE key='embedding_provider_revision'");
    await clearEmbeddingProviderHold(f.db, MODEL, d.seq + 2, d.config);
    expect(await embeddingProviderReady(f.db, MODEL, NOW + 1)).toBe(false);
  });

  it('two failures that read the same prior count both raise the fence before an intermediate success (B23, concurrent)', async () => {
    const f = fixture();
    f.spore('a');
    while ((await prepareEmbeddingDue(f.db, 'p', MODEL)).more);
    const version = f.sqlite.query("SELECT revision FROM embedding_versions WHERE project_id='p' AND record_id='a'").get() as { revision: string };
    const begin = () => journalSourceAttempt(f.db, { projectId: 'p', model: MODEL, id: 'vector', type: 'spore', recordId: 'a', revision: version.revision, at: NOW }, 0);
    const [a, b, c] = [await begin(), await begin(), await begin()];
    const { db: held, reached, release } = pausedAfterFirstBatch(f.db);
    const newest = recordEmbeddingProviderFailure(held, MODEL, c.config, new Error('newest attempt failed'), NOW, c.seq);
    await reached;
    await recordEmbeddingProviderFailure(f.db, MODEL, a.config, new Error('oldest attempt failed'), NOW, a.seq);
    release();
    await newest;
    await clearEmbeddingProviderHold(f.db, MODEL, b.seq, b.config);
    expect(await embeddingProviderReady(f.db, MODEL, NOW + 1)).toBe(false);
  });

  it('a page selected before a second reset never finishes that reset (generation fence)', async () => {
    const f = fixture();
    f.insert('projects', { project_id: 'aaa', name: 'first by key', created_at: 1 });
    for (const project of ['aaa', 'p']) {
      f.insert('plans', { project_id: project, plan_key: 'plan', session_id: 's', event_id: 'e', machine_id: 'm', content: 'body', content_hash: 'h', status: 'active', created_at: 1, updated_at: 1, token_id: 't', received_at: 1 });
      while ((await prepareEmbeddingDue(f.db, project, MODEL)).more);
    }
    f.sqlite.run(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
      SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE type='plan'`, [MODEL]);
    await resetEmbeddingIndex(f.db, 'p');
    const { db: held, reached, release } = pausedAfterFirstBatch(f.db);
    const oldPage = catchUpPhase(held, 'resetReceipts');
    await reached;
    await resetEmbeddingIndex(f.db, 'aaa');
    release();
    await oldPage;
    while ((await catchUpProjections(f.db, { budget: { calls: 200, wallMs: 10_000 } })).more);
    expect(f.sqlite.query('SELECT project_id FROM embedding_receipts ORDER BY project_id').all()).toEqual([]);
    expect(f.sqlite.query("SELECT project_id FROM embedding_due WHERE record_id='plan' ORDER BY project_id").all()).toEqual([{ project_id: 'aaa' }, { project_id: 'p' }]);
    for (const project of ['aaa', 'p']) expect(await modelReadiness(f.db, project, MODEL, NOW)).toMatchObject({ state: 'ready', ready: 0, total: 1, byState: { unwritten: 1 } });
  });

  it('a write that lands after a reset is admitted leaves a deletion claim the reset keeps', async () => {
    const { f, context, entered, release } = overlapping('busy');
    const older = reconcileEmbedding(context, 'p', NOW);
    await entered;
    await resetEmbeddingIndex(f.db, 'p');
    release([1, 0]);
    await older;
    while ((await catchUpProjections(f.db, { budget: { calls: 200, wallMs: 10_000 } })).more);
    expect(f.sqlite.query("SELECT ready FROM embedding_receipts WHERE project_id='p'").all()).toEqual([{ ready: -1 }]);
    expect(await modelReadiness(f.db, 'p', MODEL, NOW)).toMatchObject({ state: 'ready', ready: 0, total: 1, byState: { unavailable: 1 } });
  });
});

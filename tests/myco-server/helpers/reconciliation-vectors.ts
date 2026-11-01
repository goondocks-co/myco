import { planKind } from '@myco-server-worker/ingest/projections.js';
import { kindSpec } from '@myco-server-worker/ingest/kinds.js';
import { connectMachineRoot, disconnectMachineRoot } from '@myco-server-worker/core/machine-settings.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { resolveEmbedding } from '@myco-server-worker/core/embedding/policy.js';
import { recordModelCatalog } from '@myco-server-worker/core/model-catalogs.js';
import { runnerUpdateReportStatements } from '@myco-server-worker/core/runner-updates.js';
import type { RelationalStore, PreparedStatement } from '@myco-server-worker/core/adapters.js';
import type { CaptureEnvelope } from '@myco-server-worker/ingest/envelope.js';
import type { ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import type { RunnerUpdateReport } from '@goondocks/myco-shared/runner-update';

const check = (ok: boolean, message: string): void => { if (!ok) throw new Error(message); };
const equal = (actual: unknown, expected: unknown, message: string): void => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
const rows = async (db: RelationalStore, sql: string) => (await db.prepare(sql).all()).results;
import type { ReconciliationCase } from './reconciliation-cases.js';
export type { ReconciliationCase } from './reconciliation-cases.js';

/** Both contenders observe their snapshot before either can write it. */
function interleavedReads(db: RelationalStore, match: string): RelationalStore {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const originals = new WeakMap<PreparedStatement, PreparedStatement>();
  const observe = (sql: string, statement: PreparedStatement): PreparedStatement => {
    const wrapped: PreparedStatement = ({
    ...statement,
    run: () => statement.run(),
    bind: (...values) => observe(sql, statement.bind(...values)),
    first: async <T,>() => {
      const result = await statement.first<T>();
      if (sql.includes(match) && arrivals < 2) { if (++arrivals === 2) release(); await ready; }
      return result;
    },
    all: async <T,>() => {
      const result = await statement.all<T>();
      if (sql.includes(match) && arrivals < 2) { if (++arrivals === 2) release(); await ready; }
      return result;
    },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  return { prepare: sql => observe(sql, db.prepare(sql)), batch: ss => db.batch(ss.map(s => originals.get(s) ?? s)) };
}

const permutations = <T,>(values: T[]): T[][] => values.length === 0 ? [[]] : values.flatMap((v, i) => permutations(values.filter((_, j) => i !== j)).map(rest => [v, ...rest]));

async function project(db: RelationalStore, kind: 'plan' | 'session.start' | 'session.end', id: string, at: number, payload: Record<string, unknown>): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO events VALUES (?, ?, ?)').bind('p', id, id).run();
  const e: CaptureEnvelope = { eventId: id, sessionId: 's', kind, createdAt: at, channel: 'http', producer: { adapter: 'test', version: '1' }, payload, payloadJson: JSON.stringify(payload), payloadBytes: new TextEncoder().encode(JSON.stringify(payload)) };
  const projection = planKind(kindSpec(kind)!, { db, ctx: { projectId: 'p', machineId: 'm', tokenId: id, now: at, nonce: id, actor: null }, e, p: payload, contentHash: String(payload.content ?? '') });
  await db.batch(projection.projections);
}

const reconciliationRuns: Record<ReconciliationCase, (db: RelationalStore) => Promise<void>> = {
  plan: async (db) => {
    for (const order of permutations([{ id: 'a', at: 100, content: 'A', tag: 'old' }, { id: 'b', at: 150, content: 'B', tag: 'middle' }, { id: 'c', at: 200, content: 'A', tag: 'latest' }])) {
      await db.prepare('DELETE FROM plans').run(); await db.prepare('DELETE FROM tags').run();
      for (const item of order) await project(db, 'plan', item.id, item.at, { planKey: 'k', title: 'title', content: item.content, tags: [item.tag] });
      equal(await rows(db, 'SELECT event_id,content,updated_at,token_id,received_at FROM plans'), [{ event_id: 'c', content: 'A', updated_at: 200, token_id: 'c', received_at: 200 }], 'F2 rank advances on repeated content');
      equal(await rows(db, 'SELECT tag FROM tags'), [{ tag: 'latest' }], 'F2 tags follow accepted rank');
    }
    for (const order of [['z', 'a'], ['a', 'z']]) {
      await db.prepare('DELETE FROM plans').run(); await db.prepare('DELETE FROM tags').run();
      for (const id of order) await project(db, 'plan', id, 100, { planKey: 'k', content: 'A', tags: [id] });
      equal(await rows(db, 'SELECT event_id FROM plans'), [{ event_id: 'a' }], 'F2 equal-time event id');
      equal(await rows(db, 'SELECT tag FROM tags'), [{ tag: 'a' }], 'F2 equal-time tags');
    }
  },
  provenance: async (db) => {
    for (const kind of ['session.start', 'session.end'] as const) {
      for (const order of permutations([{ id: 'b', at: 100 }, { id: 'a', at: 100 }, { id: 'c', at: 200 }])) {
        await db.prepare('DELETE FROM knowledge_git_provenance').run();
        for (const { id, at } of order) await project(db, kind, id, at, { agent: 'claude-code', startedAt: at, endedAt: at, headSha: id.repeat(40), dirty: id === 'a' });
        const expected = kind === 'session.start' ? 'a' : 'c';
        equal(await rows(db, 'SELECT event_id, head_sha,is_dirty FROM knowledge_git_provenance'), [{ event_id: expected, head_sha: expected.repeat(40), is_dirty: expected === 'a' ? 1 : 0 }], 'F8 whole winning provenance');
      }
      await db.prepare('UPDATE knowledge_git_provenance SET event_id = NULL, captured_at = 100').run();
      await project(db, kind, 'b', 100, { agent: 'claude-code', startedAt: 100, endedAt: 100, headSha: 'b'.repeat(40), dirty: false });
      equal(await rows(db, 'SELECT event_id FROM knowledge_git_provenance'), [{ event_id: 'b' }], 'F8 NULL rank loses a tie');
    }
  },
  roots: async (db) => {
    const A = 'a'.repeat(16), B = 'b'.repeat(16), C = 'c'.repeat(16);
    const dbRace = interleavedReads(db, 'SELECT value FROM machine_settings');
    const first = await Promise.all([connectMachineRoot(dbRace, 'machine', A, 'proj_a', 'member', 100), connectMachineRoot(dbRace, 'machine', B, 'proj_b', 'member', 100)]);
    check(first.every(r => r.applied), 'F5 first connects both apply');
    const read = async () => JSON.parse((await db.prepare('SELECT value FROM machine_settings').first<{ value: string }>())!.value);
    equal(await read(), { [A]: 'proj_a', [B]: 'proj_b' }, 'F5 retains both first connections');
    const secondRace = interleavedReads(db, 'SELECT value FROM machine_settings');
    const second = await Promise.all([disconnectMachineRoot(secondRace, 'machine', A, 'member', 90), connectMachineRoot(secondRace, 'machine', C, 'proj_c', 'member', 90)]);
    check(second.every(r => r.applied), 'F5 disconnect and connect apply');
    const current = await read();
    check(current[A] === undefined && current[B] === 'proj_b' && current[C] === 'proj_c', 'F5 removal never resurrects');
  },
  embedding: async (db) => {
    const reset = async () => { await db.prepare('DELETE FROM deployment_settings').run(); await db.prepare("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES ('embedding.provider','\"ollama\"',1,'member')").run(); };
    await reset();
    const writer = settingsWriter(interleavedReads(db, 'SELECT leaf, value,'), { target: 'bun' });
    const result = await Promise.all([writer.setEmbedding({ provider: 'openai' }, 'member', 100), writer.setLeaf('embedding.model', 'nomic-embed-text', 'member', 100)]);
    equal(result.map(r => r.applied), [true, false], 'F9 same-ms same-actor stale edit conflicts');
    check(!result[1]!.applied && result[1]!.refusal.reason === 'conflict', 'F9 named conflict');
    const stored = Object.fromEntries((await db.prepare('SELECT leaf,value FROM deployment_settings').all<{ leaf: string; value: string }>()).results.map(r => [r.leaf, JSON.parse(r.value)]));
    check(resolveEmbedding(stored, 'bun').leaves['embedding.model'].state !== 'invalid', 'F9 valid serialized pair');
    const sequential = settingsWriter(db, { target: 'bun' });
    check((await sequential.setEmbedding({ provider: 'ollama' }, 'member', 99)).applied, 'F9 edit reads UUID revision after rollback');
    check((await sequential.setLeaf('embedding.model', 'nomic-embed-text', 'member', 99)).applied, 'F9 sequential stamped edit');
    await reset();
    check((await sequential.setEmbedding({ provider: 'openai' }, 'member', 1)).applied, 'F9 NULL revision compatibility');
  },
  catalog: async (db) => {
    for (const owner of [{ kind: 'machine', machineId: 'machine' }, { kind: 'runner', runnerId: 'r' }] as const) {
      const table = owner.kind === 'machine' ? 'worker_model_catalogs' : 'runner_model_catalogs';
      const key = owner.kind === 'machine' ? 'machine_id' : 'runner_id';
      const catalog = (order?: number, at = 200): ModelCatalog => ({ harness: 'claude-code', source: { kind: 'command', command: 'list' }, signIn: 'worker-login', fetchedAt: at, models: [{ id: 'alias', label: 'Alias', resolvesTo: order === 2 ? 'new' : 'old' }], ...(order === undefined ? {} : { observedOrder: order }) });
      const send = (order?: number, at?: number) => recordModelCatalog(db, { owner, catalog: catalog(order, at), now: at ?? 1000 });
      await send(2, 100);
      const before = await rows(db, `SELECT * FROM ${table}`);
      await send(1, 200);
      equal(await rows(db, `SELECT * FROM ${table}`), before, 'F10 delayed catalog keeps alias and TTL');
      for (const order of [1, undefined, 2]) check(!(await send(order, 200)).recorded, 'F10 stale, unstamped and retry refuse');
      equal(await rows(db, `SELECT * FROM ${table}`), before, 'F10 refusal does not refresh TTL');
      await db.prepare(`UPDATE ${table} SET observed_order = NULL`).run();
      check((await send(1)).recorded, 'F10 first stamped NULL replacement');
      const refused = await send(1);
      check(refused.observedOrder === 1, 'F10 stored order for resync');
      check((await send(refused.observedOrder! + 1, 50)).recorded, 'F10 resync with rolled-back clock');
      equal(await rows(db, `SELECT observed_order FROM ${table} WHERE ${key} = '${owner.kind === 'machine' ? 'machine' : 'r'}'`), [{ observed_order: 2 }], 'F10 stamp wins');
      await db.prepare(`DELETE FROM ${table}`).run();
      check(!(await send()).recorded, 'F10 unstamped insert refused');
    }
  },
  runner: async (db) => {
    const send = async (observedOrder: number | undefined, version: string, at: number, held = false) => {
      const report: RunnerUpdateReport = { observedOrder, channel: 'alpha', currentVersion: version, latestVersion: '2.0.2', lastCheckAt: at,
        lastResult: { fromVersion: '2.0.0', toVersion: version, result: held ? 'failed' : 'updated', at, attemptId: version },
        ...(held ? { blockedVersion: { version, until: 1000, reason: 'held' }, updateState: { phase: 'cleanup_pending' as const, since: at } } : {}) };
      await db.batch(await runnerUpdateReportStatements(db, 'r', report));
    };
    await send(2, '2.0.1', 100);
    const before = await rows(db, 'SELECT * FROM runner_update_reports');
    await send(1, '2.0.0', 90, true);
    equal(await rows(db, 'SELECT * FROM runner_update_reports'), before, 'F13 delayed report changes nothing');
    await send(3, '2.0.2', 50);
    const row = (await db.prepare('SELECT current_version,last_result,observed_order FROM runner_update_reports').first<{ current_version: string; last_result: string; observed_order: number }>())!;
    check(row.current_version === '2.0.2' && row.observed_order === 3, 'F13 clock rollback accepts causal report');
    const meta = JSON.parse(row.last_result);
    check(meta.lastResult.attemptId === '2.0.2' && meta.blockedVersion === null && meta.updateState === null, 'F13 whole report stays coupled');
    const latest = await rows(db, 'SELECT * FROM runner_update_reports');
    await send(3, '2.0.2', 50); await send(undefined, '2.0.0', 200, true);
    equal(await rows(db, 'SELECT * FROM runner_update_reports'), latest, 'F13 retry and unstamped replacement no-op');
    await db.prepare('UPDATE runner_update_reports SET observed_order = NULL').run();
    await send(1, '2.0.3', 40);
    equal(await rows(db, 'SELECT observed_order FROM runner_update_reports'), [{ observed_order: 1 }], 'F13 NULL bootstrap');
    check((await rows(db, 'SELECT * FROM runner_update_audit')).length >= 4, 'F13 immutable audit independent of metadata rank');
    await db.prepare('DELETE FROM runner_update_reports').run();
    await send(undefined, '2.0.0', 90, true);
    equal(await rows(db, 'SELECT * FROM runner_update_reports'), [], 'F13 unstamped insert refused');
  },
};

export async function runReconciliationCase(db: RelationalStore, name: ReconciliationCase): Promise<void> {
  await reconciliationRuns[name](db);
}

export const RECONCILIATION_FIXTURE = [
  'CREATE TABLE events(project_id TEXT,event_id TEXT,ingest_nonce TEXT,PRIMARY KEY(project_id,event_id))',
  'CREATE TABLE projects(project_id TEXT PRIMARY KEY,name TEXT)',
  "INSERT INTO projects VALUES ('p','p')",
  'CREATE TABLE sessions(project_id TEXT,session_id TEXT,agent TEXT,branch TEXT,origin_path TEXT,parent_session_id TEXT,parent_reason TEXT,launch_parent_session_id TEXT,facts_event_id TEXT,started_at INTEGER,ended_at INTEGER,ended_by TEXT,titling_requested_at INTEGER,PRIMARY KEY(project_id,session_id))',
  "INSERT INTO sessions(project_id,session_id) VALUES ('p','s')",
  'CREATE TABLE prompt_batches(project_id TEXT,session_id TEXT,origin TEXT,created_at INTEGER)',
  'CREATE TABLE session_documents(project_id TEXT,session_id TEXT,generation INTEGER,state TEXT,open_turn_key TEXT,PRIMARY KEY(project_id,session_id))',
  'CREATE TABLE session_prompts(project_id TEXT,session_id TEXT,generation INTEGER,prompt_id TEXT,origin TEXT,created_at INTEGER,PRIMARY KEY(project_id,session_id,generation,prompt_id))',
  'CREATE TABLE knowledge_git_provenance(project_id TEXT,identity_key TEXT,session_id TEXT,capture_point TEXT,captured_at INTEGER,event_id TEXT,branch TEXT,head_sha TEXT,is_dirty INTEGER,error TEXT,status_hash TEXT,created_at INTEGER,PRIMARY KEY(project_id,identity_key))',
  'CREATE TABLE plans(project_id TEXT,plan_key TEXT,session_id TEXT,event_id TEXT,machine_id TEXT,title TEXT,content TEXT,blob_key TEXT,content_hash TEXT,status TEXT,origin_path TEXT,source TEXT,prompt_id TEXT,updated_by TEXT,created_at INTEGER,updated_at INTEGER,token_id TEXT,received_at INTEGER,PRIMARY KEY(project_id,plan_key))',
  'CREATE TABLE tags(project_id TEXT,entity_kind TEXT,entity_id TEXT,tag TEXT,PRIMARY KEY(project_id,entity_kind,entity_id,tag))',
  'CREATE TABLE machine_claims(machine_id TEXT PRIMARY KEY,member_id TEXT)',
  "INSERT INTO machine_claims VALUES ('machine','member')",
  'CREATE TABLE machine_settings(machine_id TEXT,leaf TEXT,value TEXT,updated_at INTEGER,updated_by TEXT,PRIMARY KEY(machine_id,leaf))',
  'CREATE TABLE deployment_settings(leaf TEXT PRIMARY KEY,value TEXT,updated_at INTEGER,updated_by TEXT,write_id TEXT)',
  'CREATE TABLE deployment_setting_resets(leaf TEXT PRIMARY KEY,reset_at INTEGER,reset_by TEXT)',
  'CREATE TABLE embedding_receipts(model_key TEXT,ready INTEGER)',
  'CREATE TABLE embedding_switches(slot TEXT,id TEXT,provider TEXT,model TEXT,endpoint TEXT,model_key TEXT,from_model_key TEXT,estimated_tokens INTEGER,estimated_sources INTEGER,state TEXT,reason TEXT,retry_at INTEGER,failures INTEGER,progressed_at INTEGER,started_at INTEGER,started_by TEXT)',
  ...['worker_model_catalogs', 'runner_model_catalogs'].map((table, i) => `CREATE TABLE ${table}(${i === 0 ? 'machine_id' : 'runner_id'} TEXT,harness TEXT,catalog TEXT,resolutions TEXT,fetched_at INTEGER,received_at INTEGER,observed_order INTEGER,PRIMARY KEY(${i === 0 ? 'machine_id' : 'runner_id'},harness))`),
  'CREATE TABLE runner_update_reports(runner_id TEXT PRIMARY KEY,channel TEXT,current_version TEXT,latest_version TEXT,last_check_at INTEGER,last_result TEXT,observed_order INTEGER)',
  'CREATE TABLE runner_update_requests(runner_id TEXT,id TEXT)',
  'CREATE TABLE runner_update_audit(id TEXT PRIMARY KEY,runner_id TEXT,actor_member TEXT,action TEXT,request_id TEXT,detail TEXT,at INTEGER)',
];

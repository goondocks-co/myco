import { commit } from '@myco-server-worker/db/index.js';
import { ingestEvent, type IngestContext, type IngestResult } from '@myco-server-worker/ingest/events.js';
import { connectedRoot, connectMachineRoot, disconnectMachineRoot } from '@myco-server-worker/core/machine-settings.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { resolveEmbedding } from '@myco-server-worker/core/embedding/policy.js';
import { recordModelCatalog } from '@myco-server-worker/core/model-catalogs.js';
import { runnerUpdateReportStatements } from '@myco-server-worker/core/runner-updates.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import type { RunnerUpdateReport } from '@goondocks/myco-shared/runner-update';
import { issueMemberToken } from './member-token.js';
import { DEPLOYMENT_META_RACES } from './deployment-meta-races.js';
import { bothOrders, check, equal, lockstep, MACHINE, MEMBER, PROJECT, rows, seedDeployment, sweep } from './store-race.js';

/**
 * Concurrent writers to one row, on the current schema, each answered by the ordering its writer declares: capture
 * projections keep the event ranked highest, settings edits made against one revision cannot both apply, and reports
 * keep the one their reporter stamped latest. Each case gets a store holding the current schema and nothing else; the
 * same cases run on native SQLite and on D1 inside workerd.
 */

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1_000_000;

async function capture(db: RelationalStore): Promise<(event: Record<string, unknown>) => (store: RelationalStore) => Promise<IngestResult>> {
  await seedDeployment(db);
  const { tokenId } = await issueMemberToken(db, { memberId: MEMBER, machineId: MACHINE }, NOW);
  const ctx: IngestContext = { projectId: PROJECT, machineId: MACHINE, tokenId, bodyBytes: 10, now: NOW };
  return (event) => (store) => ingestEvent(store, ctx, { channel: 'cli', producer: { adapter: 'claude-code', version: '2.0.0' }, ...event });
}

const stored = (results: IngestResult[], message: string): void =>
  check(results.every((result) => result.persisted && result.projected !== false), `${message}: ${JSON.stringify(results)}`);

const planRaces = async (db: RelationalStore): Promise<void> => {
  const ingest = await capture(db);
  await db.prepare("INSERT INTO embedding_models(project_id,model_key) VALUES (?1,'model')").bind(PROJECT).run();
  const plan = (key: number, id: number, at: number, content: string, tag: string) =>
    ingest({ eventId: uuid(id), sessionId: 'plans', kind: 'plan', createdAt: at, payload: { planKey: uuid(key), title: 'title', content, tags: [tag] } });
  const kept = (key: number) => rows(db, 'SELECT event_id,content,updated_at FROM plans WHERE project_id=?1 AND plan_key=?2', PROJECT, uuid(key));
  const tags = (key: number) => rows(db, "SELECT t.tag FROM tags t JOIN plans p ON t.project_id=p.project_id AND t.entity_kind='plan' AND t.entity_id=p.plan_key WHERE p.plan_key=?1", uuid(key));
  for (const [order, results] of (await bothOrders(db, (o) => plan(10 + o, 100 + o, 100, 'older', 'older'), (o) => plan(10 + o, 200 + o, 200, 'later', 'later'))).entries()) {
    stored(results, 'both racing plan events are stored');
    equal(await kept(10 + order), [{ event_id: uuid(200 + order), content: 'later', updated_at: 200 }], 'the later plan event is the plan, whichever commits first');
    equal(await tags(10 + order), [{ tag: 'later' }], 'the plan carries the tags of the event it kept');
  }
  for (const [order, results] of (await bothOrders(db, (o) => plan(20 + o, 300 + o, 100, 'same', 'second'), (o) => plan(20 + o, 299 - o, 100, 'same', 'first'))).entries()) {
    stored(results, 'both equal-time plan events are stored');
    equal((await kept(20 + order)).map((row) => row.event_id), [uuid(299 - order)], 'of two plan events at one instant the lower event id is the plan');
    equal(await tags(20 + order), [{ tag: 'first' }], 'an equal-time plan carries its own tags');
  }
  const queued = await rows(db, `SELECT v.record_id,v.revision AS source,d.revision AS due FROM embedding_versions v
    LEFT JOIN embedding_due d ON d.project_id=v.project_id AND d.type=v.type AND d.record_id=v.record_id WHERE v.project_id=?1 AND v.type='plan'`, PROJECT);
  check(queued.length > 0 && queued.every((row) => row.due === row.source), `each kept plan is queued for embedding at its kept revision: ${JSON.stringify(queued)}`);
};

const provenanceRaces = async (db: RelationalStore): Promise<void> => {
  const ingest = await capture(db);
  const event = (session: string, kind: 'session.start' | 'session.end', id: number, at: number, head: string) =>
    ingest({ eventId: uuid(id), sessionId: session, kind, createdAt: at,
      payload: kind === 'session.start' ? { agent: 'claude-code', startedAt: at, headSha: head.repeat(40) } : { endedAt: at, headSha: head.repeat(40), dirty: head === 'b' } });
  const provenance = (session: string, point: string) => rows(db, 'SELECT event_id,head_sha,is_dirty FROM knowledge_git_provenance WHERE session_id=?1 AND capture_point=?2', session, point);
  for (const [kind, point, winner, base] of [['session.start', 'session_start', 'a', 10], ['session.end', 'session_end', 'b', 50]] as const) {
    for (const [order, results] of (await bothOrders(db, (o) => event(`${kind}-${o}`, kind, base + o, 100, 'a'), (o) => event(`${kind}-${o}`, kind, base + 20 + o, 200, 'b'))).entries()) {
      stored(results, `both racing ${kind} captures are stored`);
      const id = winner === 'a' ? uuid(base + order) : uuid(base + 20 + order);
      equal(await provenance(`${kind}-${order}`, point), [{ event_id: id, head_sha: winner.repeat(40), is_dirty: kind === 'session.end' ? 1 : 0 }],
        `${kind === 'session.start' ? 'the earliest start' : 'the latest end'} is the session's whole provenance, whichever commits first`);
    }
  }
  for (const [kind, point, base] of [['session.start', 'session_start', 100], ['session.end', 'session_end', 150]] as const) {
    const session = (o: number) => `${kind}-tie-${o}`;
    for (const [order, results] of (await bothOrders(db, (o) => event(session(o), kind, base + 40 + o, 300, 'c'), (o) => event(session(o), kind, base + 39 - o, 300, 'd'))).entries()) {
      stored(results, `both equal-instant ${kind} captures are stored`);
      equal((await provenance(session(order), point)).map((row) => [row.event_id, row.head_sha]), [[uuid(base + 39 - order), 'd'.repeat(40)]],
        `of two ${kind} captures at one instant the lower event id is the whole provenance, whichever commits first`);
    }
  }
  await db.prepare('UPDATE knowledge_git_provenance SET event_id=NULL WHERE session_id=?1').bind('session.end-0').run();
  stored([await event('session.end-0', 'session.end', 90, 200, 'c')(db)], 'an end beside a provenance row written before ranks is stored');
  equal((await provenance('session.end-0', 'session_end')).map((row) => row.event_id), [uuid(90)], 'a row written before ranks loses a tie to a ranked capture');
};

const machineRootRaces = async (db: RelationalStore): Promise<void> => {
  await seedDeployment(db);
  const key = (name: string, run: number) => `${name}${run.toString(16).padStart(15, '0')}`;
  const root = (rootKey: string) => connectedRoot(db, MACHINE, rootKey);
  const connect = (rootKey: string, project: string, at = 100) => (s: RelationalStore) => connectMachineRoot(s, MACHINE, rootKey, project, MEMBER, at);
  const disconnect = (rootKey: string) => (s: RelationalStore) => disconnectMachineRoot(s, MACHINE, rootKey, MEMBER, 90);
  const bothKept = async (results: Array<{ applied: boolean }>, left: string, right: string, at: string) => {
    check(results.every((result) => result.applied), `two racing first connections both apply (${at})`);
    equal([await root(left), await root(right)], ['proj_a', 'proj_b'], `two racing first connections are both kept (${at})`);
  };
  const removedStays = async (results: Array<{ applied: boolean }>, removed: string, added: string, at: string) => {
    check(results.every((result) => result.applied), `a racing disconnect and connect both apply (${at})`);
    equal([await root(removed), await root(added)], [null, 'proj_c'], `a racing connect neither resurrects a disconnected root nor drops another (${at})`);
  };
  await bothKept(await lockstep(db, connect(key('a', 0), 'proj_a'), connect(key('b', 0), 'proj_b')), key('a', 0), key('b', 0), 'alternating');
  await removedStays(await lockstep(db, disconnect(key('a', 0)), connect(key('c', 0), 'proj_c', 90)), key('a', 0), key('c', 0), 'alternating');
  await sweep(db, {
    left: (run) => connect(key('a', run + 1), 'proj_a'),
    right: (run) => connect(key('b', run + 1), 'proj_b'),
    after: (run, results, at) => bothKept(results, key('a', run + 1), key('b', run + 1), at),
  });
  await sweep(db, {
    before: async (run) => { check((await connect(key('d', run), 'proj_d')(db)).applied, 'the root to disconnect is connected'); },
    left: (run) => disconnect(key('d', run)),
    right: (run) => connect(key('e', run), 'proj_c', 90),
    after: (run, results, at) => removedStays(results, key('d', run), key('e', run), at),
  });
};

const embeddingEditRaces = async (db: RelationalStore): Promise<void> => {
  const leaves = async () => Object.fromEntries((await rows<{ leaf: string; value: string }>(db, 'SELECT leaf,value FROM deployment_settings')).map((row) => [row.leaf, JSON.parse(row.value)]));
  const reset = async () => {
    await db.prepare("DELETE FROM deployment_settings WHERE leaf LIKE 'embedding.%'").run();
    check((await settingsWriter(db, { target: 'bun' }).setEmbedding({ provider: 'ollama' }, MEMBER, 50)).applied, 'the embedding choice starts on ollama');
  };
  const provider = (s: RelationalStore) => settingsWriter(s, { target: 'bun' }).setEmbedding({ provider: 'openai' }, MEMBER, 100);
  const model = (s: RelationalStore) => settingsWriter(s, { target: 'bun' }).setLeaf('embedding.model', 'nomic-embed-text', MEMBER, 100);
  const valid = async (at: string) =>
    check(resolveEmbedding(await leaves(), 'bun').leaves['embedding.model'].state !== 'invalid', `racing embedding edits never store an invalid provider and model pair (${at})`);
  for (const order of [0, 1]) {
    await reset();
    const results = order === 0 ? await lockstep(db, provider, model) : await lockstep(db, model, provider);
    equal(results.filter((result) => result.applied).length, 1, `of two embedding edits that both read one revision, exactly one applies (order ${order})`);
    for (const result of results) if (!result.applied) equal(result.refusal.reason, 'conflict', 'the other is refused as a named conflict');
    await valid(`alternating, order ${order}`);
  }
  await sweep(db, {
    before: reset,
    left: () => provider,
    right: () => model,
    after: async (_, results, at) => {
      check(results.some((result) => result.applied), `one of two racing embedding edits applies (${at})`);
      await valid(at);
    },
  });
  await reset();
  const sequential = settingsWriter(db, { target: 'bun' });
  check((await sequential.setEmbedding({ provider: 'openai' }, MEMBER, 1)).applied, 'an edit after the last one reads its revision and applies despite an earlier clock');
};

const catalogReportRaces = async (db: RelationalStore): Promise<void> => {
  await seedDeployment(db);
  await db.prepare("INSERT INTO runners(id,name,created_at) VALUES ('rn_1','runner',0)").run();
  for (const owner of [{ kind: 'machine', machineId: MACHINE }, { kind: 'runner', runnerId: 'rn_1' }] as const) {
    const [table, key, id] = owner.kind === 'machine' ? ['worker_model_catalogs', 'machine_id', MACHINE] : ['runner_model_catalogs', 'runner_id', 'rn_1'];
    const catalog = (harness: string, order: number | undefined, at: number): ModelCatalog => ({ harness, source: { kind: 'command', command: 'list' }, signIn: 'worker-login',
      fetchedAt: at, models: [{ id: 'alias', label: 'Alias', resolvesTo: `model-${order}` }], ...(order === undefined ? {} : { observedOrder: order }) });
    const send = (harness: string, order: number | undefined, at: number) => (s: RelationalStore) => recordModelCatalog(s, { owner, catalog: catalog(harness, order, at), now: at });
    const held = (harness: string) => rows(db, `SELECT * FROM ${table} WHERE ${key}=?1 AND harness=?2`, id, harness);
    for (const [order, results] of (await bothOrders(db, (o) => send(`race-${o}`, 2, 100), (o) => send(`race-${o}`, 1, 200))).entries()) {
      check(results[0].recorded && (order === 1 || !results[1].recorded), `the report stamped later is recorded, and the earlier one refused when it arrives second (${owner.kind})`);
      equal((await held(`race-${order}`)).map((row) => [row.observed_order, JSON.parse(String(row.resolutions))]), [[2, { alias: 'model-2' }]],
        `the catalog stamped later is kept whole, whichever commits first (${owner.kind})`);
    }
    const before = await held('race-0');
    for (const order of [1, undefined, 2]) check(!(await send('race-0', order, 300)(db)).recorded, `a stale, unstamped or repeated report is refused (${owner.kind})`);
    equal(await held('race-0'), before, `a refused report does not refresh the kept catalog (${owner.kind})`);
    await db.prepare(`UPDATE ${table} SET observed_order=NULL WHERE ${key}=?1`).bind(id).run();
    check((await send('race-0', 1, 50)(db)).recorded, `a stamped report replaces one stored before stamps (${owner.kind})`);
    const refused = await send('race-0', 1, 50)(db);
    check(!refused.recorded && refused.observedOrder === 1, `a refused report answers the stored order to resync from (${owner.kind})`);
    check((await send('race-0', refused.observedOrder! + 1, 10)(db)).recorded, `a resynced report is recorded despite a rolled-back clock (${owner.kind})`);
    check(!(await send('fresh', undefined, 10)(db)).recorded, `an unstamped first report is refused (${owner.kind})`);
  }
};

const runnerUpdateReportRaces = async (db: RelationalStore): Promise<void> => {
  await seedDeployment(db);
  const report = (order: number | undefined, version: string, at: number, held = false): RunnerUpdateReport => ({
    observedOrder: order, channel: 'alpha', currentVersion: version, latestVersion: '2.0.2', lastCheckAt: at,
    lastResult: { fromVersion: '2.0.0', toVersion: version, result: held ? 'failed' : 'updated', at, attemptId: version },
    ...(held ? { blockedVersion: { version, until: 1000, reason: 'held' }, updateState: { phase: 'cleanup_pending' as const, since: at } } : {}),
  });
  const send = (runner: string, value: RunnerUpdateReport) => async (s: RelationalStore) => { await commit(s, ...await runnerUpdateReportStatements(runner, value)); };
  const kept = (runner: string) => rows<{ current_version: string; observed_order: number; last_result: string }>(db,
    'SELECT current_version,observed_order,last_result FROM runner_update_reports WHERE runner_id=?1', runner);
  const audited = async (runner: string) => (await rows<{ detail: string }>(db, "SELECT detail FROM runner_update_audit WHERE runner_id=?1 AND action='reported'", runner))
    .map((row) => JSON.parse(row.detail)?.toVersion ?? JSON.parse(row.detail)?.lastResult?.toVersion).sort();
  for (const order of [0, 1]) await db.prepare("INSERT INTO runners(id,name,created_at) VALUES (?1,'runner',0)").bind(`rn_${order}`).run();
  for (const [order] of (await bothOrders(db, (o) => send(`rn_${o}`, report(2, '2.0.1', 100)), (o) => send(`rn_${o}`, report(1, '2.0.0', 200, true)))).entries()) {
    const [row] = await kept(`rn_${order}`);
    check(row?.current_version === '2.0.1' && row.observed_order === 2, `the report stamped later is kept, whichever commits first: ${JSON.stringify(row)}`);
    const metadata = JSON.parse(row!.last_result);
    check(metadata.lastResult.attemptId === '2.0.1' && metadata.blockedVersion === null && metadata.updateState === null, 'the kept report stays whole, with none of the refused one');
    equal(await audited(`rn_${order}`), ['2.0.0', '2.0.1'], 'both racing reports stay in the audit');
  }
  const latest = await kept('rn_0');
  await send('rn_0', report(2, '2.0.1', 100))(db);
  await send('rn_0', report(undefined, '2.0.0', 300, true))(db);
  equal(await kept('rn_0'), latest, 'a repeated or unstamped report changes nothing');
  await send('rn_0', report(3, '2.0.2', 50))(db);
  equal((await kept('rn_0')).map((row) => row.current_version), ['2.0.2'], 'a later stamp is kept despite a rolled-back clock');
  await db.prepare('UPDATE runner_update_reports SET observed_order=NULL').run();
  await send('rn_0', report(1, '2.0.3', 40))(db);
  equal((await kept('rn_0')).map((row) => row.observed_order), [1], 'a stamped report replaces one stored before stamps');
  await db.prepare("INSERT INTO runners(id,name,created_at) VALUES ('rn_fresh','runner',0)").run();
  await send('rn_fresh', report(undefined, '2.0.0', 90, true))(db);
  equal(await kept('rn_fresh'), [], 'an unstamped first report is refused');
};

const CASES: Record<string, (db: RelationalStore) => Promise<void>> = {
  'racing plan events keep the event ranked latest, with its tags and its embedding revision': planRaces,
  'racing session captures keep the earliest start and the latest end as whole provenance': provenanceRaces,
  'racing repository connections on one machine keep every connection and never resurrect a removed one': machineRootRaces,
  'racing embedding edits against one revision never both apply': embeddingEditRaces,
  'racing model catalog reports keep the one stamped later, whole': catalogReportRaces,
  'racing runner update reports keep the one stamped later and audit both': runnerUpdateReportRaces,
  ...DEPLOYMENT_META_RACES,
};

/** Every race case, by the behaviour it asserts. */
export const RECONCILIATION_CASES = Object.keys(CASES);

export async function runReconciliationCase(db: RelationalStore, name: string): Promise<void> {
  const run = CASES[name];
  if (run === undefined) throw new Error(`no race case named ${name}`);
  await run(db);
}

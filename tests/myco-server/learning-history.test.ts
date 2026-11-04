import { expect, it } from 'bun:test';
import type { RelationalStore, PreparedStatement } from '@myco-server-worker/core/adapters.js';
import { settingsWriter, learningHistoryEnabled } from '@myco-server-worker/core/settings.js';
import { effectiveSettings } from '@myco-server-worker/core/settings-policies.js';
import { completeBudgetMigration } from '@myco-server-worker/db/budget-activation.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { claimNextRun } from '@myco-server-worker/core/harness.js';
import { buildCardInput, LEARNING_STAGES } from '@myco-server-worker/core/learning-stages.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { withDocumentStores } from './helpers/document-stores.js';
import { beforeWriteBatch } from './helpers/prepared.js';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { envelope, memoryBlobStore, recordingLimiter, uuid } from './helpers/fixtures.js';
import { writeRunCards, NONE_CARD } from '@myco-server-worker/core/turn-cards.js';
import { type CardAssignment } from '@myco-server-worker/core/learning-stages.js';
import { JOB_IMPLEMENTATIONS } from '@myco-server-worker/core/jobs-run.js';
import { LEARNING_SOURCE_REPAIR_PAGE, readLearningStatus, learningStatusLine, completeLearning, type LearningAssignment } from '@myco-server-worker/core/learning-sessions.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { switchedOnStages } from '@myco-server-worker/core/pulled-stages.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OLD = NOW - 30 * DAY;
const HISTORY = 'agent.learning_history_enabled';
const IDLE_CLAIM_ROW_LIMIT = 1000;
const HISTORY_STATUS_ROW_LIMIT = 100;
const DUE_CLAIM_ROW_LIMIT = 4000;

async function workerHarness(db: RelationalStore) {
  const blobs = memoryBlobStore();
  const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() } as never);
  await settingsWriter(db).setLeaf('agent.scheduled_tasks_enabled', true, 'owner', NOW);
  await settingsWriter(db).setLeaf('agent.harnesses.claude-code.credential', 'worker-login', 'owner', NOW);
  await db.prepare(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)`).run();
  await completeBudgetMigration(db, NOW);
  await ensureMember(db, 'worker', NOW, 'admin');
  const token = await issueMemberToken(db, { memberId: 'worker', machineId: 'machine' }, NOW);
  const principal = legacyWorker(token.tokenId, 'machine');
  const poll = (now = NOW) => claimNextRun(env, { principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now });
  return { env, blobs, poll, token };
}

async function sourceSession(db: RelationalStore, session: string, activity: number) {
  await db.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,last_record_at,updated_at)
    VALUES('project',?,'live',1,?,?)`).bind(session, activity, NOW).run();
}

async function capture(db: RelationalStore, tokenId: string, sessionId: string, events: readonly Record<string, unknown>[]) {
  const last = events.at(-1)!;
  for (const event of [...events, { kind: 'session.end', createdAt: last.createdAt, payload: { endedAt: last.createdAt } }]) expect(await ingestEvent(db,
    { projectId: 'project', machineId: 'machine', tokenId, bodyBytes: 1, now: NOW },
    envelope({ eventId: crypto.randomUUID(), sessionId, ...event }))).toMatchObject({ persisted: true });
}

const publish = (db: RelationalStore, blobs: ReturnType<typeof memoryBlobStore>, now: number) =>
  publishDocuments({ db, blobs }, now, { calls: 500, deadline: Date.now() + 30_000, clock: Date.now });

function countReads(db: RelationalStore) {
  let rows = 0;
  const queries: { sql: string; rows: number }[] = [];
  const originals = new WeakMap<PreparedStatement, PreparedStatement>();
  const record = (value: unknown) => { rows += (value as { meta?: { rows_read?: number } }).meta?.rows_read ?? 0; };
  const wrap = (raw: PreparedStatement, sql: string): PreparedStatement => {
    const all = async <T,>() => { const result = await raw.all<T>(); const count = (result as { meta?: { rows_read?: number } }).meta?.rows_read ?? 0; if (count > 0) queries.push({ sql, rows: count }); record(result); return result; };
    const statement: PreparedStatement = {
      bind: (...values) => wrap(raw.bind(...values), sql),
      all,
      first: async <T,>() => (await all<T>()).results[0] ?? null,
      run: async () => { const result = await raw.run(); record(result); return result; },
    };
    originals.set(statement, raw);
    return statement;
  };
  return { rows: () => rows, queries, db: {
    prepare: (sql: string) => wrap(db.prepare(sql), sql),
    batch: async (statements: PreparedStatement[]) => {
      const result = await db.batch(statements.map(statement => originals.get(statement)!));
      result.forEach(record);
      return result;
    },
  } };
}

it('cards a resumed session in full and admits its learning with history off', async () => {
  await withDocumentStores(async db => {
    const { blobs, poll, token } = await workerHarness(db);
    await capture(db, token.tokenId, 'resumed', [
      { kind: 'session.start', createdAt: OLD, payload: { agent: 'claude-code', startedAt: OLD } },
      { kind: 'prompt', createdAt: OLD, payload: { promptId: uuid(31), text: 'Fix the old queue', origin: 'user' } },
    ]);
    await publish(db, blobs, OLD + HOUR);
    expect(await poll()).toMatchObject({ claimed: false });
    await capture(db, token.tokenId, 'resumed', [
      { kind: 'prompt', createdAt: NOW - HOUR, payload: { promptId: uuid(32), text: 'Resume the queue fix', origin: 'user' } },
    ]);
    await publish(db, blobs, NOW);
    expect(await learningHistoryEnabled(db)).toBe(false);
    const cards = await poll();
    if (!cards.claimed) throw new Error('resumed session was not claimed');
    expect(cards.run.task).toBe('turn-cards');
    const saved = await db.prepare('SELECT run_context AS context FROM agent_runs WHERE id=?').bind(cards.run.id).first<{ context: string }>();
    const { assignment } = JSON.parse(saved!.context) as { assignment: CardAssignment };
    expect(assignment.turns.map(turn => turn.turnKey)).toEqual([uuid(31), uuid(32)]);
    expect(await writeRunCards({ db }, 'project', 'resumed', assignment.turns,
      assignment.turns.map(turn => ({ turns: [turn.turnKey], signal: 'high', card: NONE_CARD('fixture') })),
      { runId: cards.run.id, model: 'fake' }, NOW + 1)).toEqual({ written: 2, changed: [] });
    await db.prepare("UPDATE agent_runs SET status='completed',completed_at=? WHERE id=?").bind(NOW + 1, cards.run.id).run();
    expect(await db.prepare("SELECT pending_cards,due_cards,eligible_at IS NOT NULL AS eligible FROM learning_sessions WHERE session_id='resumed'").first())
      .toEqual({ pending_cards: 0, due_cards: 2, eligible: 1 });
    const learning = await poll(NOW + 2);
    expect(learning).toMatchObject({ claimed: true, run: { task: 'extract-curate' } });
    if (!learning.claimed) throw new Error('resumed session learning was not claimed');
    const slice = await db.prepare('SELECT run_context AS context FROM agent_runs WHERE id=?').bind(learning.run.id).first<{ context: string }>();
    const learningAssignment = (JSON.parse(slice!.context) as { assignment: LearningAssignment }).assignment;
    await recordServedPrompts(db, { projectId: 'project' }, learning.run.id, [
      { promptId: uuid(31), sessionId: 'resumed', createdAt: OLD, endedAt: null },
      { promptId: uuid(32), sessionId: 'resumed', createdAt: NOW - HOUR, endedAt: null },
    ], NOW + 3);
    expect(await completeLearning(db, 'project', 'resumed', learning.run.id, learningAssignment, '', NOW + 4))
      .toEqual({ completed: true, covered: 2 });
    expect(await db.prepare("SELECT pending_cards,due_cards,eligible_at FROM learning_sessions WHERE session_id='resumed'").first())
      .toEqual({ pending_cards: 0, due_cards: 0, eligible_at: null });
  });
});

it('skips a history backlog before probing it and reports why history waits', async () => {
  await withDocumentStores(async (db, target) => {
    const { env, poll } = await workerHarness(db);
    expect((await switchedOnStages(db, LEARNING_STAGES)).map(stage => stage.level)).toEqual([0.5, 1]);
    const add = async (from: number, to: number) => {
      const ids = JSON.stringify(Array.from({ length: to - from }, (_, n) => from + n));
      await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,pending_cards)
        SELECT 'project','history-' || value,'ready',?,1 FROM json_each(?)`).bind(OLD, ids).run();
      await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,source_activity_at,due_at,input_chars)
        SELECT 'project','history-' || value,'old-' || value,?,?,?,10 FROM json_each(?)`).bind(OLD, OLD, NOW, ids).run();
    };
    const empty = countReads(db);
    env.db = empty.db;
    expect(await poll()).toMatchObject({ claimed: false });
    await add(0, 2000);
    const first = countReads(db);
    env.db = first.db;
    expect(await poll()).toMatchObject({ claimed: false });
    expect(first.rows(), JSON.stringify(first.queries)).toBeLessThan(IDLE_CLAIM_ROW_LIMIT);
    expect(first.rows()).toBe(empty.rows());
    await add(2000, 4000);
    const second = countReads(db);
    env.db = second.db;
    expect(await poll()).toMatchObject({ claimed: false });
    expect(second.rows()).toBe(first.rows());
    if (target === 'D1') expect(first.rows()).toBeGreaterThan(0);
    env.db = db;
    const status = await readLearningStatus(db, NOW);
    expect(status).toMatchObject({ historyWaiting: status.cap + 1, turnsAwaitingCards: 0, dueSessions: 0, dueCards: 0 });
    expect(learningStatusLine(status, null, NOW)).toContain('at least 1000 history sessions waiting behind the history switch');
  });
});

it('repairs late old-Worker insert shapes in bounded wake pages and admits the repaired work', async () => {
  await withDocumentStores(async db => {
    const total = LEARNING_SOURCE_REPAIR_PAGE * 2 + 1;
    const rows = JSON.stringify(Array.from({ length: total }, (_, n) => ({ id: `late-${n}`, at: OLD + n })));
    await db.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,last_record_at,updated_at)
      SELECT 'project',json_extract(value,'$.id'),'live',1,json_extract(value,'$.at'),? FROM json_each(?)`).bind(NOW, rows).run();
    await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,pending_cards)
      SELECT 'project',json_extract(value,'$.id'),'ready',1 FROM json_each(?)`).bind(rows).run();
    await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,due_at,card,covered)
      SELECT 'project',json_extract(value,'$.id'),json_extract(value,'$.id'),json_extract(value,'$.at'),?,'kept card',1 FROM json_each(?)`).bind(NOW, rows).run();
    for (const step of SCHEMA_STEPS.filter(step => step.version > 610)) await db.batch(step.statements.map(sql => db.prepare(sql)));
    const { env, poll } = await workerHarness(db);
    await settingsWriter(db).setLeaf(HISTORY, true, 'owner', NOW);
    expect(await poll()).toMatchObject({ claimed: false });
    const repair = () => JOB_IMPLEMENTATIONS['learning-source-repair']!(env, NOW, 'active');
    expect(await repair()).toEqual({ changed: 2 * LEARNING_SOURCE_REPAIR_PAGE, more: true });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM turn_cards WHERE source_activity_at IS NULL').first()).toEqual({ n: total - LEARNING_SOURCE_REPAIR_PAGE });
    expect(await repair()).toEqual({ changed: 2 * LEARNING_SOURCE_REPAIR_PAGE, more: true });
    expect(await repair()).toEqual({ changed: 2, more: false });
    expect(await repair()).toEqual({ changed: 0, more: false });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM turn_cards WHERE card='kept card' AND covered=1 AND due_at=? AND source_activity_at=created_at").bind(NOW).first())
      .toEqual({ n: total });
    expect(await poll()).toMatchObject({ claimed: true, run: { task: 'turn-cards' } });
  }, 610);
});

it('keeps idle claims and history status bounded across finished history and fresh idle sessions', async () => {
  await withDocumentStores(async (db, target) => {
    const { env, poll } = await workerHarness(db);
    await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,due_cards,eligible_at)
      VALUES('other','due-later','ready',?,1,?)`).bind(OLD - DAY, NOW + HOUR).run();
    await settingsWriter(db).setLeaf(HISTORY, true, 'owner', NOW);
    const idle = async () => {
      const counted = countReads(db);
      env.db = counted.db;
      expect(await poll()).toMatchObject({ claimed: false });
      env.db = db;
      expect(counted.rows(), JSON.stringify(counted.queries)).toBeLessThan(IDLE_CLAIM_ROW_LIMIT);
      return counted.rows();
    };
    const status = async () => {
      await settingsWriter(db).setLeaf(HISTORY, false, 'owner', NOW);
      const counted = countReads(db);
      expect(await readLearningStatus(counted.db, NOW)).toMatchObject({ historyWaiting: 1, turnsAwaitingCards: 0, dueCards: 0, dueSessions: 0 });
      expect(counted.rows(), JSON.stringify(counted.queries)).toBeLessThan(HISTORY_STATUS_ROW_LIMIT);
      await settingsWriter(db).setLeaf(HISTORY, true, 'owner', NOW);
      return counted.rows();
    };
    const add = async (kind: string, from: number, to: number, activity: number) => {
      const ids = JSON.stringify(Array.from({ length: to - from }, (_, n) => from + n));
      for (const project of ['project', 'other']) await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at)
        SELECT ?,? || value,'ready',? FROM json_each(?)`).bind(project, kind, activity, ids).run();
    };
    const emptyIdle = await idle();
    const emptyStatus = await status();
    await add('finished-', 0, 2000, OLD);
    await add('idle-', 0, 100, NOW - HOUR);
    expect(await idle()).toBe(emptyIdle);
    expect(await status()).toBe(emptyStatus);
    await add('finished-', 2000, 4000, OLD);
    await add('idle-', 100, 1000, NOW - HOUR);
    expect(await idle()).toBe(emptyIdle);
    expect(await status()).toBe(emptyStatus);
    if (target === 'D1') {
      expect(emptyIdle).toBeGreaterThan(0);
      expect(emptyStatus).toBeGreaterThan(0);
    }
    await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,pending_cards)
      VALUES('project','oldest-due','ready',?,1)`).bind(OLD - 2 * DAY).run();
    await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,source_activity_at,due_at)
      VALUES('project','oldest-due','oldest',?,?,?)`).bind(OLD - 2 * DAY, OLD - 2 * DAY, NOW).run();
    const counted = countReads(db);
    env.db = counted.db;
    const claimed = await poll();
    expect(claimed).toMatchObject({ claimed: true, run: { task: 'turn-cards' } });
    expect(counted.rows(), JSON.stringify(counted.queries)).toBeLessThan(DUE_CLAIM_ROW_LIMIT);
    if (!claimed.claimed) throw new Error('the oldest due history session was not claimed');
    expect(await db.prepare('SELECT subject FROM agent_runs WHERE id=?').bind(claimed.run.id).first()).toEqual({ subject: 'cards:oldest-due' });
  });
});

it('advances repair past unstampable rows without chaining empty pages', async () => {
  await withDocumentStores(async db => {
    const { env } = await workerHarness(db);
    const unstampable = LEARNING_SOURCE_REPAIR_PAGE + 1;
    const ids = JSON.stringify([...Array.from({ length: unstampable }, (_, n) => `orphan-${n}`), 'stampable']);
    await sourceSession(db, 'stampable', OLD);
    await db.prepare("INSERT INTO session_documents(project_id,session_id,state,generation,updated_at) VALUES('project','orphan-0','live',1,?)").bind(NOW).run();
    await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,pending_cards)
      SELECT 'project',value,'ready',1 FROM json_each(?)`).bind(ids).run();
    await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,due_at)
      SELECT 'project',value,value,?,? FROM json_each(?)`).bind(OLD - DAY, NOW, ids).run();
    const repair = () => JOB_IMPLEMENTATIONS['learning-source-repair']!(env, NOW, 'active');
    expect(await repair()).toEqual({ changed: 0, more: false });
    expect(await repair()).toEqual({ changed: 2, more: false });
    expect(await db.prepare("SELECT source_activity_at,due_at FROM turn_cards WHERE session_id='stampable'").first())
      .toEqual({ source_activity_at: OLD, due_at: NOW });
    expect(await db.prepare("SELECT source_activity_at FROM learning_sessions WHERE session_id='stampable'").first())
      .toEqual({ source_activity_at: OLD });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM turn_cards WHERE source_activity_at IS NULL').first()).toEqual({ n: unstampable });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM learning_sessions WHERE source_activity_at IS NULL').first()).toEqual({ n: unstampable });
    expect(await repair()).toEqual({ changed: 0, more: false });
  });
});

it('refuses the history card claim write after the switch is disabled', async () => {
  await withDocumentStores(async db => {
    const { env, poll } = await workerHarness(db);
    await sourceSession(db, 'history', OLD);
    await db.prepare("INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,pending_cards) VALUES('project','history','ready',?,1)").bind(OLD).run();
    await db.prepare("INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,source_activity_at,due_at) VALUES('project','history','old',?,?,?)").bind(OLD, OLD, NOW).run();
    await settingsWriter(db).setLeaf(HISTORY, true, 'owner', NOW);
    env.db = beforeWriteBatch(db, sql => sql.includes('INSERT INTO agent_runs (project_id, id, agent_id, task, status, origin, subject'),
      async () => { await settingsWriter(db).setLeaf(HISTORY, false, 'owner', NOW + 1); }, true);
    expect(await poll()).toMatchObject({ claimed: false });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM agent_runs').first()).toEqual({ n: 0 });
  });
});

it('raises the source activity when a previously historical turn changes', async () => {
  await withDocumentStores(async db => {
    const { blobs, poll, token } = await workerHarness(db);
    await capture(db, token.tokenId, 'changed', [
      { kind: 'session.start', createdAt: OLD, payload: { agent: 'claude-code', startedAt: OLD } },
      { kind: 'prompt', createdAt: OLD, payload: { promptId: uuid(41), text: 'Fix the old queue', origin: 'user' } },
    ]);
    await publish(db, blobs, OLD + HOUR);
    expect(await db.prepare("SELECT source_activity_at FROM turn_cards WHERE session_id='changed'").first()).toEqual({ source_activity_at: OLD });
    await capture(db, token.tokenId, 'changed', [
      { kind: 'response', createdAt: NOW - HOUR, payload: { responseId: uuid(42), promptId: uuid(41), text: 'The old turn now has a fix.' } },
    ]);
    await publish(db, blobs, NOW);
    expect(await db.prepare("SELECT source_activity_at FROM turn_cards WHERE session_id='changed'").first()).toEqual({ source_activity_at: NOW - HOUR });
    expect(await poll()).toMatchObject({ claimed: true, run: { task: 'turn-cards' } });
  });
});

it('settles a new turn on the first wake and claims it once quiet ahead of 500 old turns', async () => {
  await withDocumentStores(async db => {
    const { blobs, poll, token } = await workerHarness(db);
    const rows = JSON.stringify(Array.from({ length: 500 }, (_, n) => ({ key: `old-${n}`, at: OLD + n })));
    await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,source_activity_at,settle_at)
      SELECT 'project','history',json_extract(value,'$.key'),json_extract(value,'$.at'),json_extract(value,'$.at'),json_extract(value,'$.at')
      FROM json_each(?)`).bind(rows).run();
    for (const event of [
      { kind: 'session.start', createdAt: OLD, payload: { agent: 'claude-code', startedAt: OLD } },
      { kind: 'prompt', createdAt: OLD, payload: { promptId: uuid(1), text: 'Fix the queue priority', origin: 'user' } },
      { kind: 'response', createdAt: NOW - HOUR + 1, payload: { responseId: uuid(2), promptId: uuid(1), text: 'Use source activity for recency.' } },
    ]) {
      expect(await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token.tokenId, bodyBytes: 1, now: NOW },
        envelope({ eventId: crypto.randomUUID(), sessionId: 'new', ...event }))).toMatchObject({ persisted: true });
    }
    await publishDocuments({ db, blobs }, NOW, { calls: 500, deadline: Date.now() + 30_000, clock: Date.now });
    expect(await db.prepare(`SELECT due_at,source_activity_at FROM turn_cards WHERE session_id='new'`).first())
      .toEqual({ due_at: NOW, source_activity_at: NOW - HOUR + 1 });
    expect(await db.prepare(`SELECT source_activity_at FROM learning_sessions WHERE session_id='new'`).first())
      .toEqual({ source_activity_at: NOW - HOUR + 1 });
    const claimed = await poll(NOW + 2 * HOUR);
    expect(claimed).toMatchObject({ claimed: true, run: { task: 'turn-cards' } });
    if (!claimed.claimed) throw new Error('claim refused');
    expect(await db.prepare('SELECT subject FROM agent_runs WHERE id=?').bind(claimed.run.id).first())
      .toEqual({ subject: 'cards:new' });
  });
});

it('reclassifies pending, carded and retried backlog without altering cards, coverage or deadlines', async () => {
  await withDocumentStores(async db => {
    await sourceSession(db, 'older', OLD);
    await sourceSession(db, 'newer', OLD + DAY);
    for (const [session, key, state, due, covered] of [
      ['older', 'pending', 'pending', NOW, 0],
      ['newer', 'retried', 'pending', NOW + HOUR, 0],
      ['older', 'carded', 'carded', null, 0],
      ['newer', 'learned', 'carded', null, 1],
    ] as const) {
      await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,state,due_at,created_at,card,fields,input_hash,covered,records,run_id,model)
        VALUES('project',?,?,?,?,?,'exact card','{}','hash',?,'[]','prior-run','prior-model')`)
        .bind(session, key, state, due, OLD, covered).run();
    }
    for (const session of ['older', 'newer']) await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,eligible_at,failures,handoff,pending_cards)
      VALUES('project',?,'ready',?,3,'kept handoff',1)`).bind(session, NOW + HOUR).run();
    const snapshot = async () => (await db.prepare(`SELECT session_id,turn_key,state,due_at,settle_at,created_at,card,fields,input_hash,covered,records,run_id,model
      FROM turn_cards ORDER BY session_id,turn_key`).all()).results;
    const before = await snapshot();
    for (const step of SCHEMA_STEPS.filter(step => step.version > 545)) await db.batch(step.statements.map(sql => db.prepare(sql)));
    expect(await snapshot()).toEqual(before);
    expect((await db.prepare(`SELECT DISTINCT session_id,source_activity_at FROM turn_cards ORDER BY session_id`).all()).results)
      .toEqual([{ session_id: 'newer', source_activity_at: OLD + DAY }, { session_id: 'older', source_activity_at: OLD }]);
    expect((await db.prepare(`SELECT source_activity_at,eligible_at,failures,handoff FROM learning_sessions ORDER BY session_id`).all()).results)
      .toEqual([OLD + DAY, OLD].map(source_activity_at => ({ source_activity_at, eligible_at: NOW + HOUR, failures: 3, handoff: 'kept handoff' })));
    const { env, poll } = await workerHarness(db);
    expect(await learningHistoryEnabled(db)).toBe(false);
    expect((await effectiveSettings(env)).get(HISTORY)).toMatchObject({ effective: false, source: 'default' });
    expect(await poll()).toMatchObject({ claimed: false });
    expect(await poll(NOW + 2 * HOUR)).toMatchObject({ claimed: false });
    expect(await settingsWriter(db).setLeaf(HISTORY, true, 'owner', NOW)).toEqual({ applied: true });
    const claimed = await poll(NOW + 2 * HOUR);
    expect(claimed).toMatchObject({ claimed: true, run: { task: 'turn-cards' } });
    if (!claimed.claimed) throw new Error('claim refused');
    expect(await db.prepare('SELECT subject FROM agent_runs WHERE id=?').bind(claimed.run.id).first())
      .toEqual({ subject: 'cards:newer' });
    await db.prepare(`UPDATE agent_runs SET status='failed',completed_at=? WHERE id=?`).bind(NOW + 2 * HOUR + 1, claimed.run.id).run();
    await settingsWriter(db).setLeaf(HISTORY, false, 'owner', NOW + 2 * HOUR + 1);
    expect(await poll(NOW + 4 * HOUR)).toMatchObject({ claimed: false });
    expect(await buildCardInput({ db }, 'project', 'newer', NOW + 4 * HOUR)).toBeNull();
    expect(await db.prepare(`SELECT source_activity_at FROM turn_cards WHERE turn_key='retried'`).first())
      .toEqual({ source_activity_at: OLD + DAY });
  }, 545);
});

it('learns the newest history session first and keeps retried learning behind the switch', async () => {
  await withDocumentStores(async db => {
    const { env, poll } = await workerHarness(db);
    for (const [session, activity, eligible] of [['older', OLD, NOW], ['newer', OLD + DAY, OLD + DAY]] as const) {
      await sourceSession(db, session, activity);
      await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,eligible_at,due_cards)
        VALUES('project',?,'ready',?,?,1)`).bind(session, activity, eligible).run();
      await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,state,created_at,source_activity_at,input_hash,card,signal,covered)
        VALUES('project',?,?,'carded',?,?,'hash','exact card','high',0)`).bind(session, session, activity, activity).run();
    }
    expect(await poll()).toMatchObject({ claimed: false });
    await settingsWriter(db).setLeaf(HISTORY, true, 'owner', NOW);
    const selected = (await LEARNING_STAGES[3]!.head(db, 'project', NOW))!;
    expect(selected.key).toBe('newer');
    env.db = beforeWriteBatch(db, sql => sql.includes('INSERT INTO agent_runs (project_id, id, agent_id, task, status, origin, subject'),
      async () => { await settingsWriter(db).setLeaf(HISTORY, false, 'owner', NOW + 1); }, true);
    expect(await poll()).toMatchObject({ claimed: false });
    env.db = db;
    await settingsWriter(db).setLeaf(HISTORY, true, 'owner', NOW + 2);
    const claimed = await poll(NOW + 2);
    expect(claimed).toMatchObject({ claimed: true, run: { task: 'extract-curate' } });
    if (!claimed.claimed) throw new Error('claim refused');
    expect(await db.prepare('SELECT subject FROM agent_runs WHERE id=?').bind(claimed.run.id).first())
      .toEqual({ subject: 'session:newer' });
    await db.prepare(`UPDATE agent_runs SET status='failed',completed_at=? WHERE id=?`).bind(NOW + 3, claimed.run.id).run();
    expect(await db.prepare(`SELECT failures,eligible_at > ? AS later,source_activity_at FROM learning_sessions WHERE session_id='newer'`)
      .bind(NOW).first()).toEqual({ failures: 1, later: 1, source_activity_at: OLD + DAY });
    await settingsWriter(db).setLeaf(HISTORY, false, 'owner', NOW + 4);
    expect(await poll(NOW + 2 * HOUR)).toMatchObject({ claimed: false });
    const guard = LEARNING_STAGES[3]!.stillHead(selected, NOW + 2 * HOUR);
    expect(await db.prepare(`SELECT ${guard.sql} AS permitted`).bind(...guard.params).first()).toEqual({ permitted: 0 });
    expect(await settingsWriter(db).setLeaf(HISTORY, 'true', 'owner', NOW + 4)).toMatchObject({ applied: false });
    await settingsWriter(db).resetLeaf(HISTORY, 'owner', NOW + 5);
    expect(await learningHistoryEnabled(db)).toBe(false);
  });
});

import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { settingsWriter, learningHistoryEnabled } from '@myco-server-worker/core/settings.js';
import { effectiveSettings } from '@myco-server-worker/core/settings-policies.js';
import { LEARNING_SOURCE_STEPS } from '@myco-server-worker/db/schema-v546.js';
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

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OLD = NOW - 30 * DAY;
const HISTORY = 'agent.learning_history_enabled';

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

it('settles and claims a new turn on the first wake ahead of 500 old turns', async () => {
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
    const claimed = await poll();
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
    for (const session of ['older', 'newer']) await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,eligible_at,failures,handoff)
      VALUES('project',?,'ready',?,3,'kept handoff')`).bind(session, NOW + HOUR).run();
    const snapshot = async () => (await db.prepare(`SELECT session_id,turn_key,state,due_at,settle_at,created_at,card,fields,input_hash,covered,records,run_id,model
      FROM turn_cards ORDER BY session_id,turn_key`).all()).results;
    const before = await snapshot();
    for (const step of LEARNING_SOURCE_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
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

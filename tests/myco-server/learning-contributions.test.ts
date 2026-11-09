import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { commit } from '@myco-server-worker/db/index.js';
import { sessionProgressStatement } from '@myco-server-worker/db/learning/progress.js';
import { advanceLearningDeadlines, LEARNING_ADVANCE_PAGE, learningHeadSession, stageHead } from '@myco-server-worker/db/learning/ready.js';
import { acceptQuietPolicy, readQuietPolicy } from '@myco-server-worker/db/learning/quiet-policy.js';
import { catchUpPhase, catchUpProjections, projectionReadiness } from '@myco-server-worker/db/projections/catchup.js';
import { readLearningStatus } from '@myco-server-worker/core/learning-sessions.js';
import { selectPulled } from '@myco-server-worker/core/pulled-stages.js';
import { LEARNING_STAGES } from '@myco-server-worker/core/learning-stages.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { beforeWriteBatch } from './helpers/prepared.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Card = { key: string; state?: 'pending' | 'carded'; covered?: 0 | 1; signal?: string | null; due?: number | null; carded?: number };

async function sessionRow(db: RelationalStore, session: string, activity: number | null = NOW - HOUR, extra = '') {
  await db.prepare(`INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at) VALUES('project',?,'ready',?)`).bind(session, activity).run();
  if (extra !== '') await db.prepare(`UPDATE learning_sessions SET ${extra} WHERE session_id=?`).bind(session).run();
}

function addCard(db: RelationalStore, session: string, card: Card) {
  return db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,state,covered,signal,due_at,carded_at,created_at,source_activity_at)
    VALUES('project',?,?,?,?,?,?,?,1,?)`).bind(session, card.key, card.state ?? 'pending', card.covered ?? 0, card.signal ?? null, card.due ?? null, card.carded ?? null, NOW).run();
}

const counts = (db: RelationalStore, session: string) => db.prepare(
  'SELECT pending_cards,due_cards,signal_cards,last_carded_at,counted FROM learning_sessions WHERE session_id=?').bind(session).first();
const rollup = (db: RelationalStore) => db.prepare(
  "SELECT pending_cards,due_cards,signal_cards,fresh_pending,fresh_due,ready_sessions,fresh_ready_sessions,history_waiting FROM learning_project_counts WHERE project_id='project'").first();

it('moves each session\'s card counts old to new through insert, carding, coverage, reset and delete, and the Project rollup follows', async () => {
  await withDocumentStores(async db => {
    await sessionRow(db, 'a');
    await addCard(db, 'a', { key: 't1' });
    await addCard(db, 'a', { key: 't2' });
    expect(await counts(db, 'a')).toMatchObject({ pending_cards: 2, due_cards: 0, signal_cards: 0, counted: 1 });
    expect(await rollup(db)).toMatchObject({ pending_cards: 2, due_cards: 0 });

    await db.prepare("UPDATE turn_cards SET state='carded',signal='high',carded_at=? WHERE session_id='a' AND turn_key='t1'").bind(NOW + 1).run();
    expect(await counts(db, 'a')).toMatchObject({ pending_cards: 1, due_cards: 1, signal_cards: 1, last_carded_at: NOW + 1 });

    await db.prepare("UPDATE turn_cards SET covered=1 WHERE session_id='a' AND turn_key='t1'").run();
    expect(await counts(db, 'a')).toMatchObject({ due_cards: 0, signal_cards: 1 });

    await db.prepare("UPDATE turn_cards SET state='pending',covered=0,signal=NULL WHERE session_id='a' AND turn_key='t1'").run();
    await db.prepare("DELETE FROM turn_cards WHERE session_id='a' AND turn_key='t2'").run();
    expect(await counts(db, 'a')).toMatchObject({ pending_cards: 1, due_cards: 0, signal_cards: 0 });
    expect(await rollup(db)).toMatchObject({ pending_cards: 1, due_cards: 0, signal_cards: 0 });

    await db.prepare("DELETE FROM learning_sessions WHERE session_id='a'").run();
    await db.prepare("DELETE FROM turn_cards WHERE session_id='a'").run();
    expect(await rollup(db)).toMatchObject({ pending_cards: 0, due_cards: 0, signal_cards: 0 });
  });
});

it('counts a session row that arrives after its cards, as a restore delivers them', async () => {
  await withDocumentStores(async db => {
    await addCard(db, 'late', { key: 'c1', state: 'carded', signal: 'low', carded: NOW });
    await addCard(db, 'late', { key: 'c2' });
    await sessionRow(db, 'late');
    expect(await counts(db, 'late')).toMatchObject({ pending_cards: 1, due_cards: 1, signal_cards: 1, last_carded_at: NOW, counted: 1 });
    expect(await rollup(db)).toMatchObject({ pending_cards: 1, due_cards: 1, signal_cards: 1 });
  });
});

it('catches existing sessions up in keyed pages and reports building meanwhile, never a false zero', async () => {
  await withDocumentStores(async db => {
    const sessions = Array.from({ length: 60 }, (_, i) => `old-${String(i).padStart(2, '0')}`);
    for (const session of sessions) {
      await sessionRow(db, session);
      await addCard(db, session, { key: 'k', state: 'carded', signal: 'high', carded: NOW });
    }
    // Sessions from before the projection: their rows are uncounted and the phase has work.
    await db.prepare('UPDATE learning_sessions SET counted=0,due_cards=99').run();
    await db.prepare("DELETE FROM learning_project_counts WHERE project_id='project'").run();
    await db.prepare("UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL WHERE projection='learning_counts'").run();

    const during = await readLearningStatus(db, NOW);
    expect(during.state).toBe('building');
    expect(await projectionReadiness(db, 'learning_counts')).toBe('building');

    // A card written while the backlog is being counted is seen once: the live trigger moved its session, and the walk
    // recomputes it absolutely when it arrives.
    await addCard(db, 'old-30', { key: 'live', state: 'carded', signal: 'none', carded: NOW + 5 });

    for (let page = 0; page < 8; page += 1) await catchUpProjections(db, { budget: { calls: 120, wallMs: 60_000 } });
    expect(await projectionReadiness(db, 'learning_counts')).toBe('ready');
    expect(await counts(db, 'old-30')).toMatchObject({ pending_cards: 0, due_cards: 2, signal_cards: 1, counted: 1 });
    expect(await rollup(db)).toMatchObject({ due_cards: sessions.length + 1, signal_cards: sessions.length, pending_cards: 0 });
    while ((await advanceLearningDeadlines(db, NOW, { page: LEARNING_ADVANCE_PAGE, age: true })).more);
    expect(await readLearningStatus(db, NOW)).toMatchObject({ state: 'ready', dueCards: sessions.length + 1 });
  });
});

it('promotes a session at its deadline, drops it when the deadline moves, and offers only ready Projects', async () => {
  await withDocumentStores(async db => {
    await db.prepare("INSERT OR REPLACE INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')").run();
    await sessionRow(db, 'waits');
    await addCard(db, 'waits', { key: 'w', due: NOW + HOUR });
    await sessionRow(db, 'ready');
    await addCard(db, 'ready', { key: 'r', due: NOW });
    const head = () => stageHead(db, 'cardsFresh', 'project', NOW + 1);

    expect(await head()).toBeNull();
    await advanceLearningDeadlines(db, NOW + 1, { page: LEARNING_ADVANCE_PAGE, age: true });
    expect(await head()).toMatchObject({ sessionId: 'ready' });
    expect((await db.prepare("SELECT ready FROM learning_ready_projects WHERE stage='cardsFresh' AND project_id='project'").first())).toEqual({ ready: 1 });

    await db.prepare("UPDATE turn_cards SET due_at=? WHERE session_id='ready'").bind(NOW + 2 * HOUR).run();
    expect(await head()).toBeNull();
    expect((await db.prepare("SELECT ready FROM learning_ready_projects WHERE stage='cardsFresh' AND project_id='project'").first())).toEqual({ ready: 0 });
    await advanceLearningDeadlines(db, NOW + 3 * HOUR, { page: LEARNING_ADVANCE_PAGE, age: true });
    expect(await stageHead(db, 'cardsFresh', 'project', NOW + 3 * HOUR)).toMatchObject({ sessionId: 'ready' });
  });
});

it('ages a session out of the fresh stage after its source window and keeps a retry-admitted one fresh', async () => {
  await withDocumentStores(async db => {
    await db.prepare("INSERT OR REPLACE INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')").run();
    await settingsWriter(db).setLeaf('agent.learning_history_enabled', true, 'owner', NOW);
    await sessionRow(db, 'old', NOW - 2 * DAY);
    await addCard(db, 'old', { key: 'o', due: NOW });
    await sessionRow(db, 'retry', NOW - 2 * DAY, 'fresh_admitted=1,card_failures=1');
    await addCard(db, 'retry', { key: 'r', due: NOW });
    await advanceLearningDeadlines(db, NOW + 1, { page: LEARNING_ADVANCE_PAGE, age: true });
    expect(await stageHead(db, 'cardsHistory', 'project', NOW + 1)).toMatchObject({ sessionId: 'old' });
    expect(await stageHead(db, 'cardsFresh', 'project', NOW + 1)).toMatchObject({ sessionId: 'retry' });
    await db.prepare("UPDATE learning_sessions SET source_activity_at=? WHERE session_id='old'").bind(NOW).run();
    await advanceLearningDeadlines(db, NOW + 1, { page: LEARNING_ADVANCE_PAGE, age: true });
    expect((await db.prepare("SELECT card_stage,aged FROM learning_sessions WHERE session_id='old'").first())).toEqual({ card_stage: 'cardsFresh', aged: 0 });
  });
});

it('accepts an idle-close policy generation, refuses an older one, rebuilds in keyed pages and activates when complete', async () => {
  await withDocumentStores(async db => {
    await db.prepare("INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES('project','held','t',1,?)").bind(NOW).run();
    await sessionRow(db, 'held');
    expect(await readQuietPolicy(db)).toBeNull();
    expect(await acceptQuietPolicy(db, { generation: 2, minutes: 30, now: NOW })).toBe('recorded');
    expect(await acceptQuietPolicy(db, { generation: 1, minutes: 5, now: NOW })).toBe('stale');
    expect(await acceptQuietPolicy(db, { generation: 2, minutes: 30, now: NOW })).toBe('current');
    expect(await readQuietPolicy(db)).toEqual({ generation: 2, pendingMinutes: 30, effectiveMinutes: null, state: 'building' });

    await catchUpProjections(db, { budget: { calls: 120, wallMs: 60_000 } });
    expect(await readQuietPolicy(db)).toEqual({ generation: 2, pendingMinutes: null, effectiveMinutes: 30, state: 'active' });
    expect(await db.prepare("SELECT quiet_at,quiet_generation FROM learning_sessions WHERE session_id='held'").first())
      .toEqual({ quiet_at: NOW + 30 * 60_000, quiet_generation: 2 });
    expect(await acceptQuietPolicy(db, { generation: 3, minutes: 90, now: NOW })).toBe('recorded');
    expect(await readQuietPolicy(db)).toMatchObject({ generation: 3, pendingMinutes: 90, effectiveMinutes: 30, state: 'building' });
  });
});

it('writes only what a due or coverage change moves: an unchanged earliest due touches no learning row', async () => {
  await withDocumentStores(async (db, target) => {
    await sessionRow(db, 'a');
    await addCard(db, 'a', { key: 'early', due: NOW });
    await addCard(db, 'a', { key: 'late', due: NOW + HOUR });
    await addCard(db, 'a', { key: 'done', state: 'carded', signal: 'high', carded: NOW });
    const mark = async () => (await db.prepare("SELECT revision FROM change_marks WHERE kind='learning'").first<{ revision: number }>())!.revision;
    const before = await db.prepare("SELECT pending_cards,due_cards,signal_cards,next_model_due_at FROM learning_sessions WHERE session_id='a'").first();
    const held = await mark();
    const later = await db.prepare("UPDATE turn_cards SET due_at=? WHERE project_id='project' AND session_id='a' AND turn_key='late'").bind(NOW + 2 * HOUR).run();
    expect(await db.prepare("SELECT pending_cards,due_cards,signal_cards,next_model_due_at FROM learning_sessions WHERE session_id='a'").first()).toEqual(before);
    expect(await mark()).toBe(held);
    // The card row and its one model-due index entry, read and rewritten; no session, rollup or mark row.
    if (target === 'D1') expect(Number((later.meta as { rows_written?: number }).rows_written)).toBeLessThanOrEqual(3);

    await db.prepare("UPDATE turn_cards SET covered=1 WHERE project_id='project' AND session_id='a' AND turn_key='done'").run();
    expect(await counts(db, 'a')).toMatchObject({ pending_cards: 2, due_cards: 0, signal_cards: 1, last_carded_at: NOW });
    expect(await mark()).toBe(held + 1);

    await db.prepare("UPDATE turn_cards SET due_at=? WHERE project_id='project' AND session_id='a' AND turn_key='early'").bind(NOW + 3 * HOUR).run();
    expect(await db.prepare("SELECT next_model_due_at FROM learning_sessions WHERE session_id='a'").first()).toEqual({ next_model_due_at: NOW + 2 * HOUR });
  });
});

it('records no completion for a session whose only carded card was reset and then forgotten', async () => {
  await withDocumentStores(async db => {
    await sessionRow(db, 'gone', NOW - HOUR, 'max_seq=7,learned_seq=3');
    await addCard(db, 'gone', { key: 'only', state: 'carded', covered: 1, signal: 'low', carded: NOW });
    await db.prepare("UPDATE turn_cards SET state='pending',covered=0 WHERE session_id='gone'").run();
    await db.prepare("DELETE FROM turn_cards WHERE session_id='gone'").run();
    await commit(db, sessionProgressStatement('project', 'gone', NOW + 1));
    expect(await db.prepare("SELECT learned_seq,last_completed_at,last_completed_reason FROM learning_sessions WHERE session_id='gone'").first())
      .toEqual({ learned_seq: 3, last_completed_at: null, last_completed_reason: null });
  });
});

it('finds a hand start its due session during a promotion backlog in another Project', async () => {
  await withDocumentStores(async db => {
    await sessionRow(db, 'mine', NOW - HOUR, `eligible_at=${NOW - 10},due_cards=1`);
    for (let i = 0; i < 5; i += 1) {
      await db.prepare("INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,eligible_at,due_cards) VALUES('other',?,'ready',?,?,1)").bind(`busy-${i}`, NOW - HOUR, NOW - 1).run();
    }
    await advanceLearningDeadlines(db, NOW);
    expect(await stageHead(db, 'learningFresh', 'project', NOW)).toBeNull();
    expect(await learningHeadSession(db, 'project', NOW, true)).toBe('mine');
  });
});

it('does not activate a newer idle-close generation from a stale final page', async () => {
  await withDocumentStores(async db => {
    await db.prepare("INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES('project','held','t',1,?)").bind(NOW).run();
    await sessionRow(db, 'held');
    expect(await acceptQuietPolicy(db, { generation: 1, minutes: 600, now: NOW })).toBe('recorded');
    const raced = beforeWriteBatch(db, sql => sql.includes("SET state='active'"), async () => {
      expect(await acceptQuietPolicy(db, { generation: 2, minutes: 30, now: NOW })).toBe('recorded');
    }, true);
    await catchUpPhase(raced, 'learningQuietPolicy', NOW);
    expect(await readQuietPolicy(db)).toEqual({ generation: 2, pendingMinutes: 30, effectiveMinutes: null, state: 'building' });

    await catchUpPhase(db, 'learningQuietPolicy', NOW);
    expect(await readQuietPolicy(db)).toEqual({ generation: 2, pendingMinutes: null, effectiveMinutes: 30, state: 'active' });
    expect(await db.prepare("SELECT quiet_at,quiet_generation FROM learning_sessions WHERE session_id='held'").first())
      .toEqual({ quiet_at: NOW + 30 * 60_000, quiet_generation: 2 });
  });
});

it('reads one session\'s card settle, one runnable selection and one status at the same cost whatever the cards behind them', async () => {
  await withDocumentStores(async (db, target) => {
    if (target !== 'D1') return;
    await db.prepare("INSERT OR REPLACE INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')").run();
    const measured: Record<string, number>[] = [];
    let added = 0;
    for (const scale of [100, 1000]) {
      for (let session = added; session < scale; session += 1) await seedSession(db, `s${session}`);
      added = scale;
      await seedSession(db, `run${scale}`);
      await advanceLearningDeadlines(db, NOW + 1, { page: LEARNING_ADVANCE_PAGE, age: true });
      for (let pass = 0; pass < scale / LEARNING_ADVANCE_PAGE + 2; pass += 1) await advanceLearningDeadlines(db, NOW + 1, { page: LEARNING_ADVANCE_PAGE, age: true });
      measured.push(await costs(db, `run${scale}`));
    }
    expect(measured[1]).toEqual(measured[0]);
  });
}, 120_000);

async function seedSession(db: RelationalStore, session: string) {
  await sessionRow(db, session);
  await addCard(db, session, { key: 'k', due: NOW });
}

async function rowsRead(db: RelationalStore, run: (counted: RelationalStore) => Promise<unknown>): Promise<number> {
  let rows = 0;
  const meta = (value: unknown) => { rows += Number((value as { meta?: { rows_read?: number } } | undefined)?.meta?.rows_read ?? 0); };
  const originals = new WeakMap<object, ReturnType<RelationalStore['prepare']>>();
  const wrap = (statement: ReturnType<RelationalStore['prepare']>): ReturnType<RelationalStore['prepare']> => {
    const wrapped = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values as never[])),
      all: async () => { const result = await statement.all(); meta(result); return result; },
      first: async () => { const result = await statement.all(); meta(result); return (result as { results: unknown[] }).results[0] ?? null; },
      run: async () => { const result = await statement.run(); meta(result); return result; },
    } as ReturnType<RelationalStore['prepare']>;
    originals.set(wrapped, statement);
    return wrapped;
  };
  const counted = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: async (statements: ReturnType<RelationalStore['prepare']>[]) => { const results = await db.batch(statements.map(s => originals.get(s)!)); results.forEach(meta); return results; },
  } as RelationalStore;
  await run(counted);
  return rows;
}

async function costs(db: RelationalStore, session: string): Promise<Record<string, number>> {
  const select = await rowsRead(db, counted => selectPulled(counted, LEARNING_STAGES.slice(0, 2), LEARNING_STAGES.slice(0, 2), {} as never, NOW + 1));
  const settle = await rowsRead(db, counted => commit(counted, sessionProgressStatement('project', session, NOW + 2)));
  const status = await rowsRead(db, counted => readLearningStatus(counted, NOW + 2));
  return { select, settle, status };
}

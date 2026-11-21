import { holdSentence } from '@goondocks/myco-shared/run-holds';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { runStaleSweep, QUEUE_MAX_AGE_MS } from '@myco-server-worker/core/jobs-run.js';
import { LEARNING_WINDOW_MS } from '@myco-server-worker/db/runs/learning-policy.js';
import { advanceLearningDeadlines, LEARNING_ADVANCE_PAGE } from '@myco-server-worker/db/learning/ready.js';
import { dispatchTask } from '@myco-server-worker/core/harness.js';
import { learningStatusLine } from '@myco-server-worker/core/learning-sessions.js';
import { expect, it } from 'bun:test';
import { commit } from '@myco-server-worker/db/index.js';
import { forgetTurnStatement } from '@myco-server-worker/db/learning/cards.js';
import { sessionProgressStatement } from '@myco-server-worker/db/learning/progress.js';
import { cardWriteStatement, type CardMaterial } from '@myco-server-worker/core/turn-cards.js';
import { readLearningStatus } from '@myco-server-worker/core/learning-sessions.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { changingAtStatement } from './helpers/store-faults.js';
import { uuid } from './helpers/fixtures.js';
import { endLeasedRun } from '@myco-server-worker/core/harness.js';
import { CARD_REPORT_ACTION, EXTRACTION_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { NOW, HOUR, DAY, capture, publish, cardAll, GOTCHAS, EMPTY_CARD, cardWorker, cardRun, plainTurns } from './helpers/learning-stages.ts';

it('admits long-idle sessions just before the learning window ends', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    await settingsWriter(db).setLeaf('agent.titling_idle_close_minutes', 1440, 'owner', NOW);
    const receipt = NOW;
    await capture(db, 'quiet-clamp', [{ id: uuid(995), text: 'Admit the quiet deadline within the source window', at: NOW }], 'project', receipt);
    await publish(db, receipt + HOUR / 4, harness.bindings.BUCKET);
    const deadline = NOW + 23 * HOUR;
    expect(await db.prepare("SELECT quiet_at,source_activity_at FROM learning_sessions WHERE session_id='quiet-clamp'").first())
      .toEqual({ quiet_at: deadline, source_activity_at: NOW });
    expect(await harness.poll(deadline - 1)).toMatchObject({ claimed: false });
    const claimed = await harness.poll(deadline + HOUR / 2);
    if (!claimed.claimed) throw new Error('clamped quiet deadline missed source freshness');
    expect(await harness.call(claimed.run.runToken, 'myco_run_cards', { op: 'material' })).toMatchObject({ session_id: 'quiet-clamp' });
  });
});

for (const mode of ['not-live', 'recovered-before-write', 'changed-after-read']) it(`keeps pending turns when the document is not live at material read or at the forget write (mode: ${mode})`, async () => {
  await withDocumentStores(async db => {
    const changesAfterRead = mode === 'changed-after-read';
    const keys = [uuid(1001), uuid(1002)];
    const run = await cardRun(db, keys.map((id, n) => ({ id, text: 'Keep this pending turn until its document is live', at: NOW - DAY + 10 + n })));
    if (changesAfterRead) {
      const missing = uuid(1003);
      await db.prepare("INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,due_at) VALUES('project','long',?,10,?)").bind(missing, NOW).run();
      await db.prepare("UPDATE agent_runs SET run_context=json_set(run_context,'$.assignment.turns',json(?)) WHERE id=?")
        .bind(JSON.stringify([{ turnKey: missing, changes: 0 }]), run.claimed.run.id).run();
      keys.push(missing);
    }
    const before = (await db.prepare("SELECT turn_key,state,changes FROM turn_cards ORDER BY turn_key").all()).results;
    if (!changesAfterRead) await db.prepare("UPDATE session_documents SET state='convert' WHERE session_id='long'").run();
    const material = await run.material();
    expect(material.turns).toEqual([]);
    if (changesAfterRead) await db.prepare("UPDATE session_documents SET state='convert' WHERE session_id='long'").run();
    if (mode === 'recovered-before-write') await db.prepare("UPDATE session_documents SET state='live' WHERE session_id='long'").run();
    const answer = await run.harness.request(run.claimed.run.runToken, 'myco_run_cards', { op: 'write', revision: material.revision, cards: [] });
    if (mode === 'recovered-before-write') {
      expect(await answer.json()).toMatchObject({ result: { structuredContent: { result: { written: 0, changed_since_served: [] } } } });
    } else expect(await answer.json()).toMatchObject({ result: { isError: true, structuredContent: { result: { code: 'tool_call_failed' } } } });
    expect((await db.prepare("SELECT turn_key,state,changes FROM turn_cards ORDER BY turn_key").all()).results).toEqual(before);
    await run.harness.call(run.claimed.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'document not live', audit: RUN_AUDIT });
    expect(await endLeasedRun(run.env, { principal: run.principal, now: NOW + DAY + 1 }, {
      projectId: 'project', runId: run.claimed.run.id, attemptId: run.claimed.run.attemptId, status: 'completed',
    })).toEqual({ ended: true, status: 'failed' });
    expect(await db.prepare("SELECT pending_cards,card_failures,card_retry_at FROM learning_sessions WHERE session_id='long'").first())
      .toEqual({ pending_cards: keys.length, card_failures: 1, card_retry_at: NOW + DAY + 1 + HOUR });
    await db.prepare("UPDATE session_documents SET state='live' WHERE session_id='long'").run();
    const retry = await run.harness.poll(NOW + DAY + 1 + HOUR);
    if (!retry.claimed) throw new Error('document recovery did not retry card work');
    const recovered = await run.harness.call(retry.run.runToken, 'myco_run_cards', { op: 'material' });
    expect((recovered.turns as CardMaterial[]).map(turn => turn.turn_key)).toEqual(keys.slice(0, 2));
  });
}, 60_000);

it('retains the shared idle wait for a late-received session inside the learning window', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    const source = NOW - 3 * DAY;
    await capture(db, 'past-fresh', [{ id: uuid(1010), text: 'Wait for this historical session to become quiet', at: source }], 'project', NOW);
    await publish(db, NOW + HOUR / 4, harness.bindings.BUCKET);
    expect(await db.prepare("SELECT quiet_at FROM learning_sessions WHERE session_id='past-fresh'").first()).toEqual({ quiet_at: NOW + 2 * HOUR });
    expect(await harness.poll(NOW + HOUR)).toMatchObject({ claimed: false });
    const claim = await harness.poll(NOW + 2 * HOUR);
    if (!claim.claimed) throw new Error('quiet historical session not claimed');
    expect(await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'material' })).toMatchObject({ session_id: 'past-fresh' });
    await db.prepare("UPDATE sessions SET ended_at=? WHERE session_id='past-fresh'").bind(NOW + HOUR).run();
    expect(await db.prepare("SELECT quiet_at FROM learning_sessions WHERE session_id='past-fresh'").first()).toEqual({ quiet_at: 0 });
  });
});

for (const atBatch of [false, true]) it(`refuses card writes retryably if the document leaves live after reading, including at the mutation boundary (atBatch: ${atBatch})`, async () => {
  await withDocumentStores(async db => {
    const turns = plainTurns(2, 1100);
    const run = await cardRun(db, turns);
    const material = await run.readAll();
    const pending = (await db.prepare("SELECT turn_key,state,input_hash,card FROM turn_cards ORDER BY turn_key").all()).results;
    const convert = async () => { await db.prepare("UPDATE session_documents SET state='convert' WHERE session_id='long'").run(); };
    const atWrite = changingAtStatement(db, 'learningCards.write', convert);
    if (atBatch) run.bindings.MYCO_DB = atWrite.store;
    else await convert();
    const response = await run.harness.request(run.claimed.run.runToken, 'myco_run_cards', { op: 'write', revision: material.revision,
      cards: turns.map(turn => ({ turns: [turn.id], signal: 'high', card: EMPTY_CARD })) });
    expect(await response.json()).toMatchObject({ result: { isError: true, structuredContent: { result: { code: 'tool_call_failed' } } } });
    expect(atWrite.landed()).toBe(atBatch);
    const held = await db.prepare("SELECT changes FROM turn_cards WHERE session_id='long' AND turn_key=?").bind(turns[0]!.id).first<{ changes: number }>();
    await commit(db, cardWriteStatement('project', 'long', { turnKey: turns[0]!.id, changes: held!.changes }, {
      value: EMPTY_CARD, signal: 'high', reason: 'model', sharedWith: null, covered: null, runId: run.claimed.run.id, model: 'fake',
    }, NOW + DAY), sessionProgressStatement('project', 'long', NOW + DAY));
    expect((await db.prepare("SELECT turn_key,state,input_hash,card FROM turn_cards ORDER BY turn_key").all()).results).toEqual(pending);
    expect(await db.prepare("SELECT pending_cards,due_cards FROM learning_sessions WHERE session_id='long'").first())
      .toEqual({ pending_cards: 2, due_cards: 0 });
    run.bindings.MYCO_DB = db;
    await db.prepare("UPDATE session_documents SET state='live' WHERE session_id='long'").run();
    await commit(db, forgetTurnStatement('project', 'long', { turnKey: turns[0]!.id, changes: held!.changes }));
    expect((await db.prepare("SELECT turn_key,state,input_hash,card FROM turn_cards ORDER BY turn_key").all()).results).toEqual(pending);
    const reread = await run.readAll();
    expect(await run.harness.call(run.claimed.run.runToken, 'myco_run_cards', { op: 'write', revision: reread.revision,
      cards: turns.map(turn => ({ turns: [turn.id], signal: 'high', card: EMPTY_CARD })) })).toEqual({ written: 2, changed_since_served: [] });
    expect((await db.prepare("SELECT state,input_hash IS NOT NULL AS hashed FROM turn_cards ORDER BY turn_key").all()).results)
      .toEqual([{ state: 'carded', hashed: 1 }, { state: 'carded', hashed: 1 }]);
    await run.harness.call(run.claimed.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'carded after recovery', audit: RUN_AUDIT });
    expect(await endLeasedRun(run.env, { principal: run.principal, now: NOW + DAY + 1 }, {
      projectId: 'project', runId: run.claimed.run.id, attemptId: run.claimed.run.attemptId, status: 'completed',
    })).toEqual({ ended: true, status: 'completed' });
  });
});

it('retains learning claim deadlines when hash mismatches cover zero, rather than reclaiming every poll', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    for (const [index, timing] of ['before-material', 'before-complete', 'at-batch', 'no-due'].entries()) {
      const session = `empty-learning-${timing}`;
      const turn = uuid(1110 + index);
      await capture(db, session, [{ id: turn, text: 'Keep the backoff when this card no longer matches', at: NOW }], 'project', NOW);
      await db.prepare("UPDATE sessions SET ended_at=? WHERE session_id=?").bind(NOW, session).run();
      await publish(db, NOW + HOUR / 4, harness.bindings.BUCKET);
      await cardAll(db, harness.bindings.BUCKET, session, NOW + HOUR / 4);
      await db.prepare("UPDATE learning_sessions SET handoff='retained handoff' WHERE session_id=?").bind(session).run();
      let at = NOW + HOUR;
      for (let attempt = 0; attempt < 3; attempt++) {
        const claim = await harness.poll(at);
        if (!claim.claimed) throw new Error('learning retry was not claimed at its deadline');
        expect(claim.run.task).toBe('extract-curate');
        const held = await db.prepare("SELECT eligible_at,failures FROM learning_sessions WHERE session_id=?").bind(session).first<{ eligible_at: number; failures: number }>();
        const mismatch = async () => { await db.prepare("UPDATE turn_cards SET input_hash=NULL WHERE session_id=?").bind(session).run(); };
        if (timing === 'before-material') await mismatch();
        await harness.call(claim.run.runToken, 'myco_run_learning', { op: 'material' });
        if (timing === 'before-complete' || timing === 'no-due') await mismatch();
        if (timing === 'no-due') await db.prepare("UPDATE learning_sessions SET due_cards=0 WHERE session_id=?").bind(session).run();
        const atCompletion = changingAtStatement(db, 'runs.learningCompleted', mismatch);
        if (timing === 'at-batch') harness.bindings.MYCO_DB = atCompletion.store;
        expect(await harness.call(claim.run.runToken, 'myco_run_learning', { op: 'complete', handoff: 'discard empty handoff' }))
          .toEqual({ completed: true, covered: 0 });
        expect(atCompletion.landed()).toBe(timing === 'at-batch');
        harness.bindings.MYCO_DB = db;
        expect(await db.prepare("SELECT eligible_at,failures,handoff FROM learning_sessions WHERE session_id=?").bind(session).first())
          .toEqual({ ...held!, handoff: 'retained handoff' });
        await harness.call(claim.run.runToken, 'myco_run', { op: 'report', action: EXTRACTION_REPORT_ACTION, summary: 'no matching cards', audit: RUN_AUDIT });
        expect(await endLeasedRun(harness.env, { principal: harness.principal, now: at + 1 }, {
          projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId, status: attempt === 1 ? 'failed' : 'completed',
        })).toEqual({ ended: true, status: attempt === 1 ? 'failed' : 'completed' });
        for (const now of [at + 2, at + 2000, held!.eligible_at - 1]) expect(await harness.poll(now)).toMatchObject({ claimed: false });
        const hash = await db.prepare("SELECT input_hash AS hash FROM session_prompts WHERE session_id=? AND prompt_id=?").bind(session, turn).first<{ hash: string }>();
        await db.prepare("UPDATE turn_cards SET input_hash=? WHERE session_id=?").bind(hash!.hash, session).run();
        await db.prepare("UPDATE learning_sessions SET due_cards=1 WHERE session_id=?").bind(session).run();
        at = held!.eligible_at;
      }
    }
  });
});

for (const task of ['turn-cards', 'extract-curate'] as const) it(`does not charge ${task} attempts or backoff for a runner sign-in failure`, async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    const session = 'sign-in-work';
    await capture(db, session, [GOTCHAS[0]!]);
    await publish(db, NOW, harness.bindings.BUCKET);
    if (task === 'extract-curate') await cardAll(db, harness.bindings.BUCKET, session, NOW);
    const before = await db.prepare('SELECT failures,eligible_at,card_failures,card_retry_at FROM learning_sessions WHERE session_id=?')
      .bind(session).first();
    const turnsBefore = (await db.prepare('SELECT turn_key,due_at FROM turn_cards WHERE session_id=?').bind(session).all()).results;
    for (let index = 0; index < 5; index++) {
      const at = NOW + index * 10;
      const claim = await harness.poll(at);
      if (!claim.claimed) throw new Error(`sign-in attempt ${index} was not claimed: ${claim.reason}`);
      expect(claim.run.task).toBe(task);
      const end = () => endLeasedRun(harness.env, { principal: harness.principal, now: at + 1 }, {
        projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'failed',
        error: 'the harness stopped: error (login_missing; exit code 1)',
      });
      expect(await end()).toMatchObject({ ended: true, status: 'failed' });
      expect(await db.prepare('SELECT error_code FROM agent_runs WHERE id=?').bind(claim.run.id).first())
        .toEqual({ error_code: 'agent_not_signed_in' });
      expect(await db.prepare('SELECT failures,eligible_at,card_failures,card_retry_at FROM learning_sessions WHERE session_id=?')
        .bind(session).first()).toEqual(before);
      expect((await db.prepare('SELECT turn_key,due_at FROM turn_cards WHERE session_id=?').bind(session).all()).results).toEqual(turnsBefore);
      expect(await end()).toMatchObject({ ended: false });
    }
  });
});

it('retains earlier card failure backoff after a runner sign-in failure', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    await capture(db, 'prior-backoff', [GOTCHAS[0]!]);
    await publish(db, NOW, harness.bindings.BUCKET);
    const failed = await harness.poll(NOW);
    if (!failed.claimed) throw new Error('no initial card claim');
    await endLeasedRun(harness.env, { principal: harness.principal, now: NOW + 1 }, {
      projectId: 'project', runId: failed.run.id, attemptId: failed.run.attemptId, status: 'failed', error: 'model failed',
    });
    const before = await db.prepare("SELECT card_failures,card_retry_at FROM learning_sessions WHERE session_id='prior-backoff'").first();
    const claim = await harness.poll(NOW + HOUR + 1);
    if (!claim.claimed) throw new Error('no card retry');
    await endLeasedRun(harness.env, { principal: harness.principal, now: NOW + HOUR + 2 }, {
      projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'failed',
      error: 'the harness stopped: error (login_missing)',
    });
    expect(await db.prepare("SELECT card_failures,card_retry_at FROM learning_sessions WHERE session_id='prior-backoff'").first()).toEqual(before);
  });
});

it('closes old work without retrying it and admits a resumed session after new capture', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    await capture(db, 'aged', [{ id: uuid(1200), text: 'Learn the cause of this failure', at: NOW - 5 * HOUR }]);
    await publish(db, NOW + HOUR, harness.bindings.BUCKET);
    const first = await harness.poll(NOW + HOUR);
    if (!first.claimed) throw new Error('initial card work was not claimed');
    await endLeasedRun(harness.env, { principal: harness.principal, now: NOW + HOUR + 1 }, {
      projectId: 'project', runId: first.run.id, attemptId: first.run.attemptId, status: 'failed', error: 'model unavailable',
    });
    const at = NOW + LEARNING_WINDOW_MS - 4 * HOUR;
    await advanceLearningDeadlines(db, at, { page: LEARNING_ADVANCE_PAGE, age: true });
    const status = await readLearningStatus(db, at);
    expect(status).toMatchObject({ agedOutSessions: 1, turnsAwaitingCards: 0, dueCards: 0, dueSessions: 0 });
    expect(learningStatusLine(status, null)).toContain('1 session was not learned because it went quiet more than 7 days before Myco reached it');
    expect(await harness.poll(at)).toMatchObject({ claimed: false });
    expect(await harness.poll(at + 1)).toMatchObject({ claimed: false });
    await capture(db, 'aged', [{ id: uuid(1201), text: 'Learn this new failure after resuming', at }], 'project', at);
    await publish(db, at + 3 * HOUR, harness.bindings.BUCKET);
    expect(await readLearningStatus(db, at + 3 * HOUR)).toMatchObject({ turnsAwaitingCards: 2, agedOutSessions: 0 });
    const resumed = await harness.poll(at + 3 * HOUR);
    if (!resumed.claimed) throw new Error('resumed source was not admitted');
    const material = await harness.call(resumed.run.runToken, 'myco_run_cards', { op: 'material' });
    expect(material).toMatchObject({ session_id: 'aged' });
    expect((material.turns as { turn_key: string }[]).map(turn => turn.turn_key)).toEqual([uuid(1200), uuid(1201)]);
  });
});

it('cards pending turns before learning an aged-out session named by a hand start', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    await capture(db, 'named-aged', [{ id: uuid(1210), text: 'Keep the explicit recovery decision', at: NOW - 5 * HOUR }]);
    await publish(db, NOW + HOUR, harness.bindings.BUCKET);
    const at = NOW + LEARNING_WINDOW_MS - 4 * HOUR;
    await advanceLearningDeadlines(db, at, { page: LEARNING_ADVANCE_PAGE, age: true });
    expect(await harness.poll(at)).toMatchObject({ claimed: false });
    expect(await dispatchTask(harness.env, 'extract-curate', 'project', {
      serverUrl: 'https://myco.test', actor: 'clock', params: { session_id: 'named-aged' },
    }, at)).toMatchObject({ dispatched: true });
    expect(await harness.poll(at + 1)).toMatchObject({ claimed: false });
    await capture(db, 'later', [{ ...GOTCHAS[0]!, id: uuid(1212), at: at - 5 * HOUR }], 'other', at - 5 * HOUR);
    await publish(db, at - 4 * HOUR, harness.bindings.BUCKET);
    await cardAll(db, harness.bindings.BUCKET, 'later', at - 2 * HOUR, 'other');
    await settingsWriter(db).setLeaf('agent.scheduled_tasks_enabled', false, 'owner', at);
    expect(await dispatchTask(harness.env, 'extract-curate', 'project', {
      serverUrl: 'https://myco.test', actor: 'mem_worker', params: { session_id: 'named-aged' },
    }, at)).toMatchObject({ dispatched: true });
    expect(await dispatchTask(harness.env, 'extract-curate', 'other', {
      serverUrl: 'https://myco.test', actor: 'mem_worker', params: { session_id: 'later' },
    }, at + 1)).toMatchObject({ dispatched: true });
    const later = await harness.poll(at + 2);
    if (!later.claimed) throw new Error('waiting summaries blocked later queued work');
    expect(later.run.task).toBe('extract-curate');
    expect(await harness.call(later.run.runToken, 'myco_run_learning', { op: 'material' }, 'other')).toMatchObject({ session_id: 'later' });
    await harness.call(later.run.runToken, 'myco_run_learning', { op: 'complete', handoff: '' }, 'other');
    await harness.call(later.run.runToken, 'myco_run', { op: 'report', action: EXTRACTION_REPORT_ACTION, summary: 'learned', audit: RUN_AUDIT }, 'other');
    expect(await endLeasedRun(harness.env, { principal: harness.principal, now: at + 3 }, {
      projectId: 'other', runId: later.run.id, attemptId: later.run.attemptId, status: 'completed',
    })).toMatchObject({ ended: true, status: 'completed' });
    const card = await harness.poll(at + 4);
    if (!card.claimed) throw new Error('manual learning did not admit prerequisite cards');
    expect(card.run.task).toBe('turn-cards');
    const material = await harness.call(card.run.runToken, 'myco_run_cards', { op: 'material' });
    expect(await harness.call(card.run.runToken, 'myco_run_cards', { op: 'write', revision: material.revision,
      cards: [{ turns: [uuid(1210)], signal: 'high', card: EMPTY_CARD }] })).toMatchObject({ written: 1 });
    await harness.call(card.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'carded', audit: RUN_AUDIT });
    expect(await endLeasedRun(harness.env, { principal: harness.principal, now: at + 5 }, {
      projectId: 'project', runId: card.run.id, attemptId: card.run.attemptId, status: 'completed',
    })).toMatchObject({ ended: true, status: 'completed' });
    const claim = await harness.poll(at + 6);
    if (!claim.claimed) throw new Error(`named hand start did not claim the aged-out session: ${claim.reason}`);
    expect(claim.run.task).toBe('extract-curate');
    expect(await harness.call(claim.run.runToken, 'myco_run_learning', { op: 'material' })).toMatchObject({ session_id: 'named-aged' });
    expect(await harness.call(claim.run.runToken, 'myco_run_learning', { op: 'complete', handoff: '' })).toMatchObject({ completed: true, covered: 1 });
    expect((await readLearningStatus(db, at + 7)).agedOutSessions).toBe(0);
    expect(await db.prepare("SELECT covered FROM turn_cards WHERE session_id='named-aged'").first()).toEqual({ covered: 1 });
  });
});

it('names a manual request waiting for summaries and its own expiry', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    await capture(db, 'waiting', [{ id: uuid(1220), text: 'Keep this decision', at: NOW }], 'project', NOW);
    await publish(db, NOW + HOUR, harness.bindings.BUCKET);
    const request = await dispatchTask(harness.env, 'extract-curate', 'project', {
      serverUrl: 'https://myco.test', actor: 'mem_worker', params: { session_id: 'waiting' },
    }, NOW + HOUR);
    if (!request.dispatched) throw new Error('manual request was refused');
    expect(await harness.poll(NOW + HOUR + 1)).toMatchObject({ claimed: false });
    const detail = await getRunDetail(db, { projectId: 'project' }, request.runId!, NOW + HOUR + 1, 'mem_worker');
    expect(holdSentence(detail!.run.waitReason)).toBe('Waiting for this session’s turns to be summarized.');
    await runStaleSweep(harness.env, NOW + HOUR + QUEUE_MAX_AGE_MS);
    expect((await getRunDetail(db, { projectId: 'project' }, request.runId!, NOW + HOUR + QUEUE_MAX_AGE_MS, 'mem_worker'))?.run)
      .toMatchObject({ status: 'failed', errorCode: 'cards_wait_expired', error: 'Its turns were not summarized within a day.' });
  });
});

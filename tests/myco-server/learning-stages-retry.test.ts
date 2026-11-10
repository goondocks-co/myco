import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { runStaleSweep } from '@myco-server-worker/core/jobs-run.js';
import { commitRunUpdate } from '@myco-server-worker/core/release.js';
import { storedCardFields } from '@goondocks/myco-shared/turn-card';
import { expect, it } from 'bun:test';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from './helpers/member-token.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { MATERIAL_CHANGED } from '@myco-server-worker/core/material-pages.js';
import { readLearningStatus } from '@myco-server-worker/core/learning-sessions.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { beforeWriteBatch } from './helpers/prepared.js';
import { envelope, memberHeaders, memoryBlobStore, recordingDeferred, recordingLimiter, uuid } from './helpers/fixtures.js';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { claimNextRun, dispatchTask, endLeasedRun, expireLeases } from '@myco-server-worker/core/harness.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { CARD_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import { runTick } from '@myco-server-worker/core/tick.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { cardsWrittenBy } from '@myco-server-worker/core/run-postconditions.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { LEARNING_STAGES, buildHandStartLearning } from '@myco-server-worker/core/learning-stages.js';
import { registeredObjectKeySql } from '@myco-server-worker/core/blob-objects.js';
import { NOW, HOUR, DAY, enable, capture, publish, GOTCHAS, EMPTY_CARD, cardWorker, cardRun, plainTurns } from './helpers/learning-stages.ts';

it('with learning due and dispatch refused at the spend ceiling, claims and ticks read no session document', async () => {
  await withDocumentStores(async (db, name) => {
    const blobs = memoryBlobStore();
    const bindings = { MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() };
    const env = serverEnvFromBindings(bindings as never, recordingDeferred());
    await capture(db, 'session', GOTCHAS);
    await db.prepare(enable).run();
    await publish(db, NOW, blobs);
    const documents = new Set((await db.prepare(`SELECT ${registeredObjectKeySql('c.project_id', 'c.blob_key')} k FROM session_chunks c`)
      .all<{ k: string }>()).results.map((row) => row.k));
    expect(documents.size, name).toBeGreaterThan(0);
    await db.prepare(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.harnesses.claude-code.credential','"worker-login"',0,'test')`).run();
    await db.prepare(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)`).run();
    await completeBudgetMigration(db, NOW);
    await ensureMember(db, 'mem_worker', NOW, 'admin');
    const principal = legacyWorker((await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId, 'm1');
    await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,completed_at,cost_usd) VALUES('project','spent','myco-agent','turn-cards','completed','automatic',?,?,25)`).bind(NOW, NOW).run();
    await db.prepare(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd,cost_source) VALUES('project','spent','spent','w',?,1,25,'actual')`).bind(NOW).run();
    blobs.gets.length = 0;
    for (let poll = 0; poll < 5; poll += 1)
      expect(await claimNextRun(env, { principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now: NOW + 1 + poll }), name)
        .toMatchObject({ claimed: false });
    for (let tick = 0; tick < 2; tick += 1) await runTick(env, NOW + 100 + tick);
    expect(blobs.gets.filter((read) => documents.has(read.key)), name).toEqual([]);
  });
});

it('waits for the shared idle window at card and learning claims, rechecks contact at the write, and admits ended sessions immediately', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    const turn = uuid(900);
    await capture(db, 'quiet-rule', [{ id: turn, text: 'Fix quiet-session claims', at: NOW - HOUR }], 'project', NOW);
    await publish(db, NOW, harness.bindings.BUCKET);
    const poll = (now: number) => harness.poll(now);
    const activeCards = LEARNING_STAGES[0]!.due("'project'", NOW + HOUR);
    expect(await db.prepare(`SELECT ${activeCards.sql} AS due`).bind(...activeCards.params).first()).toEqual({ due: 0 });
    expect(await poll(NOW + HOUR)).toMatchObject({ claimed: false });
    await settingsWriter(db).setLeaf('agent.titling_idle_close_minutes', 5, 'owner', NOW);
    await catchUpProjections(db, { budget: { calls: 120, wallMs: 60_000 } });
    const idle = NOW + 5 * 60_000;
    expect(await poll(idle - 1)).toMatchObject({ claimed: false });
    harness.env.db = beforeWriteBatch(db, sql => sql.includes('INSERT INTO agent_runs (project_id, id, agent_id, task, status, origin, subject'),
      () => capture(db, 'quiet-rule', [], 'project', idle), true);
    expect(await poll(idle)).toMatchObject({ claimed: false });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM agent_runs').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM agent_run_attempts').first()).toEqual({ n: 0 });
    harness.env.db = db;
    const at = idle + 5 * 60_000;
    const claim = await poll(at);
    if (!claim.claimed) throw new Error('quiet cards not claimed');
    expect(claim.run.task).toBe('turn-cards');
    const material = await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'material' });
    expect(await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'write', revision: material.revision,
      cards: [{ turns: [turn], signal: 'high', card: EMPTY_CARD }] })).toMatchObject({ written: 1 });
    await harness.call(claim.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'carded', audit: RUN_AUDIT });
    expect(await endLeasedRun(harness.env, { principal: harness.principal, now: at + 1 }, {
      projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'completed',
    })).toEqual({ ended: true, status: 'completed' });
    await capture(db, 'quiet-rule', [], 'project', at + 2);
    const activeLearning = LEARNING_STAGES[1]!.due("'project'", at + 3);
    expect(await db.prepare(`SELECT ${activeLearning.sql} AS due`).bind(...activeLearning.params).first()).toEqual({ due: 0 });
    expect(await poll(at + 3)).toMatchObject({ claimed: false });
    expect((await readLearningStatus(db, at + 3)).dueSessions).toBe(0);
    expect(await buildHandStartLearning(harness.env, 'project', at + 3, { session_id: 'quiet-rule' })).toBeNull();
    const token = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, at + 3);
    expect(await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token.tokenId, bodyBytes: 1, now: at + 4 },
      envelope({ eventId: crypto.randomUUID(), sessionId: 'quiet-rule', kind: 'session.end', createdAt: at + 4, payload: { endedAt: at + 4 } })))
      .toMatchObject({ persisted: true });
    expect(await dispatchTask(harness.env, 'extract-curate', 'project', { serverUrl: 'https://myco.test', actor: 'mem_worker',
      params: { session_id: 'quiet-rule' } }, at + 4)).toMatchObject({ dispatched: true, queued: true });
    harness.env.db = beforeWriteBatch(db, sql => sql.includes("SET status = 'running', started_at"),
      async () => { await db.prepare("UPDATE sessions SET ended_at=NULL,last_received_at=? WHERE session_id='quiet-rule'").bind(at + 4).run(); }, true);
    expect(await poll(at + 4)).toMatchObject({ claimed: false });
    harness.env.db = db;
    expect(await db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE task='extract-curate' AND status='running'").first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM agent_run_attempts').first()).toEqual({ n: 1 });
    await db.prepare("UPDATE sessions SET ended_at=? WHERE session_id='quiet-rule'").bind(at + 4).run();
    const learning = await poll(at + 4);
    if (!learning.claimed) throw new Error('ended learning not claimed');
    expect(learning.run.task).toBe('extract-curate');
    expect(await harness.call(learning.run.runToken, 'myco_run_learning', { op: 'material' })).toMatchObject({ session_id: 'quiet-rule' });
  });
});

it('backs failed card attempts off for one, six and then twenty-four hours, and resets after success', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    const turn = uuid(910);
    await capture(db, 'retry-cards', [{ id: turn, text: 'Card work that can fail', at: 10 }]);
    await publish(db, NOW, harness.bindings.BUCKET);
    let at = NOW;
    for (const [index, delay] of [HOUR, 6 * HOUR, DAY, DAY].entries()) {
      const claim = await harness.poll(at);
      if (!claim.claimed) throw new Error(`retry ${index} not claimed`);
      expect(claim.run.task).toBe('turn-cards');
      expect(await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'material' })).toMatchObject({ session_id: 'retry-cards' });
      const failedAt = at + 1_000;
      expect(await endLeasedRun(harness.env, { principal: harness.principal, now: failedAt }, {
        projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'failed', error: 'card model failed',
      })).toMatchObject({ ended: true, status: 'failed' });
      at = failedAt + delay;
      expect(await db.prepare("SELECT card_failures,card_retry_at FROM learning_sessions WHERE session_id='retry-cards'").first())
        .toEqual({ card_failures: index + 1, card_retry_at: at });
      expect(await harness.poll(at - 1)).toMatchObject({ claimed: false });
    }
    const claim = await harness.poll(at);
    if (!claim.claimed) throw new Error('successful retry not claimed');
    const material = await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'material' });
    expect(await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'write', revision: material.revision,
      cards: [{ turns: [turn], signal: 'high', card: EMPTY_CARD }] })).toMatchObject({ written: 1 });
    await harness.call(claim.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'carded', audit: RUN_AUDIT });
    expect(await endLeasedRun(harness.env, { principal: harness.principal, now: at + 1 }, {
      projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'completed',
    })).toEqual({ ended: true, status: 'completed' });
    expect(await db.prepare("SELECT card_failures,card_retry_at FROM learning_sessions WHERE session_id='retry-cards'").first())
      .toEqual({ card_failures: 0, card_retry_at: 0 });
    await capture(db, 'retry-cards', [{ id: uuid(911), text: 'Another card after success', at: 20 }]);
    await publish(db, at + 2, harness.bindings.BUCKET);
    const again = await harness.poll(at + 2);
    if (!again.claimed) throw new Error('new cards not claimed after reset');
    expect(again.run.task).toBe('turn-cards');
    expect(await db.prepare("SELECT card_failures,card_retry_at FROM learning_sessions WHERE session_id='retry-cards'").first())
      .toEqual({ card_failures: 1, card_retry_at: at + 2 + HOUR });
  });
});

it('finishes escaped and multibyte cards through smaller revision-bound requests under the cap, and cannot close after only a subset', async () => {
  await withDocumentStores(async db => {
    const run = await cardRun(db, plainTurns(24, 920));
    const { inputs, revision } = await run.readAll();
    const offered = await worker.fetch(new Request('https://myco.test/mcp', { method: 'POST',
      headers: memberHeaders(run.claimed.run.runToken, { [PROJECT_HEADER]: 'project' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }), run.bindings as never);
    const tools = await offered.json() as { result: { tools: { name: string; description: string }[] } };
    expect(tools.result.tools.find(tool => tool.name === 'myco_run_cards')!.description).toContain(String(MAX_BODY_BYTES));
    const card = { ...EMPTY_CARD, asked: '\u0001'.repeat(3_500) + '😀'.repeat(500) };
    const cards = [...inputs.keys()].map(turn => ({ turns: [turn], signal: 'high', card }));
    const requestBytes = (part: unknown) => new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'myco_run_cards', arguments: { op: 'write', revision, cards: part } } })).length;
    console.info('card request bytes', { whole: requestBytes(cards), split: requestBytes(cards.slice(0, 8)) });
    expect(requestBytes(cards)).toBeGreaterThan(MAX_BODY_BYTES);
    const oversized = await run.harness.request(run.claimed.run.runToken, 'myco_run_cards', { op: 'write', revision, cards });
    expect(oversized.status).toBe(400);
    const refused = await oversized.json();
    expect(JSON.stringify(refused)).toContain('body_cap');
    expect(JSON.stringify(refused)).toContain(String(MAX_BODY_BYTES));
    expect(JSON.stringify(refused)).toContain('Split cards');
    expect(await db.prepare("SELECT COUNT(*) AS n FROM turn_cards WHERE session_id='long' AND state='carded'").first()).toEqual({ n: 0 });
    const name = 'myco_run_cards';
    expect(await run.harness.call(run.claimed.run.runToken, name, { op: 'write', revision: 'wrong', cards: cards.slice(0, 8) }))
      .toMatchObject({ code: MATERIAL_CHANGED });
    expect(await run.harness.call(run.claimed.run.runToken, name, { op: 'write', cards: cards.slice(0, 8) }))
      .toMatchObject({ code: MATERIAL_CHANGED });
    for (let offset = 0; offset < cards.length; offset += 8) {
      const part = cards.slice(offset, offset + 8);
      expect(requestBytes(part)).toBeLessThan(MAX_BODY_BYTES);
      expect(await run.harness.call(run.claimed.run.runToken, name, { op: 'write', revision, cards: part }))
        .toMatchObject({ written: part.length, changed_since_served: [] });
      const stored = (await getRun(db, { projectId: 'project' }, run.claimed.run.id))!;
      expect(await cardsWrittenBy(db, { projectId: 'project' }, stored)).toBe(offset + 8 === cards.length);
    }
    expect(await run.harness.call(run.claimed.run.runToken, name, { op: 'write', revision, cards: cards.slice(0, 8) }))
      .toMatchObject({ written: 0 });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM turn_cards WHERE session_id='long' AND state='carded'").first()).toEqual({ n: 24 });
    const storedCards = await db.prepare("SELECT fields FROM turn_cards WHERE session_id='long'").all<{ fields: string }>();
    expect(storedCards.results.map(row => storedCardFields(row.fields)!.asked)).toEqual(cards.map(() => card.asked));
    await run.harness.call(run.claimed.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'carded', audit: RUN_AUDIT });
    expect(await endLeasedRun(run.env, { principal: run.principal, now: NOW + DAY + 1 }, {
      projectId: 'project', runId: run.claimed.run.id, attemptId: run.claimed.run.attemptId, status: 'completed',
    })).toEqual({ ended: true, status: 'completed' });
  });
});

it('finishes a card run when every assigned turn changed after its material was served', async () => {
  await withDocumentStores(async db => {
    const turn = uuid(950);
    const run = await cardRun(db, [{ id: turn, text: 'Fix the first material', at: 10 }]);
    const { revision } = await run.readAll();
    await capture(db, 'long', [{ id: turn, text: 'Fix the first material', at: 10, replies: ['A new finding changes this turn.'] }]);
    await publish(db, NOW + DAY + 1, run.bindings.BUCKET);
    expect(JSON.parse((await run.raw({ op: 'write', revision, cards: [{ turns: [turn], signal: 'high', card: EMPTY_CARD }] })).content[0]!.text))
      .toEqual({ written: 0, changed_since_served: [turn] });
    await run.harness.call(run.claimed.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'material changed', audit: RUN_AUDIT });
    expect(await endLeasedRun(run.env, { principal: run.principal, now: NOW + DAY + 2 }, {
      projectId: 'project', runId: run.claimed.run.id, attemptId: run.claimed.run.attemptId, status: 'completed',
    })).toEqual({ ended: true, status: 'completed' });
    expect(await db.prepare("SELECT state FROM turn_cards WHERE session_id='long' AND turn_key=?").bind(turn).first()).toEqual({ state: 'pending' });
  });
});

it('retires card credentials after lease expiry, stale sweep and a direct runtime close despite trigger writes', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    for (const [index, mode] of ['lease', 'stale', 'runtime'].entries()) {
      const session = `crash-${mode}`;
      const at = NOW + DAY + index * 10;
      await capture(db, session, [{ id: uuid(970 + index), text: 'Card this work before the runtime ends', at: 10 + index }]);
      await publish(db, NOW, harness.bindings.BUCKET);
      const claim = await harness.poll(at);
      if (!claim.claimed) throw new Error('card run not claimed');
      expect(claim.run.task).toBe('turn-cards');
      expect(await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'material' })).toMatchObject({ session_id: session });
      if (mode === 'lease') {
        await db.prepare('UPDATE agent_runs SET lease_expires_at=? WHERE id=?').bind(at, claim.run.id).run();
        expect(await expireLeases(harness.env, at + 1)).toBe(1);
        expect(await expireLeases(harness.env, at + 2)).toBe(0);
      } else if (mode === 'stale') {
        await db.prepare('UPDATE agent_runs SET started_at=? WHERE id=?').bind(at - HOUR, claim.run.id).run();
        expect(await runStaleSweep(harness.env, at + 1)).toBe(1);
        expect(await runStaleSweep(harness.env, at + 2)).toBe(0);
      } else {
        expect(await commitRunUpdate(harness.env, { projectId: 'project' }, claim.run.id,
          { status: 'failed', completed_at: at + 1, error: 'runtime ended' }, {
            caller: { tokenId: claim.run.attemptId, now: at, deadline: at + HOUR }, now: at + 1, errorCode: 'run_failed',
          })).toBe(1);
      }
      expect((await getRun(db, { projectId: 'project' }, claim.run.id))?.status).toBe('failed');
      expect((await harness.request(claim.run.runToken, 'myco_run_cards', { op: 'material' })).status).toBe(401);
      expect(await db.prepare('SELECT card_failures,card_retry_at FROM learning_sessions WHERE session_id=?').bind(session).first())
        .toEqual({ card_failures: 1, card_retry_at: at + 1 + HOUR });
    }
  });
});

it('finishes and retires an assigned pending turn that its material cannot serve', async () => {
  await withDocumentStores(async db => {
    const run = await cardRun(db, [{ id: uuid(980), text: 'Keep the live turn intact', at: 10 }]);
    const missing = uuid(981);
    await db.prepare("INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,due_at) VALUES('project','long',?,10,?)").bind(missing, NOW).run();
    await db.prepare("UPDATE agent_runs SET run_context=json_set(run_context,'$.assignment.turns',json(?)) WHERE id=?")
      .bind(JSON.stringify([{ turnKey: missing, changes: 0 }]), run.claimed.run.id).run();
    const material = await run.material();
    expect(material.turns).toEqual([]);
    expect(JSON.parse((await run.raw({ op: 'write', revision: material.revision, cards: [] })).content[0]!.text))
      .toEqual({ written: 0, changed_since_served: [] });
    expect(await db.prepare('SELECT turn_key FROM turn_cards WHERE turn_key=?').bind(missing).first()).toBeNull();
    expect(await db.prepare('SELECT state FROM turn_cards WHERE turn_key=?').bind(uuid(980)).first()).toEqual({ state: 'pending' });
    await run.harness.call(run.claimed.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'unavailable turn retired', audit: RUN_AUDIT });
    expect(await endLeasedRun(run.env, { principal: run.principal, now: NOW + DAY + 1 }, {
      projectId: 'project', runId: run.claimed.run.id, attemptId: run.claimed.run.attemptId, status: 'completed',
    })).toEqual({ ended: true, status: 'completed' });
  });
});

for (const outcome of ['cards-exhausted', 'learning-complete', 'learning-exhausted']) it(`keeps a fresh admission through four card attempts after source aging: ${outcome}`, async () => {
  await withDocumentStores(async db => {
    const succeeds = outcome !== 'cards-exhausted';
    const harness = await cardWorker(db);
    await settingsWriter(db).setLeaf('agent.learning_history_enabled', false, 'owner', NOW);
    const turn = uuid(990);
    await capture(db, 'fresh-retry', [{ id: turn, text: 'Keep retrying this initially fresh work', at: NOW }], 'project', NOW);
    await db.prepare("UPDATE sessions SET ended_at=? WHERE session_id='fresh-retry'").bind(NOW).run();
    await publish(db, NOW + HOUR / 2, harness.bindings.BUCKET);
    let at = NOW + HOUR / 2;
    for (let attempt = 0; attempt < 4; attempt++) {
      const claim = await harness.poll(at);
      if (!claim.claimed) throw new Error(`fresh retry ${attempt + 1} was not claimed`);
      expect(claim.run.task).toBe('turn-cards');
      const material = await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'material' });
      expect(material).toMatchObject({ session_id: 'fresh-retry' });
      if (attempt === 3 && succeeds) {
        expect(at).toBeGreaterThan(NOW + DAY);
        expect(await harness.call(claim.run.runToken, 'myco_run_cards', { op: 'write', revision: material.revision,
          cards: [{ turns: [turn], signal: 'high', card: EMPTY_CARD }] })).toMatchObject({ written: 1 });
        await harness.call(claim.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'carded', audit: RUN_AUDIT });
      }
      expect(await endLeasedRun(harness.env, { principal: harness.principal, now: at + 1 }, {
        projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId,
        status: attempt === 3 && succeeds ? 'completed' : 'failed', error: attempt === 3 && succeeds ? undefined : 'model unavailable',
      })).toMatchObject({ ended: true, status: attempt === 3 && succeeds ? 'completed' : 'failed' });
      if (attempt < 3) {
        const next = at + 1 + [HOUR, 6 * HOUR, DAY][attempt]!;
        expect(await harness.poll(next - 1)).toMatchObject({ claimed: false });
        at = next;
      }
    }
    expect(await db.prepare("SELECT source_activity_at FROM learning_sessions WHERE session_id='fresh-retry'").first())
      .toEqual({ source_activity_at: NOW });
    if (!succeeds) {
      expect(await harness.poll(at + DAY + 1)).toMatchObject({ claimed: false });
      expect((await readLearningStatus(db, at + DAY + 1)).historyWaiting).toBe(1);
      await settingsWriter(db).setLeaf('agent.learning_history_enabled', true, 'owner', at + DAY + 1);
      expect(await harness.poll(at + DAY + 1)).toMatchObject({ claimed: true, run: { task: 'turn-cards' } });
    } else {
      const learning = await harness.poll(at + 2);
      if (!learning.claimed) throw new Error('admitted session did not reach learning after its cards');
      expect(learning.run.task).toBe('extract-curate');
      expect((await readLearningStatus(db, at + 2)).historyWaiting).toBe(0);
      if (outcome === 'learning-complete') {
        await harness.call(learning.run.runToken, 'myco_run_learning', { op: 'material' });
        expect(await harness.call(learning.run.runToken, 'myco_run_learning', { op: 'complete', handoff: '' })).toMatchObject({ completed: true, covered: 1 });
        expect(await db.prepare("SELECT fresh_admitted FROM learning_sessions WHERE session_id='fresh-retry'").first()).toEqual({ fresh_admitted: 0 });
      } else {
        let claim = learning;
        let learningAt = at + 2;
        for (let attempt = 0; attempt < 4; attempt++) {
          await harness.call(claim.run.runToken, 'myco_run_learning', { op: 'material' });
          expect(await endLeasedRun(harness.env, { principal: harness.principal, now: learningAt + 1 }, {
            projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'failed', error: 'learning unavailable',
          })).toMatchObject({ ended: true, status: 'failed' });
          const retry = await db.prepare("SELECT eligible_at AS at FROM learning_sessions WHERE session_id='fresh-retry'").first<{ at: number }>();
          learningAt = retry!.at;
          const next = await harness.poll(learningAt);
          if (attempt < 3) {
            if (!next.claimed) throw new Error('admitted learning retry missed');
            claim = next;
          } else expect(next).toMatchObject({ claimed: false });
        }
        expect((await readLearningStatus(db, learningAt)).historyWaiting).toBe(1);
        await settingsWriter(db).setLeaf('agent.learning_history_enabled', true, 'owner', learningAt);
        expect(await harness.poll(learningAt)).toMatchObject({ claimed: true, run: { task: 'extract-curate' } });
      }
    }
  });
});

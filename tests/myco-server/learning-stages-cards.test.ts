import { expect, it } from 'bun:test';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from './helpers/member-token.js';
import { ensureAgent } from '@myco-server-worker/db/runs/state.js';
import { recordDispatch } from '@myco-server-worker/db/runs/claim.js';
import { learningHolds } from '@myco-server-worker/db/learning/hold.js';
import { tombstoneSession } from './helpers/session-deletion.js';
import { learningHeadSession as learningHead } from '@myco-server-worker/db/learning/ready.js';
import { cardMaterialPages, type CardMaterial } from '@myco-server-worker/core/turn-cards.js';
import { MATERIAL_CHANGED, MATERIAL_UNREAD, materialRead } from '@myco-server-worker/core/material-pages.js';
import { RUN_ANSWER_BYTES } from '@myco-server-worker/core/read-window.js';
import { trimTurn, triageTurn } from '@myco-server-worker/core/turn-card-rules.js';
import { buildLearningAssignment, assignedCards, completeLearning, readLearningStatus, learningStatusLine } from '@myco-server-worker/core/learning-sessions.js';
import { documentTurnInput } from '@myco-server-worker/content/turn-material.js';
import { buildCardInput } from '@myco-server-worker/core/learning-stages.js';
import { recordServedPrompts } from '@myco-server-worker/db/runs/served.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { beforeWriteBatch } from './helpers/prepared.js';
import { memberHeaders, recordingDeferred, recordingLimiter, uuid } from './helpers/fixtures.js';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { claimNextRun, dispatchTask, endLeasedRun } from '@myco-server-worker/core/harness.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { EXTRACTION_RULES } from '@myco-server-worker/core/extraction-rules.js';
import { AGENT_LINE_MAX_CHARS } from '@myco-server-worker/core/injection.js';
import { CARD_REPORT_ACTION, EXTRACTION_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import { cardsWrittenBy } from '@myco-server-worker/core/run-postconditions.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { BLOBS, NOW, HOUR, DAY, enable, capture, fakeCard, publish, cardAll, ready, GOTCHAS, cardRun, longTurn } from './helpers/learning-stages.ts';

it('cards each turn once by code or model, keeps gotcha strings verbatim and learns them through a guarded slice', async () => {
  await withDocumentStores(async (db) => {
    await capture(db, 'session', GOTCHAS);
    const blobs = await ready(db);
    const due = NOW + HOUR;
    const written = await cardAll(db, blobs, 'session', due);
    expect(written).toEqual({ written: 4, changed: [] });
    const cards = (await db.prepare(`SELECT turn_key, signal, signal_reason, card, run_id FROM turn_cards WHERE session_id='session' ORDER BY created_at`).all<Record<string, string>>()).results;
    expect(cards.map(c => [c.turn_key, c.signal, c.signal_reason])).toEqual([
      [uuid(1), 'high', 'model'], [uuid(2), 'high', 'model'], [uuid(3), 'high', 'model'], [uuid(4), 'high', 'model'],
      [uuid(6), 'none', 'no_human_text'], [uuid(7), 'none', 'polling_only'],
    ]);
    const text = (key: string) => cards.find(c => c.turn_key === key)!.card;
    expect(text(uuid(1))).toContain("error: Cannot find module '@myco-server-worker/core/x.js' from 'tests/a.test.ts'");
    expect(text(uuid(2))).toContain('rejected agent_state because it is per Project');
    expect(text(uuid(3))).toContain('--minify --compatibility-date=2026-08-01');
    expect(text(uuid(4))).toContain("archive them with myco server archive --keep");
    expect(await buildCardInput({ db }, 'project', 'session', due)).toBeNull();

    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    const assignment = (await buildLearningAssignment(db, 'project', 'session'))!;
    expect(assignment.turns.map(t => t.turnKey)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    const manifest = await assignedCards(db, 'project', 'session', assignment);
    expect(manifest.map(c => c.card)).toEqual([text(uuid(1)), text(uuid(2)), text(uuid(3)), text(uuid(4))]);
    expect(manifest[3]!.promptIds).toEqual([uuid(4), uuid(5)]);
    const raw = await documentTurnInput({ db, blobs }, 'project', 'session', uuid(1));
    expect(raw!.tools[0]!.output).toContain('ok line');

    await ensureAgent(db, { id: 'learner', name: 'learner', provider: null, model: null, enabled: true }, NOW);
    await recordDispatch(db, { projectId: 'project' }, { id: 'learn-1', agentId: 'learner', task: 'extract-curate', provider: null, model: null, runContext: null, dispatchedBy: null, startedAt: due });
    expect(await completeLearning(db, 'project', 'session', 'learn-1', assignment, 'handoff', due)).toEqual({ completed: false, covered: 0 });
    await recordServedPrompts(db, { projectId: 'project' }, 'learn-1', manifest.flatMap(c => c.promptIds.map(promptId => ({ promptId, sessionId: 'session', createdAt: 0, endedAt: null }))), due);
    expect(await completeLearning(db, 'project', 'session', 'learn-1', assignment, 'handoff', due + 1)).toEqual({ completed: true, covered: 4 });
    expect(await completeLearning(db, 'project', 'session', 'learn-1', assignment, 'again', due + 2)).toEqual({ completed: false, covered: 0 });
    const acked = (await db.prepare(`SELECT record_id FROM extraction_acks WHERE session_id='session' ORDER BY record_id`).all<{ record_id: string }>()).results.map(r => r.record_id);
    expect(acked).toEqual([uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)].sort());
    expect(await db.prepare(`SELECT due_cards, eligible_at, handoff, last_completed_reason FROM learning_sessions WHERE session_id='session'`).first())
      .toEqual({ due_cards: 0, eligible_at: null, handoff: 'handoff', last_completed_reason: 'completed' });
    expect(await learningHolds(db, 'project', 'session')).toBe(false);

    // A record published later into a carded turn makes only that turn due again, and reaches its card input.
    await capture(db, 'session', [{ id: uuid(1), text: 'Run the server tests', at: 10, tools: [{ name: 'Bash', input: { command: 'myco server repair --keep-capture' }, ok: false, error: 'EXACT_LATE_GOTCHA: capture lease refused' }] }]);
    await publish(db, due + HOUR, blobs);
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    const again = (await buildCardInput({ db }, 'project', 'session', due + HOUR))!;
    expect((again.context as { assignment: { turns: { turnKey: string }[] } }).assignment.turns.map(t => t.turnKey)).toEqual([uuid(1)]);
    expect(trimTurn((await documentTurnInput({ db, blobs }, 'project', 'session', uuid(1)))!).text).toContain('EXACT_LATE_GOTCHA: capture lease refused');

    // Deleting the session deletes its cards, which copy its words.
    await tombstoneSession({ db }, { projectId: 'project' }, 'session', 'member', NOW + 3 * HOUR);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM turn_cards WHERE session_id = 'session'`).first()).toEqual({ n: 0 });
  });
});

it('closes an all-mechanical session without a run and orders sessions newest first', async () => {
  await withDocumentStores(async (db) => {
    await capture(db, 'quiet', [{ id: uuid(11), text: 'continue', at: 10 }, { id: uuid(12), text: 'check status', at: 20, tools: [{ name: 'TaskOutput', input: { id: 'x' } }] }]);
    await capture(db, 'older', [{ id: uuid(21), text: 'Fix the flaky test', at: 30, replies: ['Fixed by awaiting the batch.'] }]);
    await capture(db, 'newer', [{ id: uuid(31), text: 'Add the index', at: 40, replies: ['Added idx_turn_cards_due.'] }]);
    const blobs = await ready(db);
    expect(await buildCardInput({ db }, 'project', 'quiet', NOW + HOUR)).toBeNull();
    expect(await db.prepare(`SELECT last_completed_reason AS reason, eligible_at FROM learning_sessions WHERE session_id='quiet'`).first())
      .toEqual({ reason: 'no_signal', eligible_at: null });
    expect(await learningHolds(db, 'project', 'quiet')).toBe(false);
    await cardAll(db, blobs, 'older', NOW + HOUR);
    await cardAll(db, blobs, 'newer', NOW + 2 * HOUR);
    expect(await learningHead(db, 'project', NOW + 3 * HOUR, false)).toBe('newer');
    const status = await readLearningStatus(db, NOW + 3 * HOUR);
    expect(status).toMatchObject({ dueSessions: 2, dueCards: 2, turnsAwaitingCards: 0, lastCompleted: { reason: 'no_signal', sessionId: 'quiet' } });
    expect(learningStatusLine(status, { dailyUsd: 20, automaticUsd: 1.5, manualUsd: 0.5 }, NOW + 120_000))
      .toBe('2 sessions ready to learn (2 summaries to learn from); 0 turns waiting to be summarized; last session closed with nothing to learn 2 min ago; spent $2.00 of $20.00 in the last 24 hours.');
  });
});

it('triages only mechanical turns by rule', () => {
  const turn = (over: Partial<Parameters<typeof triageTurn>[0]>) => ({ turnKey: 't', origin: 'user', prompt: 'continue', steering: [], replies: [], tools: [], plans: [], ...over });
  expect(triageTurn(turn({}))).toBe('no_human_text');
  expect(triageTurn(turn({ prompt: '<system-reminder>a hook ran</system-reminder>\n<task-notification><status>done</status></task-notification>' }))).toBe('no_human_text');
  expect(triageTurn(turn({ prompt: '<system-reminder>a hook ran</system-reminder>\nPin bun to 1.4.0 in .bun-version' }))).toBeNull();
  expect(triageTurn(turn({ prompt: 'Scheduled tasks are failing. Fix them by setting jobs.maxRetries to 3.' }))).toBeNull();
  expect(triageTurn(turn({ prompt: 'continue', tools: [{ toolCallId: 'x', toolName: 'Bash', input: '{"command":"npm test"}', output: 'boom', success: false, errorMessage: 'exit 1' }] }))).toBeNull();
  expect(triageTurn(turn({ prompt: 'wait for CI', tools: [{ toolCallId: 'x', toolName: 'Bash', input: '{"command":"gh pr checks 12 && sleep 30"}', output: '', success: true, errorMessage: null }] }))).toBe('polling_only');
  expect(triageTurn(turn({ prompt: 'wait for CI', tools: [{ toolCallId: 'x', toolName: 'Bash', input: '{"command":"gh pr checks 12 && git push"}', output: '', success: true, errorMessage: null }] }))).toBeNull();
  expect(triageTurn(turn({ prompt: 'continue', steering: [{ promptId: 's', text: 'no, stop' }] }))).toBeNull();

  // Every failure and command is kept verbatim however late in the turn, and a changed one changes the input.
  const routine = Array.from({ length: 200 }, (_, i) => ({ toolCallId: `r${i}`, toolName: 'Read', input: `{"file_path":"src/f${i}.ts"}`, output: 'x'.repeat(500), success: true, errorMessage: null }));
  const late = (error: string) => trimTurn(turn({ prompt: 'repair capture', tools: [...routine,
    { toolCallId: 'late', toolName: 'Bash', input: '{"command":"myco server repair --keep-capture"}', output: '', success: false, errorMessage: error }] })).text;
  expect(late('EXACT_GOTCHA_AT_201')).toContain('myco server repair --keep-capture');
  expect(late('EXACT_GOTCHA_AT_201')).toContain('EXACT_GOTCHA_AT_201');
  expect(late('EXACT_GOTCHA_AT_201')).toContain('TOOLS NOT LISTED: Read×');
  expect(late('EXACT_GOTCHA_AT_201')).not.toBe(late('another error'));
});

it('sends human requests and a turn whose failure comes after a hundred calls to the model, verbatim', async () => {
  await withDocumentStores(async (db) => {
    await capture(db, 'human', [
      { id: uuid(70), text: 'Scheduled tasks are failing. Fix them by setting jobs.maxRetries to 3; never retry a refused credential.', at: 10, replies: ['Set jobs.maxRetries to 3 and skipped refused credentials.'] },
      { id: uuid(71), text: 'Repair capture', at: 20, tools: [
        ...Array.from({ length: 120 }, (_, i) => ({ name: 'Read', input: { file_path: `src/f${i}.ts` }, output: 'ok' })),
        { name: 'Bash', input: { command: 'myco server repair --keep-capture' }, ok: false, error: 'EXACT_GOTCHA_AT_121: capture lease refused' },
      ] },
    ]);
    const blobs = await ready(db);
    const input = (await buildCardInput({ db }, 'project', 'human', NOW + HOUR))!;
    const turns = (input.context as { assignment: { turns: { turnKey: string }[] } }).assignment.turns.map(t => t.turnKey);
    expect(turns).toEqual([uuid(70), uuid(71)]);
    const trimmed = trimTurn((await documentTurnInput({ db, blobs }, 'project', 'human', uuid(71)))!).text;
    expect(trimmed).toContain('EXACT_GOTCHA_AT_121: capture lease refused');
    expect(trimmed).toContain('myco server repair --keep-capture');
  });
});

it('pulls cards, then learning, at claim within the budget, and the learned spore cites its session', async () => {
  await withDocumentStores(async (db) => {
    const bindings = { MYCO_DB: db, BUCKET: BLOBS, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() };
    const env = serverEnvFromBindings(bindings as never, recordingDeferred());
    await capture(db, 'session', GOTCHAS);
    await capture(db, 'quiet', [{ id: uuid(20), text: '<task-notification>done</task-notification>', at: 100, replies: ['Noted.'] }]);
    await db.prepare(enable).run();
    await publish(db, NOW, bindings.BUCKET);
    await db.prepare(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.harnesses.claude-code.credential','"worker-login"',0,'test')`).run();
    await db.prepare(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)`).run();
    await completeBudgetMigration(db, NOW);
    await ensureMember(db, 'mem_worker', NOW, 'admin');
    const principal = legacyWorker((await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId, 'm1');
    const poll = (now: number) => claimNextRun(env, { principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now });
    const call = async (token: string, name: string, input: Record<string, unknown>) => {
      const res = await worker.fetch(new Request('https://myco.test/mcp', { method: 'POST', headers: memberHeaders(token, { [PROJECT_HEADER]: 'project' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) }), bindings as never);
      const body = await res.json() as { result?: { content?: { text?: string }[] } };
      return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
    };
    const runs = async () => (await db.prepare(`SELECT task, subject, status FROM agent_runs ORDER BY started_at, id`).all()).results;

    // A day's automatic spend past the budget pulls nothing.
    await db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,origin,started_at,completed_at,cost_usd) VALUES('project','spent','myco-agent','turn-cards','completed','automatic',?,?,25)`).bind(NOW, NOW).run();
    await db.prepare(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,estimate_usd,cost_usd,cost_source) VALUES('project','spent','spent','w',?,1,25,'actual')`).bind(NOW).run();
    expect(await poll(NOW + 1)).toMatchObject({ claimed: false });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM turn_cards WHERE state = 'carded' AND run_id IS NOT NULL`).first()).toEqual({ n: 0 });

    // Past the window, nothing is pulled while the Deployment's learning switch is off.
    const at = NOW + DAY + 1;
    const learning = (on: boolean) => db.prepare(`UPDATE deployment_settings SET value = ? WHERE leaf = 'agent.scheduled_tasks_enabled'`).bind(String(on)).run();
    await learning(false);
    expect(await poll(at)).toMatchObject({ claimed: false });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM turn_cards WHERE state = 'carded' AND run_id IS NOT NULL`).first()).toEqual({ n: 0 });
    await learning(true);

    // Settlement carded the quiet session's only turn `none` by code and closed the session without a run.
    expect(await db.prepare(`SELECT last_completed_reason AS reason FROM learning_sessions WHERE session_id = 'quiet'`).first()).toEqual({ reason: 'no_signal' });
    expect(await runs()).toEqual([{ task: 'turn-cards', subject: null, status: 'completed' }]);

    // The switch turned off after selection refuses the claim's write: no run, no priced attempt.
    env.db = beforeWriteBatch(db, sql => sql.includes('INSERT INTO agent_runs (project_id, id, agent_id, task, status, origin, subject'), async () => { await learning(false); }, true);
    expect(await poll(at + 1)).toMatchObject({ claimed: false });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM agent_run_attempts WHERE run_id <> 'spent'`).first()).toEqual({ n: 0 });
    env.db = db;
    await learning(true);

    const cards = await poll(at + 1);
    if (!cards.claimed) throw new Error(`no card run: ${cards.reason}`);
    expect(cards.run).toMatchObject({ task: 'turn-cards', profile: { tier: 'low' } });
    const material = await call(cards.run.runToken, 'myco_run_cards', { op: 'material' }) as { revision: string; turns: { turn_key: string; input: string }[] };
    expect(material.turns.map(turn => turn.turn_key)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    expect(await call(cards.run.runToken, 'myco_run_cards', { op: 'write', revision: material.revision, cards: material.turns.map(turn => ({ turns: [turn.turn_key], ...fakeCard(turn.input) })) }))
      .toMatchObject({ written: 4 });
    const ran = await db.prepare(`SELECT model FROM agent_runs WHERE id = ?`).bind(cards.run.id).first<{ model: string | null }>();
    expect(ran?.model).toBeTruthy();
    expect((await db.prepare(`SELECT DISTINCT model FROM turn_cards WHERE state = 'carded' AND run_id = ?`).bind(cards.run.id).all()).results).toEqual([{ model: ran!.model }]);
    await call(cards.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'carded', audit: RUN_AUDIT });
    expect(await endLeasedRun(env, { principal, now: at + 2 }, { projectId: 'project', runId: cards.run.id, attemptId: cards.run.attemptId, status: 'completed' }))
      .toEqual({ ended: true, status: 'completed' });

    const learn = await poll(at + 3);
    if (!learn.claimed) throw new Error(`no learning run: ${learn.reason}`);
    expect(learn.run).toMatchObject({ task: 'extract-curate', instructions: EXTRACTION_RULES });
    // The claim takes the session out of the eligible set until it completes or the claim is presumed lost.
    expect(await db.prepare(`SELECT failures, eligible_at > ? AS later FROM learning_sessions WHERE session_id = 'session'`).bind(at + 3).first()).toEqual({ failures: 1, later: 1 });
    const slice = await call(learn.run.runToken, 'myco_run_learning', { op: 'material' }) as { session_id: string; cards: { card: string }[] };
    expect(slice.session_id).toBe('session');
    expect(slice.cards[0]!.card).toContain("error: Cannot find module '@myco-server-worker/core/x.js' from 'tests/a.test.ts'");
    const refusedLine = await call(learn.run.runToken,'myco_spores',{op:'save',type:'gotcha',session_id:'session',agent_line:'x'.repeat(AGENT_LINE_MAX_CHARS+1),content:'Use the pinned Bun.'}) as {ok:boolean;error:string};
    expect(refusedLine.ok).toBe(false);
    expect(refusedLine.error).toContain(`agent_line is ${AGENT_LINE_MAX_CHARS+1} characters`);
    expect(refusedLine.error).toContain(`limit is ${AGENT_LINE_MAX_CHARS}`);
    expect(refusedLine.error).toContain('Next call: myco_spores {"op":"save"}');
    expect(await call(learn.run.runToken, 'myco_spores', { op: 'save', type: 'gotcha', session_id: 'session', agent_line: 'When running tests, use the pinned Bun.', content: 'Tests need the pinned Bun: PATH=$HOME/tools/bun-1.4.0:$PATH npm test.' }))
      .toMatchObject({ id: expect.any(String) });
    expect(await call(learn.run.runToken, 'myco_run_learning', { op: 'complete', handoff: 'nothing open' })).toEqual({ completed: true, covered: 4 });
    await call(learn.run.runToken, 'myco_run', { op: 'report', action: EXTRACTION_REPORT_ACTION, summary: 'learned', audit: RUN_AUDIT });
    expect(await endLeasedRun(env, { principal, now: at + 4 }, { projectId: 'project', runId: learn.run.id, attemptId: learn.run.attemptId, status: 'completed' }))
      .toEqual({ ended: true, status: 'completed' });
    expect(await db.prepare(`SELECT session_id FROM spores WHERE content LIKE 'Tests need the pinned Bun%'`).first()).toEqual({ session_id: 'session' });
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    expect((await runs()).slice(1)).toEqual([
      { task: 'turn-cards', subject: 'cards:session', status: 'completed' }, { task: 'extract-curate', subject: 'session:session', status: 'completed' },
    ]);

    // With nothing left to learn, a hand start ends as nothing due.
    expect(await dispatchTask(env, 'extract-curate', 'project', { serverUrl: 'https://myco.test', actor: 'mem_worker' }, at + 5)).toMatchObject({ dispatched: true, queued: true });
    expect(await poll(at + 6)).toMatchObject({ claimed: false });
    expect(await db.prepare(`SELECT status, run_context FROM agent_runs WHERE task = 'extract-curate' AND origin = 'manual'`).first())
      .toEqual({ status: 'skipped', run_context: '{"reason":"nothing_due"}' });
  });
});

/** One Bash failure the trimmer keeps verbatim, whose command weighs `chars` characters. */

it('serves a card run\'s material in answers the harness holds whole, losing nothing', async () => {
  await withDocumentStores(async (db) => {
    const run = await cardRun(db, [longTurn(uuid(30), 'a turn longer than one answer', 10, 24), { id: uuid(31), text: 'a short turn', at: 20, replies: ['Done.'] }]);
    const { inputs, revision, pages } = await run.readAll();
    expect(pages).toBeGreaterThan(1);
    for (let page = 1; page <= pages; page += 1) {
      const held = JSON.stringify((await run.raw({ op: 'material', page, revision })).structuredContent);
      expect(new TextEncoder().encode(held).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
    }
    expect([...inputs.keys()]).toEqual([uuid(30), uuid(31)]);
    const whole = await documentTurnInput(run.env, 'project', 'long', uuid(30));
    expect(inputs.get(uuid(30))).toBe(trimTurn(whole!).text);
    expect((await run.material({ page: pages + 1, revision })).error).toContain(`the last valid page is ${pages}`);
  });
});

it('refuses a card write until this attempt has read every page, and names the next one', async () => {
  await withDocumentStores(async (db) => {
    const key = uuid(30);
    const run = await cardRun(db, [longTurn(key, '😀'.repeat(4_000), 10, 24)]);
    const pendingCard = () => db.prepare(`SELECT state FROM turn_cards WHERE turn_key = ?`).bind(key).first();
    expect(await run.write([key])).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 1 });

    const first = await run.material();
    expect(first.turns[0]).toMatchObject({ turn_key: key, continues: true });
    expect(first.next_page).toBe(2);
    expect(await run.write([key])).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2, revision: first.revision });
    expect(await pendingCard()).toEqual({ state: 'pending' });
    expect(await run.material({ page: 3, revision: first.revision })).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2 });

    const second = await run.material({ page: 2, revision: first.revision });
    expect(second.next_page).toBe(3);
    expect(await run.material({ page: 3 })).toMatchObject({ code: MATERIAL_CHANGED });
    expect(await run.write([key])).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 3 });
    expect((await run.material({ page: 1 })).revision).toBe(first.revision);
    expect(await run.write([key])).toMatchObject({ ok: false, next_page: 3 });

    const last = await run.material({ page: 3, revision: first.revision });
    expect(last.next_page).toBeUndefined();
    expect(await run.write([key])).toEqual({ written: 1, changed_since_served: [] });
    expect(await pendingCard()).toEqual({ state: 'carded' });
  });
});

it('refuses a continuation when capture publishes between pages, and a restart reads the new revision whole', async () => {
  await withDocumentStores(async (db) => {
    const a = uuid(40);
    const b = uuid(41);
    const run = await cardRun(db, [{ id: a, text: 'first turn', at: 10, replies: ['r'.repeat(1_000)] }, longTurn(b, 'second turn', 20, 16)]);
    const first = await run.material();
    const second = await run.material({ page: first.next_page!, revision: first.revision });
    expect(first.turns.map((turn) => turn.turn_key)).toEqual([a]);
    expect(second.turns[0]).toMatchObject({ turn_key: b, continues: true });

    await capture(db, 'long', [{ id: uuid(42), text: '増'.repeat(8_000), at: 30, parent: a }, { id: uuid(43), text: '増'.repeat(8_000), at: 31, parent: a }]);
    await publish(db, NOW + DAY + 1, run.bindings.BUCKET);

    expect(await run.material({ page: second.next_page!, revision: second.revision })).toMatchObject({ ok: false, code: MATERIAL_CHANGED });
    expect(await run.write([a, b])).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: second.next_page, revision: first.revision });

    const restarted = await run.material();
    expect(restarted.revision).not.toBe(first.revision);
    expect(await run.write([a, b])).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2, revision: restarted.revision });

    const { inputs } = await run.readAll();
    expect(inputs.get(b)).toBe(trimTurn((await documentTurnInput(run.env, 'project', 'long', b))!).text);
    expect(await run.write([a, b])).toEqual({ written: 1, changed_since_served: [a] });
    expect(await cardsWrittenBy(db, { projectId: 'project' }, (await getRun(db, { projectId: 'project' }, run.claimed.run.id))!)).toBe(true);
  });
});

it('credits material reads to the attempt that made them', () => {
  const read = { tokenId: 'attempt', revision: 'r', pages: 2, through: 2, items: 2 };
  expect(materialRead(JSON.stringify({ materialRead: read }), 'attempt')).toEqual(read);
  expect(materialRead(JSON.stringify({ materialRead: read }), 'next-attempt')).toBeNull();
});

it('pages by weight, and a split never lands inside a character', () => {
  for (const turnKey of ['e', 'em', 'emo', 'emoj']) {
    const emoji: CardMaterial = { turn_key: turnKey, input: '😀'.repeat(RUN_ANSWER_BYTES) };
    const pages = cardMaterialPages('s', [{ turn_key: 'short', input: 'first' }, emoji, { turn_key: 'after', input: 'last' }]);
    const pieces = pages.flat().filter((turn) => turn.turn_key === turnKey);
    expect(pieces.at(-1)!.continues).toBeUndefined();
    expect(pieces.slice(0, -1).every((piece) => piece.continues === true && !/\ud83d$/.test(piece.input))).toBe(true);
    expect(pieces.map((piece) => piece.input).join('')).toBe(emoji.input);
    expect(pages[0]!.map((turn) => turn.turn_key)).toEqual(['short']);
    expect(pages.at(-1)!.map((turn) => turn.turn_key)).toEqual([turnKey, 'after']);
    for (const [at, turns] of pages.entries()) {
      expect(new TextEncoder().encode(JSON.stringify({ result: { session_id: 's', revision: '0'.repeat(16), page: at + 1, next_page: at + 2, turns } })).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
    }
  }
});

/** A stored card of about `chars` characters of `text`. */

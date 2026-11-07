import { runStaleSweep } from '@myco-server-worker/core/jobs-run.js';
import { commitRunUpdate } from '@myco-server-worker/core/release.js';
import { storedCardFields } from '@goondocks/myco-shared/turn-card';
import { describe, expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { learningHolds } from '@myco-server-worker/core/learning-hold.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { forgetTurnStatement, cardStatements, cardMaterialPages, writeRunCards, type CardFields, type CardMaterial } from '@myco-server-worker/core/turn-cards.js';
import { MATERIAL_CHANGED, MATERIAL_UNREAD, materialRead } from '@myco-server-worker/core/material-pages.js';
import { RUN_ANSWER_BYTES } from '@myco-server-worker/core/read-window.js';
import { trimTurn, triageTurn } from '@myco-server-worker/core/turn-card-rules.js';
import {
  pendingCardsStatement, learningHead, buildLearningAssignment, learningMaterialPages, assignedCards, completeLearning, readLearningStatus, learningStatusLine,
} from '@myco-server-worker/core/learning-sessions.js';
import { documentTurnInput } from '@myco-server-worker/content/turn-material.js';
import type { BlobStore } from '@myco-server-worker/core/adapters.js';
import { knowledgeInputForExecution } from '@myco-server-worker/core/knowledge-execution.js';
import { prepareWorkerRepository } from '@myco-server-worker/core/worker-repository.js';
import { buildCardInput } from '@myco-server-worker/core/learning-stages.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { beforeWriteBatch } from './helpers/prepared.js';
import { envelope, memberHeaders, memoryBlobStore, recordingDeferred, recordingLimiter, uuid } from './helpers/fixtures.js';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { claimNextRun, dispatchTask, endLeasedRun, expireLeases } from '@myco-server-worker/core/harness.js';
import { completeBudgetMigration } from '@myco-server-worker/db/budget-activation.js';
import { EXTRACTION_RULES } from '@myco-server-worker/core/extraction-rules.js';
import { AGENT_LINE_MAX_CHARS, AGENT_LINE_EXAMPLE } from '@myco-server-worker/core/injection.js';
import { STATE_CHANGED } from '@myco-server-worker/mcp/tools/run.js';
import { CARD_REPORT_ACTION, EXTRACTION_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { cardsWrittenBy } from '@myco-server-worker/core/run-postconditions.js';
import { getRun } from '@myco-server-worker/core/runs.js';
import { LEARNING_STAGES, buildHandStartLearning } from '@myco-server-worker/core/learning-stages.js';
import { registeredObjectKeySql } from '@myco-server-worker/core/blob-objects.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const enable = "INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner'),('agent.learning_history_enabled','true',1,'owner')";

interface Turn {
  id: string; text: string; at: number; origin?: string; parent?: string;
  replies?: string[]; tools?: { name: string; input: unknown; output?: string; ok?: boolean; error?: string }[];
}

let serial = 0;
async function capture(db: RelationalStore, sessionId: string, turns: readonly Turn[], projectId = 'project', receiptAt = 1) {
  await ensureMember(db, 'member', 1, 'member');
  const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, 1);
  const ctx = { projectId, machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: receiptAt };
  const send = async (event: Record<string, unknown>) => {
    const result = await ingestEvent(db, ctx, envelope({ eventId: uuid(100_000 + ++serial), sessionId, ...event }));
    if (!result.persisted) throw new Error(JSON.stringify(result));
  };
  await send({ kind: 'session.start', createdAt: 1, payload: { agent: 'claude-code', startedAt: 1 } });
  for (const turn of turns) {
    await send({ kind: 'prompt', createdAt: turn.at, payload: { promptId: turn.id, text: turn.text, origin: turn.origin ?? 'user', ...(turn.parent ? { parentPromptId: turn.parent } : {}) } });
    for (const [i, reply] of (turn.replies ?? []).entries())
      await send({ kind: 'response', createdAt: turn.at + 1 + i, payload: { responseId: uuid(200_000 + ++serial), promptId: turn.id, text: reply } });
    for (const [i, tool] of (turn.tools ?? []).entries())
      await send({ kind: tool.ok === false ? 'tool.failure' : 'tool.use', createdAt: turn.at + 10 + i, payload: {
        toolCallId: uuid(300_000 + ++serial), promptId: turn.id, toolName: tool.name, input: tool.input, success: tool.ok !== false,
        ...(tool.output === undefined ? {} : { output: tool.output }), ...(tool.error === undefined ? {} : { errorMessage: tool.error }) } });
  }
}

/** A card model stand-in: it copies the exact strings a gotcha turns on out of the trimmed input. */
function fakeCard(input: string): { signal: 'none' | 'low' | 'high'; card: CardFields } {
  const lines = input.split('\n');
  const errors = lines.filter(line => /error|failed|Error/.test(line) && !line.startsWith('TOOL')).map(error => ({ error: error.trim(), fix: lines.find(l => /fix|works|--/.test(l) && l.startsWith('REPLY') === false && l !== error) ?? '' }));
  const commands = lines.filter(line => line.startsWith('TOOL Bash')).map(line => line.slice('TOOL Bash '.length));
  const corrections = lines.flatMap((line, i) => line === 'STEERING PROMPT:' ? [{ wrong: lines[i - 1] ?? '', right: lines[i + 1] ?? '' }] : []);
  const rejected = lines.filter(line => /instead of|rejected|not use/i.test(line)).map(line => ({ approach: line, reason: line }));
  const high = errors.length + corrections.length + rejected.length > 0 || commands.some(c => c.includes('--'));
  return { signal: high ? 'high' : 'low', card: { asked: lines[2] ?? '', done: 'worked the turn', outcome: 'done', decisions: [], rejected, errors, corrections, files: [], commands, open_questions: [] } };
}

/** Publishes every session due and settles the cards due for settlement, as the wake does. */
async function publish(db: RelationalStore, now: number, blobs: BlobStore = memoryBlobStore()) {
  await publishDocuments({ db, blobs }, now, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
  return blobs;
}

async function cardAll(db: RelationalStore, blobs: BlobStore, sessionId: string, now: number, projectId = 'project') {
  const input = await buildCardInput({ db }, projectId, sessionId, now);
  if (input === null) return null;
  const assignment = (input.context as { assignment: { turns: { turnKey: string; changes: number }[] } }).assignment;
  const writes = [];
  for (const turn of assignment.turns) {
    const read = await documentTurnInput({ db, blobs }, projectId, sessionId, turn.turnKey);
    writes.push({ turns: [turn.turnKey], ...fakeCard(trimTurn(read!).text) });
  }
  return writeRunCards({ db }, projectId, sessionId, assignment.turns, writes, { runId: `cards-${sessionId}`, model: 'fake' }, now);
}

/** Learning on, and every captured session published with its cards settled. */
async function ready(db: RelationalStore, now = NOW): Promise<BlobStore> {
  await db.prepare(enable).run();
  return publish(db, now);
}

const GOTCHAS: Turn[] = [
  { id: uuid(1), text: 'Run the server tests', at: 10, replies: ['The suite fails: bun needs the pinned version. The fix that works is PATH=$HOME/tools/bun-1.4.0:$PATH npm test.'],
    tools: [{ name: 'Bash', input: { command: 'npm test -- tests/server.test.ts' }, ok: false, error: 'exit 1',
      output: `${'ok line\n'.repeat(300)}error: Cannot find module '@myco-server-worker/core/x.js' from 'tests/a.test.ts'\n${'ok line\n'.repeat(200)}` }] },
  { id: uuid(2), text: 'Store the cursor in schema_meta', at: 20, replies: ['Using schema_meta instead of agent_state, rejected agent_state because it is per Project and the cursor is Deployment-wide.'] },
  { id: uuid(3), text: 'Deploy the worker', at: 30, replies: ['Deployed.'],
    tools: [{ name: 'Bash', input: { command: 'npx wrangler deploy --minify --compatibility-date=2026-08-01' }, output: 'Uploaded myco (1.2 sec)' }] },
  { id: uuid(4), text: 'Delete the old rows', at: 40, replies: ['Deleting with DELETE FROM runs.'] },
  { id: uuid(5), text: 'no, don\'t delete them; archive them with myco server archive --keep', at: 41, parent: uuid(4) },
  { id: uuid(6), text: '<task-notification><status>completed</status></task-notification>', at: 50, replies: ['Noted.'] },
  { id: uuid(7), text: 'check CI', at: 60, tools: [{ name: 'Bash', input: { command: 'gh run watch 123' }, output: 'completed success' }] },
];

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
    const bindings = { MYCO_DB: db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() };
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
const failedCommand = (at: number, chars: number) => ({ name: 'Bash', input: { command: `echo ${at} ${'é"\n'.repeat(chars / 3)}` }, ok: false, error: `exit ${at}` });

const EMPTY_CARD: CardFields = { asked: 'a turn', done: 'routine work', outcome: 'done', decisions: [], rejected: [], errors: [], corrections: [], files: [], commands: [], open_questions: [] };
interface MaterialAnswer { revision: string; page: number; next_page?: number; code?: string; error?: string; turns: CardMaterial[] }

/** A card worker with calls through the real `/mcp` route. */
async function cardWorker(db: RelationalStore) {
  const bindings = { MYCO_DB: db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() };
  const env = serverEnvFromBindings(bindings as never, recordingDeferred());
  await db.prepare(enable).run();
  await db.prepare(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.harnesses.claude-code.credential','"worker-login"',0,'test')`).run();
  await db.prepare(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)`).run();
  await completeBudgetMigration(db, NOW);
  await ensureMember(db, 'mem_worker', NOW, 'admin');
  const principal = legacyWorker((await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId, 'm1');
  const poll = (now: number) => claimNextRun(env, { principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now });
  const request = (token: string, name: string, input: Record<string, unknown>) => worker.fetch(new Request('https://myco.test/mcp', {
    method: 'POST', headers: memberHeaders(token, { [PROJECT_HEADER]: 'project' }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }),
  }), bindings as never);
  const call = async (token: string, name: string, input: Record<string, unknown>) => {
    const body = await (await request(token, name, input)).json() as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
  };
  return { bindings, env, principal, poll, request, call };
}

async function cardRun(db: RelationalStore, turns: readonly Turn[]) {
  const harness = await cardWorker(db);
  const { bindings, env, principal } = harness;
  await capture(db, 'long', turns);
  await publish(db, NOW, bindings.BUCKET);
  const claimed = await harness.poll(NOW + DAY);
  if (!claimed.claimed) throw new Error(`no card run: ${claimed.reason}`);
  let revision: string | undefined;
  const raw = async (arguments_: Record<string, unknown>) => {
    const res = await worker.fetch(new Request('https://myco.test/mcp', { method: 'POST', headers: memberHeaders(claimed.run.runToken, { [PROJECT_HEADER]: 'project' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run_cards', arguments: { ...(arguments_.op === 'write' ? { revision } : {}), ...arguments_ } } }) }), bindings as never);
    const result = (await res.json() as { result: { content: { text: string }[]; structuredContent: unknown } }).result;
    const answered = JSON.parse(result.content[0]!.text) as { revision?: string };
    if (arguments_.op === 'material' && answered.revision !== undefined) revision = answered.revision;
    return result;
  };
  const material = async (input: Record<string, unknown> = {}) => JSON.parse((await raw({ op: 'material', ...input })).content[0]!.text) as MaterialAnswer;
  const write = async (keys: readonly string[]) => JSON.parse((await raw({ op: 'write', cards: keys.map((key) => ({ turns: [key], signal: 'low', card: EMPTY_CARD })) })).content[0]!.text) as Record<string, unknown>;
  const readAll = async () => {
    const inputs = new Map<string, string>();
    let answer = await material();
    for (;;) {
      for (const turn of answer.turns) inputs.set(turn.turn_key, (inputs.get(turn.turn_key) ?? '') + turn.input);
      if (answer.next_page === undefined) return { inputs, revision: answer.revision, pages: answer.page };
      answer = await material({ page: answer.next_page, revision: answer.revision });
    }
  };
  return { bindings, env, raw, material, write, readAll, principal, claimed, harness };
}

const longTurn = (id: string, text: string, at: number, calls: number): Turn => ({ id, text, at, tools: Array.from({ length: calls }, (_, call) => failedCommand(call, 1_900)) });

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
const heavyCard = (text: string, chars: number): string => text.repeat(Math.floor(chars / text.length));

interface LearningPage { session_id: string; handoff?: string | null; more_slices?: boolean; changed_since_assignment?: number; revision: string; page: number; next_page?: number; cards: { turn_key: string; signal: string; card: string; continues?: true }[] }

/** A claimed learning run over these turns, each carded by its own card run as `cardOf` says, called through the real `/mcp` route. */
async function learningRun(db: RelationalStore, turns: readonly Turn[], signal: 'low' | 'high', cardTextOf?: (key: string) => string, handoff: string | null = null, connected = false, execution: {harness?:string;capabilities?:readonly string[];unreadable?:boolean;queued?:boolean} = {}) {
  const carding = await cardRun(db, turns);
  const { inputs } = await carding.readAll();
  const { bindings, env, principal } = carding;
  expect((JSON.parse((await carding.raw({ op: 'write', cards: [...inputs.keys()].map((key) => ({ turns: [key], signal, card: EMPTY_CARD })) })).content[0]!.text) as { written: number }).written).toBe(turns.length);
  if (cardTextOf !== undefined) for (const key of inputs.keys()) await db.prepare(`UPDATE turn_cards SET card = ? WHERE turn_key = ?`).bind(cardTextOf(key), key).run();
  const callAs = async (token: string, name: string, input: Record<string, unknown>) => {
    const res = await worker.fetch(new Request('https://myco.test/mcp', { method: 'POST', headers: memberHeaders(token, { [PROJECT_HEADER]: 'project' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }) }), bindings as never);
    return (await res.json() as { result: { content: { text: string }[]; structuredContent: unknown } }).result;
  };
  await callAs(carding.claimed.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'carded', audit: RUN_AUDIT });
  await endLeasedRun(env, { principal, now: NOW + DAY + 1 }, { projectId: 'project', runId: carding.claimed.run.id, attemptId: carding.claimed.run.attemptId, status: 'completed' });
  if (handoff !== null) await db.prepare(`UPDATE learning_sessions SET handoff = ?`).bind(handoff).run();
  if (connected) await db.prepare(`INSERT INTO project_repositories(project_id,revision,url,branch,updated_at,updated_by)
    VALUES('project','connection','https://example.test/team/repo','main',1,'test')`).run();
  const harness=execution.harness ?? 'claude-code';
  if (harness === 'codex') await settingsWriter(db).setLeaf('agent.tasks',{'extract-curate':{harness,model:'gpt-6',reasoningLevel:'default'}},'member',NOW+DAY+2);
  if (execution.unreadable) await db.prepare("UPDATE project_repositories SET username='reader',secret_slot='missing' WHERE project_id='project'").run();
  if (execution.queued) expect(await dispatchTask(env,'extract-curate','project',{serverUrl:'https://myco.test',actor:'member',params:{session_id:'long'}},NOW+DAY+2)).toMatchObject({dispatched:true});
  const learn = await claimNextRun(env, { principal, harnesses: [offeredHarness(harness)], capabilities: execution.capabilities ?? WORKER_CAPABILITIES, now: NOW + DAY + 2 });
  if (!learn.claimed) throw new Error(`no learning run: ${learn.reason}`);
  expect(learn.run.task).toBe('extract-curate');
  const raw = (name: string, input: Record<string, unknown>) => callAs(learn.run.runToken, name, input);
  const call = async (name: string, input: Record<string, unknown>) => JSON.parse((await raw(name, input)).content[0]!.text) as Record<string, unknown>;
  const material = async (input: Record<string, unknown> = {}) => await call('myco_run_learning', { op: 'material', ...input }) as unknown as LearningPage;
  const readAll = async () => {
    const pages: LearningPage[] = [await material()];
    while (pages.at(-1)!.next_page !== undefined) pages.push(await material({ page: pages.at(-1)!.next_page, revision: pages.at(-1)!.revision }));
    return pages;
  };
  const save = (agentLine: string, content = agentLine) => call('myco_spores', { op: 'save', type: 'gotcha', session_id: 'long', agent_line: agentLine, content });
  return { bindings, env, principal, claimed:learn.run, raw, call, material, readAll, save, complete: (text: string) => call('myco_run_learning', { op: 'complete', handoff: text }) };
}

const plainTurns = (count: number, base = 500): Turn[] => Array.from({ length: count }, (_, at) => ({ id: uuid(base + at), text: `Work on the part ${at}`, at: 10 + at, replies: ['Done.'] }));

it('serves a learning run\'s slice in answers the harness holds whole, losing nothing', async () => {
  await withDocumentStores(async (db) => {
    const turns = plainTurns(24);
    const handoff = 'the previous slice left this open'.repeat(100);
    const run = await learningRun(db, turns, 'low', (key) => (key === turns[3]!.id ? heavyCard('\u0001', 11_000) : heavyCard('é"\n', 10_800)), handoff);
    const pages = await run.readAll();
    expect(pages.length).toBeGreaterThan(5);

    let page = 0;
    for (const answer of pages) {
      page += 1;
      const held = JSON.stringify((await run.raw('myco_run_learning', { op: 'material', page, revision: answer.revision })).structuredContent);
      expect(new TextEncoder().encode(held).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
      expect(answer.handoff).toBe(page === 1 ? handoff : undefined);
    }
    expect(pages[0]!.more_slices).toBe(true);
    expect(pages.some((answer) => answer.cards.some((card) => card.continues === true))).toBe(true);

    const served = new Map<string, string>();
    for (const answer of pages) for (const card of answer.cards) served.set(card.turn_key, (served.get(card.turn_key) ?? '') + card.card);
    const { results } = await db.prepare(`SELECT turn_key AS key, card FROM turn_cards WHERE turn_key IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...served.keys()])).all<{ key: string; card: string }>();
    expect(results.length).toBe(served.size);
    for (const row of results) expect(served.get(row.key)).toBe(row.card);
    expect(served.get(turns[3]!.id)).toContain('\u0001'.repeat(11_000));
    const past = await run.material({ page: pages.length + 1, revision: pages[0]!.revision });
    if (!('ok' in past) || past.ok !== false || !('error' in past) || typeof past.error !== 'string') throw new Error('Expected a past-end refusal');
    expect(past.error).toContain(`the last valid page is ${pages.length}`);
    expect(past.error).toContain('Next call: myco_spores {"op":"save"}');
    expect(past.error).toContain('then call myco_run_learning op complete');
    expect(past.error).toStartWith('Not read:');
  });
});

it('leaves page 1 of a slice room for what it carries beside its cards', () => {
  const opening = { handoff: 'h\n'.repeat(2_048), more_slices: true, changed_since_assignment: 1 };
  const cards = Array.from({ length: 60 }, (_, at) => ({ turn_key: `turn-${at}`, signal: 'low', card: 'é'.repeat(1_000) }));
  const pages = learningMaterialPages('s', opening, cards);
  expect(pages.length).toBeGreaterThan(2);
  for (const [at, page] of pages.entries()) {
    const answer = { result: { session_id: 's', ...(at === 0 ? opening : {}), revision: '0'.repeat(16), page: at + 1, next_page: at + 2, cards: page } };
    expect(new TextEncoder().encode(JSON.stringify(answer)).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
  }
  expect(pages.flat().map((entry) => entry.turn_key)).toEqual(cards.map((card) => card.turn_key));
});

it('refuses a learning run\'s spore writes and completion until this attempt has read every page, and names the next one', async () => {
  await withDocumentStores(async (db) => {
    const turns = plainTurns(8);
    const run = await learningRun(db, turns, 'low', () => heavyCard('é"\n', 10_800));
    const writes = () => [
      run.save('A line.'), run.complete('open'),
      run.call('myco_spores', { op: 'supersede', old_spore_id: 'spr_a', new_spore_id: 'spr_b', expect_revision: 1, reason: 'r' }),
      run.call('myco_spores', { op: 'obsolete', id: 'spr_a', expect_revision: 1, reason: 'r' }),
      run.call('myco_spores', { op: 'consolidate', source_spore_ids: [{ id: 'spr_a', revision: 1 }], consolidated_content: 'c', observation_type: 'wisdom', agent_line: 'A line.', reason: 'r' }),
    ];
    const held = async () => db.prepare(`SELECT (SELECT COUNT(*) FROM spores) AS spores, (SELECT COUNT(*) FROM turn_cards WHERE covered = 1) AS covered, (SELECT COUNT(*) FROM run_served_material WHERE session_id = 'long' AND run_id IN (SELECT id FROM agent_runs WHERE task = 'extract-curate')) AS served`).first<{ spores: number; covered: number; served: number }>();
    for (const refused of await Promise.all(writes())) expect(refused).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 1 });
    expect(await held()).toEqual({ spores: 0, covered: 0, served: 0 });

    const first = await run.material();
    expect(first.next_page).toBe(2);
    const servedOfFirst = (await held())!.served;
    expect(servedOfFirst).toBe(first.cards.length);
    for (const refused of await Promise.all(writes())) expect(refused).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2, revision: first.revision });
    expect(await run.material({ page: 3, revision: first.revision })).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2 });
    expect(await run.material({ page: 2 })).toMatchObject({ code: MATERIAL_CHANGED });
    expect(await held()).toEqual({ spores: 0, covered: 0, served: servedOfFirst });

    const second = await run.material({ page: 2, revision: first.revision });
    await db.prepare(`UPDATE turn_cards SET input_hash = 'changed' WHERE turn_key = ?`).bind(turns[7]!.id).run();
    expect(await run.material({ page: second.next_page!, revision: second.revision })).toMatchObject({ ok: false, code: MATERIAL_CHANGED });
    expect(await run.save('A line.')).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 3, revision: first.revision });

    const restarted = await run.readAll();
    expect(restarted[0]!.revision).not.toBe(first.revision);
    expect(restarted[0]!.changed_since_assignment).toBe(1);
    expect(await run.save('When a turn runs long, read every page.')).toMatchObject({ id: expect.any(String) });
    expect(await run.complete('nothing open')).toEqual({ completed: true, covered: 7 });
  });
});

it('leaves a page unread when its served record fails, so completion cannot retire text the run never received', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'high', () => heavyCard('増', 11_700), 'h\n'.repeat(2_048));
    const first = await run.material();
    expect(first.cards[0]!.continues).toBe(true);
    expect(first.next_page).toBe(2);
    let failed = 0;
    run.bindings.MYCO_DB = beforeWriteBatch(db, (sql) => sql.includes('INSERT INTO run_served_material'), async () => { failed += 1; throw new Error('storage down'); }, true);
    expect(await run.raw('myco_run_learning', { op: 'material', page: 2, revision: first.revision })).toBeUndefined();
    run.bindings.MYCO_DB = db;
    expect(failed).toBe(1);
    expect(await run.complete('only page 1 arrived')).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2 });
    expect(await run.save('A line.')).toMatchObject({ ok: false, code: MATERIAL_UNREAD, next_page: 2 });
    expect((await run.material({ page: 2, revision: first.revision })).page).toBe(2);
    expect(await run.complete('all of it arrived')).toEqual({ completed: true, covered: 1 });
  });
});

it('keeps state usable within one answer: a value that cannot fit is refused, and a longer one already held is read in parts with its version', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'low');
    await run.readAll();
    const key = 'long-key';
    expect(await run.call('myco_run', { op: 'state_set', key, value: 'x'.repeat(RUN_ANSWER_BYTES) })).toMatchObject({ ok: false, error: expect.stringContaining('JSON UTF-8 bytes; the limit is') });
    expect(await run.call('myco_run', { op: 'state_set', key, value: '\u0001'.repeat(7_000) })).toMatchObject({ ok: false });
    expect(await run.call('myco_run', { op: 'state_set', key, value: 'short' })).toEqual({ key, applied: true });
    const long = '増"\n'.repeat(30_000);
    await db.prepare(`UPDATE agent_state SET value = ? WHERE key = ?`).bind(long, key).run();

    let read = '';
    let version: unknown;
    for (let offset: number | undefined = 0, parts = 0; offset !== undefined; parts += 1) {
      expect(parts).toBeLessThan(10);
      const held = await run.raw('myco_run', { op: 'state_get', key, ...(offset === 0 ? {} : { offset, version }) });
      expect(new TextEncoder().encode(JSON.stringify(held.structuredContent)).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
      const answer = (held.structuredContent as { result: { value: string; version: string; next_offset?: number } }).result;
      read += answer.value;
      version = answer.version;
      offset = answer.next_offset;
    }
    expect(read).toBe(long);
    expect(await run.call('myco_run', { op: 'state_set', key, value: 'smaller', version })).toEqual({ key, applied: true });
    expect(await run.call('myco_run', { op: 'state_get', key, offset: -1 })).toMatchObject({ ok: false });
  });
});

it('refuses a state continuation once the value has changed, so parts of two versions never join and overwrite the newer one', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'low');
    await run.readAll();
    const key = 'shared-key';
    await run.call('myco_run', { op: 'state_set', key, value: 'short' });
    await db.prepare(`UPDATE agent_state SET value = ? WHERE key = ?`).bind('x'.repeat(41_000), key).run();
    const first = await run.call('myco_run', { op: 'state_get', key }) as { value: string; version: string; next_offset: number };
    expect(first.next_offset).toBe(first.value.length);
    const continuation = { op: 'state_get', key, offset: first.next_offset };
    expect(await run.call('myco_run', continuation)).toMatchObject({ ok: false, code: STATE_CHANGED });
    expect((await run.call('myco_run', { ...continuation, version: first.version })).version).toBe(first.version);

    expect(await run.call('myco_run', { op: 'state_set', key, value: 'newer', version: first.version })).toEqual({ key, applied: true });
    const refused = await run.call('myco_run', { ...continuation, version: first.version });
    expect(refused).toMatchObject({ ok: false, code: STATE_CHANGED, error: expect.stringContaining('version is missing') });
    expect(refused).not.toHaveProperty('value');
    expect(refused).not.toHaveProperty('version');
    expect(await run.call('myco_run', { op: 'state_set', key, value: first.value, version: first.version })).toEqual({ key, applied: false });
    expect(await run.call('myco_run', { op: 'state_get', key })).toMatchObject({ value: 'newer' });
  });
});

it('answers a spore get whatever its fields hold, cut to fit, and to less when asked', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'low');
    await run.readAll();
    const saved = await run.call('myco_spores', { op:'save', type:'gotcha', session_id:'long', agent_line:'A spore with a long context.', content:'the body' }) as { id:string };
    expect(await db.prepare('SELECT file_path FROM spores WHERE id=?').bind(saved.id).first()).toEqual({file_path:null});
    await db.prepare(`UPDATE spores SET context = ?, properties = ? WHERE id = ?`).bind('c'.repeat(41_000), '\u0001'.repeat(20_000), saved.id).run();
    const held = await run.raw('myco_run_spores', { op: 'get', id: saved.id });
    expect(new TextEncoder().encode(JSON.stringify(held.structuredContent)).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
    expect((held.structuredContent as { result: { truncated: boolean; spore: { id: string; revision: number; content: string } } }).result)
      .toMatchObject({ truncated: true, spore: { id: saved.id, revision: expect.any(Number), content: 'the body' } });
    const less = await run.call('myco_run_spores', { op: 'get', id: saved.id, max_chars: 10 }) as { truncated: boolean; spore: { context: string } };
    expect(less).toMatchObject({ truncated: true, spore: { context: 'c'.repeat(10) } });
    expect(await run.call('myco_run_spores', { op: 'get', id: saved.id, max_chars: 0 })).toMatchObject({ ok: false, error: expect.stringContaining('max_chars') });
    const whole = await run.save('Another spore, no long fields.', 'a short body') as { id: string };
    expect(await run.call('myco_run_spores', { op: 'get', id: whole.id })).toMatchObject({ truncated: false, spore: { content: 'a short body' } });
  });
});

it('answers a learning run\'s save with the closest active spores, and that is enough to supersede and consolidate', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(2), 'low');
    await run.readAll();
    const fullReads = () => db.prepare(`SELECT COUNT(*) AS n FROM agent_run_events WHERE tool_name = 'myco_run_spores'`).first<{ n: number }>();

    const first = await run.save(AGENT_LINE_EXAMPLE) as { id: string; near_matches: unknown[] };
    expect(first.near_matches).toEqual([]);
    const second = await run.save('Declaring a run tool op in WRITE_OPS keeps dry runs from writing (packages/myco-server/src/core/tool-catalogue.ts).') as { id: string; near_matches: unknown[] };
    expect(second.near_matches).toEqual([{ id: first.id, revision: expect.any(Number), observation_type: 'gotcha', agent_line: AGENT_LINE_EXAMPLE }]);
    const near = second.near_matches[0] as { id: string; revision: number };

    expect(await run.call('myco_spores', { op: 'supersede', old_spore_id: near.id, new_spore_id: second.id, expect_revision: near.revision, reason: 'says why' }))
      .toMatchObject({ old_spore: near.id, new_spore: second.id, status: 'superseded' });
    expect(await fullReads()).toEqual({ n: 0 });

    const third = await run.save('Another op in WRITE_OPS: same dry-run rule (packages/myco-server/src/core/tool-catalogue.ts).') as { id: string; revision: number; near_matches: { id: string; revision: number }[] };
    expect(third.near_matches.map((match) => match.id)).toEqual([second.id]);
    expect(await run.call('myco_spores', { op: 'consolidate', session_id: 'long', source_spore_ids: [{ id: third.id, revision: third.revision }, ...third.near_matches.map(({ id, revision }) => ({ id, revision }))],
      consolidated_content: 'Every write op is declared in WRITE_OPS.', observation_type: 'wisdom', agent_line: 'Every write op is declared in WRITE_OPS.', reason: 'one topic' }))
      .toMatchObject({ status: 'consolidated', sources_consolidated: 2 });
    expect(await fullReads()).toEqual({ n: 0 });
  });
});

it('states the agent line\'s bound in the rules, by an example inside it, and rules out adding by default', () => {
  expect(AGENT_LINE_EXAMPLE.length).toBeLessThanOrEqual(AGENT_LINE_MAX_CHARS);
  expect(EXTRACTION_RULES).toContain(AGENT_LINE_EXAMPLE);
  expect(EXTRACTION_RULES).toContain(`${AGENT_LINE_MAX_CHARS} characters`);
  expect(EXTRACTION_RULES).toContain('When in doubt, keep it');
  expect(EXTRACTION_RULES).toContain('Preserve useful commands');
});

it('keeps the prior handoff and failure count when every assigned card changes mid-run', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(2), 'low', undefined, 'the prior context');
    await run.readAll();
    const failures = (await db.prepare(`SELECT failures FROM learning_sessions WHERE session_id = 'long'`).first<{ failures: number }>())!.failures;
    expect(failures).toBeGreaterThan(0);
    await db.prepare(`UPDATE turn_cards SET input_hash = 'changed'`).run();
    expect(await run.complete('')).toEqual({ completed: true, covered: 0 });
    expect(await db.prepare(`SELECT handoff, failures FROM learning_sessions WHERE session_id = 'long'`).first()).toEqual({ handoff: 'the prior context', failures });
  });
});

it('holds one raw turn to an answer the harness keeps, and says how much it cut', async () => {
  await withDocumentStores(async (db) => {
    const key = uuid(600);
    const run = await learningRun(db, [longTurn(key, 'a turn longer than one answer', 10, 24)], 'high');
    const answer = await run.raw('myco_run_learning', { op: 'get', turn_key: key });
    expect(new TextEncoder().encode(JSON.stringify(answer.structuredContent)).length).toBeLessThanOrEqual(RUN_ANSWER_BYTES);
    expect((answer.structuredContent as { result: { raw: string } }).result.raw).toMatch(/\[… \d+ more characters\]$/);
  });
});

it('refuses a sourceless run an answer longer than its harness keeps, saying how to ask for less', async () => {
  await withDocumentStores(async (db) => {
    const run = await learningRun(db, plainTurns(1), 'low');
    await db.batch(Array.from({ length: 200 }, (_, at) => db.prepare(`INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES('project',?,'myco-agent',?,'gotcha',1)`).bind(`spr_${at}`, '増'.repeat(300))));
    expect(await run.call('myco_run_spores', { op: 'list', limit: 200 })).toMatchObject({ ok: false, code: 'answer_too_long', error: expect.stringContaining('smaller limit') });
    expect(await run.call('myco_run_spores', { op: 'list', limit: 20 })).toMatchObject({ total: 200 });
  });
});

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
    for (const stage of LEARNING_STAGES.slice(0, 2)) {
      const due = stage.due("'project'", at);
      const plan = (await db.prepare(`EXPLAIN QUERY PLAN SELECT ${due.sql}`).bind(...due.params).all<{ detail: string }>()).results.map(row => row.detail);
      expect(plan.some(detail => /SEARCH learning_sessions USING INDEX idx_learning_(cards_fresh|fresh) \(project_id=\? AND source_day=\? AND (card_ready_at|learning_ready_at)<\?\)/.test(detail))).toBe(true);
      expect(plan.some(detail => /SCAN learning_sessions\b/.test(detail))).toBe(false);
      console.info('quiet claim plan', stage.task, plan);
    }
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

it('keeps a fresh admission through four card attempts after source aging, then finishes learning or waits for history', async () => {
  for (const outcome of ['cards-exhausted', 'learning-complete', 'learning-exhausted']) await withDocumentStores(async db => {
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

it('admits long-idle and late-received sessions just before source freshness ends', async () => {
  for (const late of [false, true]) await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    await settingsWriter(db).setLeaf('agent.learning_history_enabled', false, 'owner', NOW);
    await settingsWriter(db).setLeaf('agent.titling_idle_close_minutes', late ? 120 : 1440, 'owner', NOW);
    const receipt = NOW + (late ? 23 * HOUR : 0);
    await capture(db, 'quiet-clamp', [{ id: uuid(995), text: 'Admit the quiet deadline within the source window', at: NOW }], 'project', receipt);
    await publish(db, receipt + HOUR / 4, harness.bindings.BUCKET);
    const deadline = NOW + 23 * HOUR;
    expect(await db.prepare("SELECT quiet_at,source_activity_at FROM learning_sessions WHERE session_id='quiet-clamp'").first())
      .toEqual({ quiet_at: deadline, source_activity_at: NOW });
    if (!late) expect(await harness.poll(deadline - 1)).toMatchObject({ claimed: false });
    const claimed = await harness.poll(deadline + HOUR / 2);
    if (!claimed.claimed) throw new Error('clamped quiet deadline missed source freshness');
    expect(await harness.call(claimed.run.runToken, 'myco_run_cards', { op: 'material' })).toMatchObject({ session_id: 'quiet-clamp' });
  });
});

it('keeps pending turns when the document is not live at material read or at the forget write', async () => {
  for (const mode of ['not-live', 'recovered-before-write', 'changed-after-read']) await withDocumentStores(async db => {
    const changesAfterRead = mode === 'changed-after-read';
    const keys = [uuid(1001), uuid(1002)];
    const run = await cardRun(db, keys.map((id, n) => ({ id, text: 'Keep this pending turn until its document is live', at: 10 + n })));
    if (changesAfterRead) {
      const missing = uuid(1003);
      await db.prepare("INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,due_at) VALUES('project','long',?,10,?)").bind(missing, NOW).run();
      await db.prepare("UPDATE agent_runs SET run_context=json_set(run_context,'$.assignment.turns',json(?)) WHERE id=?")
        .bind(JSON.stringify([{ turnKey: missing, changes: 0 }]), run.claimed.run.id).run();
      keys.push(missing);
      await pendingCardsStatement(db, 'project', 'long').run();
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
    } else expect(await answer.json()).toMatchObject({ error: { code: -32000, data: { code: 'tool_call_failed' } } });
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
});

it('retains the shared idle wait for a session received after its source freshness expired', async () => {
  for (const age of [24, 30]) await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    const source = NOW - age * HOUR;
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

it('admits a first fresh learning claim and retains its bounded retries after source aging', async () => {
  await withDocumentStores(async db => {
    const harness = await cardWorker(db);
    await settingsWriter(db).setLeaf('agent.learning_history_enabled', false, 'owner', NOW);
    const turn = uuid(1020);
    await capture(db, 'learning-first', [{ id: turn, text: 'Read this rule-carded session first as learning', at: NOW }], 'project', NOW);
    await db.prepare("UPDATE sessions SET ended_at=? WHERE session_id='learning-first'").bind(NOW).run();
    await publish(db, NOW + HOUR / 4, harness.bindings.BUCKET);
    expect(await cardAll(db, harness.bindings.BUCKET, 'learning-first', NOW + HOUR / 4)).toMatchObject({ written: 1 });
    expect(await db.prepare("SELECT fresh_admitted FROM learning_sessions WHERE session_id='learning-first'").first()).toEqual({ fresh_admitted: 0 });
    let at = NOW + 23.5 * HOUR;
    for (let attempt = 0; attempt < 4; attempt++) {
      const claim = await harness.poll(at);
      if (!claim.claimed) throw new Error('first-learning admission or retry missed');
      expect(claim.run.task).toBe('extract-curate');
      await harness.call(claim.run.runToken, 'myco_run_learning', { op: 'material' });
      expect(await db.prepare("SELECT fresh_admitted,source_activity_at FROM learning_sessions WHERE session_id='learning-first'").first())
        .toEqual({ fresh_admitted: 1, source_activity_at: NOW });
      expect(await endLeasedRun(harness.env, { principal: harness.principal, now: at + 1 }, {
        projectId: 'project', runId: claim.run.id, attemptId: claim.run.attemptId, status: 'failed', error: 'learning unavailable',
      })).toMatchObject({ ended: true, status: 'failed' });
      const retry = await db.prepare("SELECT eligible_at AS at FROM learning_sessions WHERE session_id='learning-first'").first<{ at: number }>();
      at = Math.max(retry!.at, NOW + DAY + 1);
    }
    expect(await harness.poll(at)).toMatchObject({ claimed: false });
    expect((await readLearningStatus(db, at)).historyWaiting).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE task='turn-cards'").first()).toEqual({ n: 0 });
  });
});

it('refuses card writes retryably if the document leaves live after reading, including at the mutation boundary', async () => {
  for (const atBatch of [false, true]) await withDocumentStores(async db => {
    const turns = plainTurns(2, 1100);
    const run = await cardRun(db, turns);
    const material = await run.readAll();
    const pending = (await db.prepare("SELECT turn_key,state,input_hash,card FROM turn_cards ORDER BY turn_key").all()).results;
    const convert = async () => { await db.prepare("UPDATE session_documents SET state='convert' WHERE session_id='long'").run(); };
    if (atBatch) run.bindings.MYCO_DB = beforeWriteBatch(db, sql => sql.includes("UPDATE turn_cards SET state = 'carded'"), convert, true);
    else await convert();
    const response = await run.harness.request(run.claimed.run.runToken, 'myco_run_cards', { op: 'write', revision: material.revision,
      cards: turns.map(turn => ({ turns: [turn.id], signal: 'high', card: EMPTY_CARD })) });
    expect(await response.json()).toMatchObject({ error: { code: -32000, data: { code: 'tool_call_failed' } } });
    const held = await db.prepare("SELECT changes FROM turn_cards WHERE session_id='long' AND turn_key=?").bind(turns[0]!.id).first<{ changes: number }>();
    await db.batch(cardStatements(db, 'project', 'long', { turnKey: turns[0]!.id, changes: held!.changes }, {
      value: EMPTY_CARD, signal: 'high', reason: 'model', sharedWith: null, covered: null, runId: run.claimed.run.id, model: 'fake',
    }, NOW + DAY));
    expect((await db.prepare("SELECT turn_key,state,input_hash,card FROM turn_cards ORDER BY turn_key").all()).results).toEqual(pending);
    expect(await db.prepare("SELECT pending_cards,due_cards FROM learning_sessions WHERE session_id='long'").first())
      .toEqual({ pending_cards: 2, due_cards: 0 });
    run.bindings.MYCO_DB = db;
    await db.prepare("UPDATE session_documents SET state='live' WHERE session_id='long'").run();
    await forgetTurnStatement(db, 'project', 'long', { turnKey: turns[0]!.id, changes: held!.changes }).run();
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
        if (timing === 'at-batch') harness.bindings.MYCO_DB = beforeWriteBatch(db, sql => sql.startsWith('UPDATE learning_sessions SET revision'), mismatch, true);
        expect(await harness.call(claim.run.runToken, 'myco_run_learning', { op: 'complete', handoff: 'discard empty handoff' }))
          .toEqual({ completed: true, covered: 0 });
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

it('learning receives and pins the optional repository before validating new knowledge against code', async () => {
  await withDocumentStores(async db => {
    const run = await learningRun(db, plainTurns(1), 'low', undefined, null, true);
    expect(run.claimed.repository).toEqual({url:'https://example.test/team/repo',branch:'main',historyDepth:1});
    expect(run.claimed.instruction).toContain('Check claims against this code before saving');
    expect(run.claimed.instructions).toContain('validate new guidance against the code now');
    expect(run.claimed.instructions).toContain('Obsolete an existing spore the code contradicts');
    const cursor=await knowledgeInputForExecution(run.env,'project','extract-curate',{
      instruction:run.claimed.instruction!,repository:run.claimed.repository,inputHash:'fixture',counts:{},
    },'cursor',WORKER_CAPABILITIES);
    expect(cursor.repository).toBeUndefined();
    expect(cursor.instruction).toContain('No usable repository checkout is available');
    expect(await prepareWorkerRepository(run.env,{worker:run.principal,clock:()=>NOW+DAY+2},{
      projectId:'project',runId:run.claimed.id,attemptId:run.claimed.attemptId,
      body:{url:'https://example.test/team/repo',branch:'main',commit:'b'.repeat(40)},
    })).toMatchObject({held:true,pin:{commit:'b'.repeat(40)}});
    await run.readAll();
    const saved=await run.save('Shared counters: increment atomically.') as {id:string};
    expect(await db.prepare('SELECT file_path FROM spores WHERE id=?').bind(saved.id).first()).toEqual({file_path:null});
  });
});

describe('learning without a repository checkout', () => {
  const check = async (scenario: { connected: boolean; harness: string; capabilities: readonly string[]; queued: boolean; unreadable?: boolean }) => {
    await withDocumentStores(async db => {
      const run=await learningRun(db,plainTurns(1),'low',undefined,null,scenario.connected,scenario);
      expect(run.claimed.harness).toBe(scenario.harness);
      expect(run.claimed).not.toHaveProperty('repository');
      expect(run.claimed.instruction).toContain('No usable repository checkout is available');
      expect(run.claimed.instruction).not.toContain('is pinned at its current commit');
      await run.readAll();
      expect(await run.save('Shared counters: increment atomically.')).toHaveProperty('id');
    });
  };

  it('claims learning without code on disconnected Codex', async () => {
    await check({connected:false,harness:'codex',capabilities:[],queued:false});
  });
  it('claims queued learning without code on Codex without checkout capability', async () => {
    await check({connected:true,harness:'codex',capabilities:[],queued:true});
  });
  it('claims learning without code on Claude Code without checkout capability', async () => {
    await check({connected:true,harness:'claude-code',capabilities:[],queued:false});
  });
  it('claims learning without code from an unreadable repository', async () => {
    await check({connected:true,harness:'claude-code',capabilities:WORKER_CAPABILITIES,unreadable:true,queued:false});
  });
});

it('continues a learning attempt after unavailable source, preserving material and recording the reason once', async () => {
  await withDocumentStores(async db => {
    const run=await learningRun(db,plainTurns(1),'low',undefined,null,true);
    const report=()=>prepareWorkerRepository(run.env,{worker:run.principal,clock:()=>NOW+DAY+2},{
      projectId:'project',runId:run.claimed.id,attemptId:run.claimed.attemptId,body:{unavailable:{code:'submodules'}},
    });
    expect(await report()).toMatchObject({held:true});
    expect(await report()).toMatchObject({held:true});
    const source=await db.prepare('SELECT instruction,run_context FROM agent_runs WHERE id=?').bind(run.claimed.id).first<{instruction:string;run_context:string}>();
    expect(source!.instruction).toContain('No usable repository checkout is available');
    expect(JSON.parse(source!.run_context)).not.toHaveProperty('checkout');
    expect((await db.prepare("SELECT payload FROM agent_run_events WHERE run_id=? AND tool_name='worker_repository'").bind(run.claimed.id).all()).results)
      .toEqual([{payload:JSON.stringify({op:'unavailable',code:'submodules'})}]);
    await run.readAll();
    expect(await run.save('Shared counters: increment atomically.')).toHaveProperty('id');
    expect(await run.complete('')).toMatchObject({completed:true});
    expect(await run.call('myco_run',{op:'report',action:'extract',summary:'Learned from the session.',audit:RUN_AUDIT})).toMatchObject({recorded:true});
    expect(await endLeasedRun(run.env,{principal:run.principal,now:NOW+DAY+3},{
      projectId:'project',runId:run.claimed.id,attemptId:run.claimed.attemptId,status:'completed',
    })).toMatchObject({status:'completed'});
  });
});


it('repairs card refusals through the next named call without losing assigned turns', async () => {
  await withDocumentStores(async db => {
    const keys = [uuid(1301),uuid(1302)];
    const run = await cardRun(db,keys.map((id,index) => ({id,text:'Repair capture delivery '+index,at:10+index})));
    const unread = JSON.parse((await run.raw({op:'write',cards:[]})).content[0]!.text) as {error:string};
    expect(unread.error).toContain('Next call: myco_run_cards {"op":"material","page":1');
    const material = await run.material();
    const check = async (cards: unknown, detail: string) => {
      const result = JSON.parse((await run.raw({op:'write',revision:material.revision,cards})).content[0]!.text) as {ok:boolean;error:string};
      expect(result.ok).toBe(false);
      expect(result.error).toContain(detail);
      expect(result.error).toContain('Next call: myco_run_cards {"op":"write"');
      expect(await db.prepare("SELECT COUNT(*) AS n FROM turn_cards WHERE state='carded'").first()).toEqual({n:0});
    };
    await check([],keys[0]!);
    await check([{signal:'high',card:EMPTY_CARD}],'cards[0].turns');
    await check([{turns:[keys[0],keys[0]],signal:'high',card:EMPTY_CARD}],keys[0]!);
    await check([{turns:[keys[0]],signal:'high',card:{...EMPTY_CARD,corrections:null}}],'corrections');
    await check([{turns:[keys[0]],signal:'high',card:{...EMPTY_CARD,outcome:[]}}],'expected a string');
    const past = await run.material({page:material.page+1,revision:material.revision});
    expect(past.error).toContain('the last valid page is');
    expect(past.error).toContain('Next call: myco_run_cards {"op":"write"');
    const good = JSON.parse((await run.raw({op:'write',revision:material.revision,cards:keys.map(key => ({turns:[key],signal:'high',card:EMPTY_CARD}))})).content[0]!.text);
    expect(good).toMatchObject({written:2});
  });
});

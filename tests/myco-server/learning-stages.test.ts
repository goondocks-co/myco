import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { learningHolds } from '@myco-server-worker/core/learning-hold.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { writeRunCards, type CardFields } from '@myco-server-worker/core/turn-cards.js';
import { trimTurn, triageTurn } from '@myco-server-worker/core/turn-card-rules.js';
import {
  learningHead, buildLearningAssignment, assignedCards, completeLearning, readLearningStatus, learningStatusLine,
} from '@myco-server-worker/core/learning-sessions.js';
import { documentTurnInput } from '@myco-server-worker/content/turn-material.js';
import type { BlobStore } from '@myco-server-worker/core/adapters.js';
import { buildCardInput } from '@myco-server-worker/core/learning-stages.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { withViewStores } from './helpers/view-stores.js';
import { beforeViewWriteBatch } from './helpers/view-instances.js';
import { envelope, memberHeaders, memoryBlobStore, recordingDeferred, recordingLimiter, uuid } from './helpers/fixtures.js';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { claimNextRun, dispatchTask, endLeasedRun } from '@myco-server-worker/core/harness.js';
import { completeBudgetMigration } from '@myco-server-worker/db/budget-activation.js';
import { EXTRACTION_RULES } from '@myco-server-worker/core/extraction-rules.js';
import { CARD_REPORT_ACTION, EXTRACTION_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { runTick } from '@myco-server-worker/core/tick.js';
import { registeredObjectKeySql } from '@myco-server-worker/core/blob-objects.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const enable = "INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')";

interface Turn {
  id: string; text: string; at: number; origin?: string; parent?: string;
  replies?: string[]; tools?: { name: string; input: unknown; output?: string; ok?: boolean; error?: string }[];
}

let serial = 0;
async function capture(db: RelationalStore, sessionId: string, turns: readonly Turn[], projectId = 'project') {
  await ensureMember(db, 'member', 1, 'member');
  const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, 1);
  const ctx = { projectId, machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: 1 };
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
  await withViewStores(async (db) => {
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

    expect(await learningHolds(db, 'project', 'session')).toBe(true);
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
    expect(await learningHolds(db, 'project', 'session')).toBe(true);
    const again = (await buildCardInput({ db }, 'project', 'session', due + HOUR))!;
    expect((again.context as { assignment: { turns: { turnKey: string }[] } }).assignment.turns.map(t => t.turnKey)).toEqual([uuid(1)]);
    expect(trimTurn((await documentTurnInput({ db, blobs }, 'project', 'session', uuid(1)))!).text).toContain('EXACT_LATE_GOTCHA: capture lease refused');

    // Deleting the session deletes its cards, which copy its words.
    await tombstoneSession({ db }, { projectId: 'project' }, 'session', 'member', NOW + 3 * HOUR);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM turn_cards WHERE session_id = 'session'`).first()).toEqual({ n: 0 });
  });
});

it('closes an all-mechanical session without a run and orders sessions newest first', async () => {
  await withViewStores(async (db) => {
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
    expect(await learningHead(db, 'project', NOW + 3 * HOUR, true)).toBe('newer');
    const status = await readLearningStatus(db);
    expect(status).toMatchObject({ resumed: true, dueSessions: 2, dueCards: 2, turnsAwaitingCards: 0, lastCompleted: { reason: 'no_signal', sessionId: 'quiet' } });
    expect(learningStatusLine(status, { dailyUsd: 20, automaticUsd: 1.5, manualUsd: 0.5 }, NOW + 120_000))
      .toBe('Learning: 2 sessions due (2 cards to learn); 0 turns waiting for their card; last session closed with nothing to learn 2 min ago; spent $2.00 of $20.00 today.');
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
  await withViewStores(async (db) => {
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
  await withViewStores(async (db) => {
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
    env.db = beforeViewWriteBatch(db, sql => sql.includes('INSERT INTO agent_runs (project_id, id, agent_id, task, status, origin, subject'), async () => { await learning(false); }, true);
    expect(await poll(at + 1)).toMatchObject({ claimed: false });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM agent_run_attempts WHERE run_id <> 'spent'`).first()).toEqual({ n: 0 });
    env.db = db;
    await learning(true);

    const cards = await poll(at + 1);
    if (!cards.claimed) throw new Error(`no card run: ${cards.reason}`);
    expect(cards.run).toMatchObject({ task: 'turn-cards', profile: { tier: 'low' } });
    const material = await call(cards.run.runToken, 'myco_run_cards', { op: 'material' }) as { turns: { turn_key: string; input: string }[] };
    expect(material.turns.map(turn => turn.turn_key)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)]);
    expect(await call(cards.run.runToken, 'myco_run_cards', { op: 'write', cards: material.turns.map(turn => ({ turns: [turn.turn_key], ...fakeCard(turn.input) })) }))
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
    expect(await call(learn.run.runToken, 'myco_spores', { op: 'save', type: 'gotcha', session_id: 'session', content: 'Tests need the pinned Bun: PATH=$HOME/tools/bun-1.4.0:$PATH npm test.' }))
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

it('with learning due and dispatch refused at the spend ceiling, claims and ticks read no session document', async () => {
  await withViewStores(async (db, name) => {
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

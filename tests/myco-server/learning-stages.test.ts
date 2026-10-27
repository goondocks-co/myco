import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { ensureAgent, recordDispatch } from '@myco-server-worker/core/runs.js';
import { learningHolds } from '@myco-server-worker/core/learning-hold.js';
import { engineAssertions } from '@myco-server-worker/core/tick.js';
import { settleTurns, writeRunCards, readTurn, type CardFields } from '@myco-server-worker/core/turn-cards.js';
import { trimTurn, triageTurn } from '@myco-server-worker/core/turn-card-rules.js';
import {
  learningInit, learningInitPending, learningHead, buildLearningAssignment, assignedCards, completeLearning,
  carryLearnedCardsStatements, readLearningStatus, learningStatusLine,
} from '@myco-server-worker/core/learning-sessions.js';
import { buildCardInput, buildLearningInput } from '@myco-server-worker/core/learning-stages.js';
import { recordServedPrompts } from '@myco-server-worker/core/served-material.js';
import { withViewStores } from './helpers/view-stores.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const enable = "INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')";
const resume = `INSERT INTO schema_meta(key,value) VALUES('learning_resumed_at','${NOW}')`;

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

async function cardAll(db: RelationalStore, sessionId: string, now: number, projectId = 'project') {
  const input = await buildCardInput({ db }, projectId, sessionId, now);
  if (input === null) return null;
  const assignment = (input.context as { assignment: { turns: { turnKey: string; changes: number }[] } }).assignment;
  const writes = [];
  for (const turn of assignment.turns) {
    const read = await readTurn(db, { projectId }, sessionId, turn.turnKey);
    writes.push({ turns: [turn.turnKey], ...fakeCard(trimTurn(read!).text) });
  }
  return writeRunCards({ db }, projectId, sessionId, assignment.turns, writes, { runId: `cards-${sessionId}`, model: 'fake' }, now);
}

async function ready(db: RelationalStore) {
  await db.prepare(enable).run();
  await db.prepare(resume).run();
  while ((await learningInit({ db }, NOW)).more);
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
    await ready(db);
    expect(await learningInitPending(db)).toBe(false);
    const due = NOW + HOUR;
    const written = await cardAll(db, 'session', due);
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
    const raw = await readTurn(db, { projectId: 'project' }, 'session', uuid(1));
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

    await db.prepare(`UPDATE tool_calls SET success = success WHERE session_id = 'session' AND prompt_id = ?`).bind(uuid(1)).run();
    expect(await learningHolds(db, 'project', 'session')).toBe(true);
    expect(await settleTurns({ db }, 'project', 'session', due + HOUR)).toMatchObject({ reused: 1, ruled: 0, forModel: [] });
    expect(await db.prepare(`SELECT state, covered FROM turn_cards WHERE turn_key = ?`).bind(uuid(1)).first()).toEqual({ state: 'carded', covered: 1 });
    expect(await buildLearningAssignment(db, 'project', 'session')).toBeNull();
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
  });
});

it('closes an all-mechanical session without a run and orders sessions newest first', async () => {
  await withViewStores(async (db) => {
    await capture(db, 'quiet', [{ id: uuid(11), text: 'continue', at: 10 }, { id: uuid(12), text: 'check status', at: 20, tools: [{ name: 'TaskOutput', input: { id: 'x' } }] }]);
    await capture(db, 'older', [{ id: uuid(21), text: 'Fix the flaky test', at: 30, replies: ['Fixed by awaiting the batch.'] }]);
    await capture(db, 'newer', [{ id: uuid(31), text: 'Add the index', at: 40, replies: ['Added idx_turn_cards_due.'] }]);
    await ready(db);
    expect(await buildCardInput({ db }, 'project', 'quiet', NOW + HOUR)).toBeNull();
    expect(await db.prepare(`SELECT last_completed_reason AS reason, eligible_at FROM learning_sessions WHERE session_id='quiet'`).first())
      .toEqual({ reason: 'no_signal', eligible_at: null });
    expect(await learningHolds(db, 'project', 'quiet')).toBe(false);
    await cardAll(db, 'older', NOW + HOUR);
    await cardAll(db, 'newer', NOW + 2 * HOUR);
    expect(await learningHead(db, 'project', NOW + 3 * HOUR, true)).toBe('newer');
    const status = await readLearningStatus(db);
    expect(status).toMatchObject({ resumed: true, dueSessions: 2, dueCards: 2, turnsAwaitingCards: 0, awaitingPublication: 0, initializing: false,
      lastCompleted: { reason: 'no_signal', sessionId: 'quiet' } });
    expect(learningStatusLine(status, { dailyUsd: 20, automaticUsd: 1.5, manualUsd: 0.5 }, NOW + HOUR + 120_000))
      .toBe('Learning: 2 sessions due (2 cards to learn); 0 turns waiting for their card; last session closed with nothing to learn 2 min ago; spent $2.00 of $20.00 today.');
  });
});

it('initializes from a cold start through its assertion and carries learned cards to an equal rebuild', async () => {
  const f = sqliteEnv();
  try {
    const db = f.db;
    await capture(db, 'session', [{ id: uuid(41), text: 'Pin bun', at: 10, replies: ['Pinned 1.4.0 in .bun-version.'] }], 'proj_1');
    await db.prepare(enable).run();
    expect(await learningInitPending(db)).toBe(false);
    await db.prepare(resume).run();
    expect((await engineAssertions(f.serverEnv, NOW)).map(a => a.name)).toContain('learning:init');
    expect(await learningInit({ db }, NOW)).toEqual({ changed: 1, more: false });
    expect((await engineAssertions(f.serverEnv, NOW)).map(a => a.name)).not.toContain('learning:init');
    await cardAll(db, 'session', NOW + HOUR, 'proj_1');
    await db.prepare(`UPDATE turn_cards SET covered = 1`).run();
    await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,state,input_hash,card,signal,covered,created_at,carded_at)
      SELECT project_id,session_id,'rebuilt','carded',input_hash,card,signal,0,created_at,carded_at FROM turn_cards`).run();
    await db.batch(carryLearnedCardsStatements(db, 'proj_1', 'session', NOW + 2 * HOUR));
    expect(await db.prepare(`SELECT covered FROM turn_cards WHERE turn_key='rebuilt'`).first()).toEqual({ covered: 1 });
    expect(await buildLearningInput(db, 'proj_1', 'session')).toBeNull();
  } finally { f.sqlite.close(); }
});

it('triages only mechanical turns by rule', () => {
  const turn = (over: Partial<Parameters<typeof triageTurn>[0]>) => ({ turnKey: 't', origin: 'user', prompt: 'continue', steering: [], replies: [], tools: [], plans: [], ...over });
  expect(triageTurn(turn({}))).toBe('no_human_text');
  expect(triageTurn(turn({ prompt: 'continue', tools: [{ toolCallId: 'x', toolName: 'Bash', input: '{"command":"npm test"}', output: 'boom', success: false, errorMessage: 'exit 1' }] }))).toBeNull();
  expect(triageTurn(turn({ prompt: 'wait for CI', tools: [{ toolCallId: 'x', toolName: 'Bash', input: '{"command":"gh pr checks 12 && sleep 30"}', output: '', success: true, errorMessage: null }] }))).toBe('polling_only');
  expect(triageTurn(turn({ prompt: 'wait for CI', tools: [{ toolCallId: 'x', toolName: 'Bash', input: '{"command":"gh pr checks 12 && git push"}', output: '', success: true, errorMessage: null }] }))).toBeNull();
  expect(triageTurn(turn({ prompt: 'continue', steering: [{ promptId: 's', text: 'no, stop' }] }))).toBeNull();
});

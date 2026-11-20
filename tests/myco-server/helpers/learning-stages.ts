import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { UNSIGNED_APP } from './github-app.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { MAX_PAYLOAD_BYTES } from '@myco-server-worker/ingest/envelope.js';
import { type CardFields } from '@goondocks/myco-shared/turn-card';
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from './member-token.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { writeRunCards, type CardMaterial } from '@myco-server-worker/core/turn-cards.js';
import { trimTurn } from '@myco-server-worker/core/turn-card-rules.js';
import { documentTurnInput } from '@myco-server-worker/content/turn-material.js';
import type { BlobStore } from '@myco-server-worker/core/adapters.js';
import { buildCardInput } from '@myco-server-worker/core/learning-stages.js';
import { envelope, memberHeaders, memoryBlobStore, recordingDeferred, recordingLimiter, uuid } from './fixtures.js';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { claimNextRun, dispatchTask, endLeasedRun } from '@myco-server-worker/core/harness.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { CARD_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import { legacyWorker } from './worker-principal.js';
import { offeredHarness } from './offered-harness.js';
import { RUN_AUDIT } from '../../helpers/run-audit.ts';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';

export const NOW = 1_800_000_000_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const enable = "INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')";

export interface Turn {
  id: string; text: string; at: number; origin?: string; parent?: string;
  replies?: string[]; tools?: { name: string; input: unknown; output?: string; ok?: boolean; error?: string }[];
}

/** One object store for capture and publication, so a payload held in it reads back wherever it is published from. */
export const BLOBS = memoryBlobStore();

export let serial = 0;
export async function capture(db: RelationalStore, sessionId: string, turns: readonly Turn[], projectId = 'project', receiptAt = NOW - 4 * HOUR) {
  await ensureMember(db, 'member', 1, 'member');
  const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, 1);
  const ctx = { projectId, machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now: receiptAt };
  const send = async (event: Record<string, unknown>) => {
    const payload = event.payload as Record<string, unknown>;
    const field = event.kind === 'prompt' || event.kind === 'response' ? 'text' : 'input';
    const text = typeof payload[field] === 'string' ? payload[field] as string : JSON.stringify(payload[field]);
    if (text !== undefined && new TextEncoder().encode(text).length > MAX_PAYLOAD_BYTES) {
      const key = await sha256Hex(text);
      const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: BLOBS, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
      const uploaded = await handleBlob(env, new Request(`https://myco.test/blobs/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: text }),
        { projectId, machineId: 'machine', tokenId: issued.tokenId, now: receiptAt, clock: () => receiptAt, contentLength: new TextEncoder().encode(text).length, params: { key } });
      const upload = await uploaded.json() as { stored: boolean; reason?: string };
      if (!upload.stored) throw new Error(upload.reason);
      delete payload[field];
      payload.blob = key;
    }
    const result = await ingestEvent(db, ctx, envelope({ eventId: uuid(100_000 + ++serial), sessionId, ...event }), { db, blobs: BLOBS });
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
export function fakeCard(input: string): { signal: 'none' | 'low' | 'high'; card: CardFields } {
  const lines = input.split('\n');
  const errors = lines.filter(line => /error|failed|Error/.test(line) && !line.startsWith('TOOL')).map(error => ({ error: error.trim(), fix: lines.find(l => /fix|works|--/.test(l) && l.startsWith('REPLY') === false && l !== error) ?? '' }));
  const commands = lines.filter(line => line.startsWith('TOOL Bash')).map(line => line.slice('TOOL Bash '.length));
  const corrections = lines.flatMap((line, i) => line === 'STEERING PROMPT:' ? [{ wrong: lines[i - 1] ?? '', right: lines[i + 1] ?? '' }] : []);
  const rejected = lines.filter(line => /instead of|rejected|not use/i.test(line)).map(line => ({ approach: line, reason: line }));
  const high = errors.length + corrections.length + rejected.length > 0 || commands.some(c => c.includes('--'));
  return { signal: high ? 'high' : 'low', card: { asked: lines[2] ?? '', done: 'worked the turn', outcome: 'done', decisions: [], rejected, errors, corrections, files: [], commands, open_questions: [] } };
}

/** Publishes every session due and settles the cards due for settlement, as the wake does. */
export async function publish(db: RelationalStore, now: number, blobs: BlobStore = BLOBS) {
  await publishDocuments({ db, blobs }, now, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
  return blobs;
}

export async function cardAll(db: RelationalStore, blobs: BlobStore, sessionId: string, now: number, projectId = 'project') {
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
export async function ready(db: RelationalStore, now = NOW): Promise<BlobStore> {
  await db.prepare(enable).run();
  return publish(db, now);
}

export const GOTCHAS: Turn[] = [
  { id: uuid(1), text: 'Run the server tests', at: NOW - DAY + 10, replies: ['The suite fails: bun needs the pinned version. The fix that works is PATH=$HOME/tools/bun-1.4.0:$PATH npm test.'],
    tools: [{ name: 'Bash', input: { command: 'npm test -- tests/server.test.ts' }, ok: false, error: 'exit 1',
      output: `${'ok line\n'.repeat(300)}error: Cannot find module '@myco-server-worker/core/x.js' from 'tests/a.test.ts'\n${'ok line\n'.repeat(200)}` }] },
  { id: uuid(2), text: 'Store the cursor in schema_meta', at: NOW - DAY + 20, replies: ['Using schema_meta instead of agent_state, rejected agent_state because it is per Project and the cursor is Deployment-wide.'] },
  { id: uuid(3), text: 'Deploy the worker', at: NOW - DAY + 30, replies: ['Deployed.'],
    tools: [{ name: 'Bash', input: { command: 'npx wrangler deploy --minify --compatibility-date=2026-08-01' }, output: 'Uploaded myco (1.2 sec)' }] },
  { id: uuid(4), text: 'Delete the old rows', at: NOW - DAY + 40, replies: ['Deleting with DELETE FROM runs.'] },
  { id: uuid(5), text: 'no, don\'t delete them; archive them with myco server archive --keep', at: NOW - DAY + 41, parent: uuid(4) },
  { id: uuid(6), origin: 'system', text: '<task-notification><status>completed</status></task-notification>', at: NOW - DAY + 50, replies: ['Noted.'] },
  { id: uuid(7), text: 'check CI', at: NOW - DAY + 60, tools: [{ name: 'Bash', input: { command: 'gh run watch 123' }, output: 'completed success' }] },
];

export const failedCommand = (at: number, chars: number) => ({ name: 'Bash', input: { command: `echo ${at} ${'é"\n'.repeat(chars / 3)}` }, ok: false, error: `exit ${at}` });

export const EMPTY_CARD: CardFields = { asked: 'a turn', done: 'routine work', outcome: 'done', decisions: [], rejected: [], errors: [], corrections: [], files: [], commands: [], open_questions: [] };
export interface MaterialAnswer { revision: string; page: number; next_page?: number; code?: string; error?: string; turns: CardMaterial[] }

/** A card worker with calls through the real `/mcp` route. */
export async function cardWorker(db: RelationalStore) {
  const bindings = { MYCO_DB: db, BUCKET: BLOBS, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter(), ...UNSIGNED_APP };
  const env = serverEnvFromBindings(bindings as never, recordingDeferred());
  await db.prepare(enable).run();
  await db.prepare(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.harnesses.claude-code.credential','"worker-login"',0,'test')`).run();
  await db.prepare(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','agent','built-in',1,1)`).run();
  await completeBudgetMigration(db, NOW);
  await ensureMember(db, 'mem_worker', NOW, 'admin');
  const principal = legacyWorker((await issueMemberToken(db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId, 'm1');
  const poll = (now: number) => claimNextRun(env, { principal, harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now });
  const request = (token: string, name: string, input: Record<string, unknown>, projectId = 'project') => worker.fetch(new Request('https://myco.test/mcp', {
    method: 'POST', headers: memberHeaders(token, { [PROJECT_HEADER]: projectId }),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }),
  }), bindings as never);
  const call = async (token: string, name: string, input: Record<string, unknown>, projectId = 'project') => {
    const body = await (await request(token, name, input, projectId)).json() as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as Record<string, unknown>;
  };
  return { bindings, env, principal, poll, request, call };
}

export async function cardRun(db: RelationalStore, turns: readonly Turn[]) {
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
  const readSource = async (key: string) => {
    let cursor: string | undefined;
    let text = '';
    do {
      const answer = JSON.parse((await raw({ op: 'get', turn_key: key, ...(cursor === undefined ? {} : { cursor }) })).content[0]!.text);
      if (answer.ok === false) throw new Error(answer.error);
      text += answer.raw;
      cursor = answer.next_cursor;
    } while (cursor !== undefined);
    return text;
  };
  const readAll = async () => {
    const inputs = new Map<string, string>();
    const incomplete = new Set<string>();
    let answer = await material();
    for (;;) {
      for (const turn of answer.turns) {
        inputs.set(turn.turn_key, (inputs.get(turn.turn_key) ?? '') + turn.input);
        if (turn.complete === false && turn.partial_reason === undefined) incomplete.add(turn.turn_key);
      }
      if (answer.next_page === undefined) {
        for (const key of incomplete) await readSource(key);
        return { inputs, revision: answer.revision, pages: answer.page };
      }
      answer = await material({ page: answer.next_page, revision: answer.revision });
    }
  };
  return { bindings, env, raw, material, write, readAll, readSource, principal, claimed, harness };
}

export const longTurn = (id: string, text: string, at: number, calls: number): Turn => ({ id, text, at, tools: Array.from({ length: calls }, (_, call) => failedCommand(call, 1_900)) });

export const heavyCard = (text: string, chars: number): string => text.repeat(Math.floor(chars / text.length));

export interface LearningPage { session_id: string; handoff?: string | null; more_slices?: boolean; changed_since_assignment?: number; revision: string; page: number; next_page?: number; cards: { turn_key: string; signal: string; card: string; continues?: true }[] }

/** A claimed learning run over these turns, each carded by its own card run as `cardOf` says, called through the real `/mcp` route. */
export async function learningRun(db: RelationalStore, turns: readonly Turn[], signal: 'low' | 'high', cardTextOf?: (key: string) => string, handoff: string | null = null, connected = false, execution: {harness?:string;capabilities?:readonly string[];unreadable?:boolean;queued?:boolean} = {}) {
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
  if (connected) await db.prepare(`INSERT INTO project_repositories(project_id,revision,url,branch,github_repository_id,github_installation_id,updated_at,updated_by)
    VALUES('project','connection','https://github.com/example/source','main',1296269,41,1,'test')`).run();
  const harness=execution.harness ?? 'claude-code';
  if (harness === 'codex') await settingsWriter(db).setLeaf('agent.tasks',{'extract-curate':{harness,model:'gpt-6',reasoningLevel:'default'}},'member',NOW+DAY+2);
  if (execution.queued) expect(await dispatchTask(env,'extract-curate','project',{serverUrl:'https://myco.test',actor:'member',params:{session_id:'long'}},NOW+DAY+2)).toMatchObject({dispatched:true});
  // Without an App key, the stored connection cannot be read, so the run is knowledge-only.
  const learn = await claimNextRun(execution.unreadable ? { ...env, secrets: {} } : env, { principal, harnesses: [offeredHarness(harness)], capabilities: execution.capabilities ?? WORKER_CAPABILITIES, now: NOW + DAY + 2 });
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

export const plainTurns = (count: number, base = 500): Turn[] => Array.from({ length: count }, (_, at) => ({ id: uuid(base + at), text: `Work on the part ${at}`, at: NOW - DAY + 10 + at, replies: ['Done.'] }));

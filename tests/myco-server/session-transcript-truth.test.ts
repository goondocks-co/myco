import { expect, test } from 'bun:test';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { endLeasedRun } from '@myco-server-worker/core/harness.js';
import { CARD_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { cardWorker, fakeCard, DAY, HOUR } from './helpers/learning-stages.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import worker from '@myco-server-worker/index.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { envelope, memberPost, sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import { issueMemberToken } from './helpers/member-token.js';
import { launchParentSession } from '@myco/member/session-lineage.js';

const instant = '2026-01-01T00:00:00Z';
const row = (type: string, payload: Record<string, unknown>) => ({ type, timestamp: instant, payload });
const message = (role: string, text: string) => row('response_item', { type: 'message', role, content: [{ type: 'text', text }] });
const codex = [
  row('event_msg', { type: 'task_started', turn_id: 'turn-a' }), message('user', '<relay sender="planner">Read the task</relay>'),
  row('response_item', { type: 'custom_tool_call', call_id: 'wrapper', name: 'exec', input: 'tools.exec_command({cmd:"false"})' }),
  row('event_msg', { type: 'item_completed', turn_id: 'turn-a', item: { type: 'CommandExecution', id: 'command', command: 'false', status: 'failed', exit_code: 1, aggregated_output: 'command failed' } }),
  row('response_item', { type: 'custom_tool_call_output', call_id: 'wrapper', output: [{ type: 'text', text: 'Script completed' }] }),
  row('response_item', { type: 'custom_tool_call', call_id: 'patch', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: alpha.txt\n+alpha\n*** Add File: beta.txt\n+beta\n*** End Patch' }),
  row('response_item', { type: 'custom_tool_call_output', call_id: 'patch', output: 'Success' }), message('assistant', 'Added the files'),
  row('event_msg', { type: 'task_complete', turn_id: 'turn-a' }), row('compacted', { message: 'compact context' }),
  row('event_msg', { type: 'task_started', turn_id: 'turn-b' }), message('user', '<relay sender="reviewer">Check the result</relay>'),
  row('event_msg', { type: 'item_completed', turn_id: 'turn-b', item: { type: 'McpToolCall', id: 'search', server: 'myco', tool: 'myco_search', arguments: { query: 'result' }, status: 'completed', result: { content: [] } } }),
  message('assistant', 'Checked'), row('event_msg', { type: 'task_complete', turn_id: 'turn-b' }),
];
const claude = [
  { type: 'user', uuid: 'person-a', promptId: 'prompt-a', message: { content: 'Write a file' } },
  { type: 'assistant', uuid: 'write', message: { content: [{ type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'alpha.txt', content: 'alpha' } }] } },
  { type: 'user', uuid: 'written', message: { content: [{ type: 'tool_result', tool_use_id: 'write', is_error: false, content: 'Saved' }] } },
  { type: 'assistant', uuid: 'delegate', message: { content: [{ type: 'tool_use', id: 'delegate', name: 'Agent', input: { prompt: 'Review the file' } }] } },
  { type: 'user', uuid: 'delegated', message: { content: [{ type: 'tool_result', tool_use_id: 'delegate', is_error: false, content: 'Reviewed' }] } },
  { type: 'user', uuid: 'compact', isCompactSummary: true, message: { content: 'A file was written' } },
  { type: 'user', uuid: 'reminder', isMeta: true, message: { content: '<system-reminder>Keep the workspace clean</system-reminder>' } },
  { type: 'user', uuid: 'person-b', promptId: 'prompt-b', message: { content: 'Read the memory' } },
  { type: 'assistant', uuid: 'recall', message: { content: [{ type: 'tool_use', id: 'recall', name: 'myco_search', input: { query: 'file' } }] } },
  { type: 'user', uuid: 'recalled', message: { content: [{ type: 'tool_result', tool_use_id: 'recall', is_error: true, content: 'Unavailable' }] } },
  { type: 'assistant', uuid: 'reply', message: { content: [{ type: 'text', text: 'The search failed' }] } },
].map(value => ({ ...value, timestamp: instant }));

for (const [agent, records, calls, edits] of [
  ['codex', codex, [3, 1], 2], ['claude-code', claude, [2, 1], 1],
] as const) test(`${agent}: captured transcript publishes truthful session numbers and turn ownership`, async () => {
  const fixture = sqliteEnv();
  const now = Date.now();
  const issued = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine' }, now);
  const get = async (session: string, path = '') => {
    const response = await worker.fetch(await asOwner(fixture.db, `/api/projects/proj_1/sessions/${session}${path}`), { ...fixture.env, ...OWNER_ENV });
    expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  };
  try {
    for (const parent of [undefined, 'parent-session']) {
      const session = parent === undefined ? 'person-session' : 'agent-session';
      const launchParentSessionId = launchParentSession(session, parent === undefined ? {} : { BAGGAGE: `gen_ai.conversation.id=${parent}` });
      const started = await worker.fetch(memberPost(issued.token, envelope({ eventId: crypto.randomUUID(), sessionId: session, kind: 'session.start', createdAt: now,
        payload: { agent, startedAt: now, launchParentSessionId } })), fixture.env);
      expect((await started.json() as { persisted: boolean }).persisted).toBe(true);
      const env = await captureDocumentTranscript(fixture.db, fixture.bucket, session, `tx_${(parent === undefined ? 'a' : 'b').repeat(32)}`,
        records.map(value => JSON.stringify(value)).join('\n') + '\n', now, 0, agent, 'proj_1');
      for (let pass = 0; pass < 20; pass++) {
        const result = await publishDocuments(env, now + 700_000, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
        if (!result.more) break;
      }
      const header = await get(session);
      const mcpResponse = await worker.fetch(memberPost(issued.token, { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'myco_sessions', arguments: { project: 'proj_1', op: 'get', id: session } } }, '/mcp'), fixture.env);
      expect(mcpResponse.status).toBe(200);
      const mcp = await mcpResponse.json() as { result: { structuredContent: { result: { counts: unknown } } } };
      expect(mcp.result.structuredContent.result.counts).toEqual(header.counts);
      const turns = (await get(session, '/turns?origins=user,system,agent_dispatch,hook_injected,unknown')).rows;
      expect(header.counts).toMatchObject({ prompts: 2, userPrompts: parent === undefined ? 2 : 0, toolCalls: calls[0] + calls[1], failedTools: 1, mycoCalls: 1, plans: 0, attachments: 0 });
      expect(header.filesEdited).toBeNull();
      expect(header.observedFilesEdited).toBe(edits);
      expect(header.fileEdits).toEqual({ state: 'unknown', observed: edits });
      expect(turns.map((turn: any) => [turn.origin, turn.toolCallCount])).toEqual(calls.map(count => [parent === undefined ? 'user' : 'agent_dispatch', count]));
      const detail = await get(session, `/turns/${turns[0].promptId}`);
      expect(detail.prompt.originSessionId).toBe(parent ?? null);
      if (agent === 'codex') expect([detail.prompt.text, detail.prompt.envelope]).toEqual(['Read the task', { name: 'relay', attributes: 'sender="planner"' }]);
      expect((await get(session, '/turns?origins=user')).rows.length).toBe(parent === undefined ? 2 : 0);
      expect((await get(session, '/files?kind=edited')).files.map((file: any) => file.path)).toEqual(agent === 'codex' ? ['alpha.txt', 'beta.txt'] : ['alpha.txt']);
      const lineage = await get(session, '/lineage');
      expect(lineage.edges.map((edge: any) => [edge.kind, edge.parentId, edge.childId])).toEqual(parent === undefined ? [] : [['launched', parent, session]]);
    }
  } finally { fixture.sqlite.close(); }
});

test('Cursor transcript-only numbers distinguish unseen tools and edits from zero', async () => {
  const fixture = sqliteEnv();
  try {
    const env = await captureDocumentTranscript(fixture.db, fixture.bucket, 'unseen-session', `tx_${'d'.repeat(32)}`,
      JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: '<user_query>Read the task</user_query>' }] } }) + '\n',
      Date.now(), 0, 'cursor', 'proj_1');
    await publishDocuments(env, Date.now() + 700_000, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
    const response = await worker.fetch(await asOwner(fixture.db, '/api/projects/proj_1/sessions/unseen-session'), { ...fixture.env, ...OWNER_ENV });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filesEdited: null, observedFilesEdited: 0, fileEdits: { state: 'not_visible' },
      counts: { toolCalls: null, failedTools: null, mycoCalls: null },
      visibility: { toolCalls: 'not_visible', failedTools: 'not_visible', mycoCalls: 'not_visible', filesEdited: 'not_visible' } });
  } finally { fixture.sqlite.close(); }
});

test('a hook-written instruction uses the same launch origin as a parsed instruction', async () => {
  const fixture = sqliteEnv();
  try {
    const issued = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine' }, Date.now());
    for (const [kind, payload] of [
      ['session.start', { agent: 'windsurf', launchParentSessionId: launchParentSession('hook-session', { BAGGAGE: 'gen_ai.conversation.id=parent-session' }) }],
      ['prompt', { promptId: crypto.randomUUID(), text: '<relay sender="planner">Read the task</relay>', origin: 'user' }],
    ] as const) {
      const response = await worker.fetch(memberPost(issued.token, envelope({ eventId: crypto.randomUUID(), sessionId: 'hook-session', kind, payload })), fixture.env);
      expect((await response.json() as { persisted: boolean }).persisted).toBe(true);
    }
    await publishDocuments(fixture.serverEnv, Date.now(), { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
    const response = await worker.fetch(await asOwner(fixture.db, '/api/projects/proj_1/sessions/hook-session/turns?origins=agent_dispatch'), { ...fixture.env, ...OWNER_ENV });
    expect(response.status).toBe(200);
    expect((await response.json() as { rows: { origin: string; preview: string }[] }).rows).toMatchObject([{ origin: 'agent_dispatch', preview: 'Read the task' }]);
  } finally { fixture.sqlite.close(); }
});


test('parent-bearing and person sessions title and learn their three instructions', async () => {
  for (const parent of [undefined, 'parent-session']) await withDocumentStores(async db => {
    const now = Date.now();
    const harness = await cardWorker(db, now);
    const session = parent === undefined ? 'person-work' : 'delegated-work';
    await ensureMember(db, 'member', now, 'member');
    const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
    const started = await worker.fetch(memberPost(issued.token, envelope({ eventId: crypto.randomUUID(), sessionId: session,
      kind: 'session.start', createdAt: now, payload: { agent: 'codex', startedAt: now - DAY,
        launchParentSessionId: launchParentSession(session, parent === undefined ? {} : { BAGGAGE: `gen_ai.conversation.id=${parent}` }) } }),
      '/events', { [PROJECT_HEADER]: 'project' }), harness.bindings);
    expect((await started.json() as { persisted: boolean }).persisted).toBe(true);
    const instructions = ['Inspect the query', 'Replace the slow query', 'Verify the new query'];
    const records = instructions.flatMap((text, index) => {
      const timestamp = new Date(now - DAY + index * 1000).toISOString();
      const event = (type: string) => ({ type: 'event_msg', timestamp, payload: { type, turn_id: `turn-${index}` } });
      const prompt = index === 0 ? text : `<relay sender="planner">${text}</relay>`;
      return [event('task_started'), { ...message('user', prompt), timestamp },
        { ...message('assistant', 'Rejected the slow query and verified its replacement'), timestamp }, event('task_complete')];
    });
    const env = await captureDocumentTranscript(db, harness.bindings.BUCKET, session, `tx_${'e'.repeat(32)}`,
      records.map(record => JSON.stringify(record)).join('\n') + '\n', now, 0, 'codex');
    await publishDocuments(env, now + HOUR, { calls: 500, deadline: Date.now() + 60_000, clock: Date.now });
    const ended = await worker.fetch(memberPost(issued.token, envelope({ eventId: crypto.randomUUID(), sessionId: session, kind: 'session.end',
      createdAt: now, payload: { endedAt: now } }), '/events', { [PROJECT_HEADER]: 'project' }), harness.bindings);
    expect((await ended.json() as { persisted: boolean }).persisted).toBe(true);
    let material = '';
    harness.env.completionProvider = async () => ({ model: '@cf/openai/gpt-oss-20b', complete: async request => {
      material = request.messages.map(message => message.content).join('\n');
      return { text: JSON.stringify({ title: 'Improved the query', summary: 'Inspected, replaced and verified the query.' }), usage: null };
    } });
    const pending: Promise<void>[] = [];
    harness.env.afterResponse = work => { pending.push(work()); };
    expect(await titleSession(harness.env, { projectId: 'project', sessionId: session, now: now + HOUR, origin: 'https://myco.test' }))
      .toMatchObject({ outcome: 'dispatched' });
    await Promise.all(pending);
    for (const instruction of instructions) expect(material).toContain(instruction);
    expect(material).toContain(parent === undefined ? '[Person]' : '[Another agent]');
    const header = await harness.call(issued.token, 'myco_sessions', { project: 'project', op: 'get', id: session });
    expect(header).toMatchObject({ title: 'Improved the query', summary: 'Inspected, replaced and verified the query.',
      counts: { prompts: 3, userPrompts: parent === undefined ? 3 : 0 } });
    const cards = await harness.poll(now + HOUR);
    if (!cards.claimed) throw new Error(`No card run: ${cards.reason}`);
    expect(cards.run.task).toBe('turn-cards');
    const input = await harness.call(cards.run.runToken, 'myco_run_cards', { op: 'material' }) as { revision: string; turns: { turn_key: string; input: string }[] };
    expect(input.turns).toHaveLength(3);
    for (const turn of input.turns) await harness.call(cards.run.runToken, 'myco_run_cards', { op: 'get', turn_key: turn.turn_key });
    expect(await harness.call(cards.run.runToken, 'myco_run_cards', { op: 'write', revision: input.revision,
      cards: input.turns.map(turn => ({ turns: [turn.turn_key], ...fakeCard(turn.input) })) })).toMatchObject({ written: 3 });
    await harness.call(cards.run.runToken, 'myco_run', { op: 'report', action: CARD_REPORT_ACTION, summary: 'Carded the instructions', audit: RUN_AUDIT });
    expect(await endLeasedRun(harness.env, { principal: harness.principal, now: now + HOUR + 1 },
      { projectId: 'project', runId: cards.run.id, attemptId: cards.run.attemptId, status: 'completed' })).toEqual({ ended: true, status: 'completed' });
    const learning = await harness.poll(now + HOUR + 2);
    if (!learning.claimed) throw new Error(`No extraction run: ${learning.reason}`);
    expect(learning.run.task).toBe('extract-curate');
    const learned = await harness.call(learning.run.runToken, 'myco_run_learning', { op: 'material' }) as { session_id: string; cards: unknown[] };
    expect(learned.session_id).toBe(session);
    expect(learned.cards).toHaveLength(3);
    expect(await harness.call(learning.run.runToken, 'myco_run_learning', { op: 'complete', handoff: '' })).toEqual({ completed: true, covered: 3 });
  });
});

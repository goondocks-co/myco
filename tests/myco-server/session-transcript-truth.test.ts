import { expect, test } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { captureDocumentTranscript } from './helpers/document-stores.js';
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
    expect(await response.json()).toMatchObject({ filesEdited: null, observedFilesEdited: 0,
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

/**
 * `POST /mcp` through the deployed entry: the member tool surface as a client
 * meets it. JSON-RPC in, JSON-RPC out; every refusal an error envelope whose
 * `data.code` the member-side CLI classifies; every result the shape the
 * member-side tool answers.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { MEMBER_TOKEN_BYTE_QUOTA, PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { MAX_SPORE_CONTENT_BYTES } from '@myco-server-worker/core/spores.js';
import { archiveProject } from '@myco-server-worker/read/sessions.js';
import { upsertDigest } from '@myco-server-worker/core/digests.js';
import { insertSkillRecord } from '@myco-server-worker/core/skills.js';
import { uuidv5 } from '@myco-server-worker/hash.js';
import { TOOL_DEFINITIONS } from '@myco-server-worker/mcp/definitions.js';
import { NO_DIGEST_MESSAGE } from '@myco-server-worker/mcp/tools/cortex.js';
import { FIRST_MODERN_REVISION, SERVED_PROTOCOL_VERSIONS } from '@myco-server-worker/mcp/server.js';
import { issueExternalGrant, revokeExternalGrant, rotateExternalGrant } from '@myco-server-worker/auth/grants.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { EXTERNAL_TOOLS, externalDefinitions, isExternalCall } from '@myco-server-worker/mcp/external.js';
import { grantToolContext, memberOf } from '@myco-server-worker/mcp/context.js';
import { handlePlans } from '@myco-server-worker/mcp/tools/plans.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { TASK_TOOLS } from '@myco-server-worker/core/task-catalogue.js';
import type { ServedTool } from '@myco-server-worker/core/tool-catalogue.js';
import { NO_OP, TOOL_REGISTRY, opOf } from '@myco-server-worker/mcp/registry.js';
import { runAllowlist, runDefinitions } from '@myco-server-worker/mcp/run-surface.js';
import { NO_LIVE_RUN, RUN_PROJECT_MISMATCH, RUN_SCOPE } from '@myco-server-worker/pipeline.js';
import { envelope, memberHeaders, sqliteEnv } from './helpers/fixtures.js';

const rpc = (method: string, params?: unknown, id: number = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const post = (token: string, body: string, extra: Record<string, string> = {}) => new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token, extra), body });

async function setup() {
  const e = sqliteEnv();
  const now = Date.now();
  const t1 = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const t2 = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now);
  const call = async (token: string, name: string, args: Record<string, unknown> = {}, extra: Record<string, string> = {}) => {
    const res = await worker.fetch(post(token, rpc('tools/call', { name, arguments: args }), extra), e.env);
    const body = await res.json() as any;
    return { status: res.status, body, result: body.result?.structuredContent?.result, error: body.error };
  };
  return { ...e, now, t1, t2, call };
}

describe('POST /mcp', () => {
  it('refuses a request without a credential with 401, and one without a Project header as a JSON-RPC error at 400', async () => {
    const { env, t1 } = await setup();
    const anonymous = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4' }, body: rpc('tools/list') }), env);
    expect(anonymous.status).toBe(401);
    const noProject = await worker.fetch(post(t1.token, rpc('tools/list'), { [PROJECT_HEADER]: '' }), env);
    expect(noProject.status).toBe(400);
    const body = await noProject.json() as any;
    expect({ jsonrpc: body.jsonrpc, id: body.id, code: body.error.data.code }).toEqual({ jsonrpc: '2.0', id: null, code: 'no_project' });
  });

  it('refuses a body that is not JSON-RPC as a parse error at 400, in the same envelope', async () => {
    const { env, t1 } = await setup();
    for (const body of ['not json', '{"hello":1}', '[]']) {
      const res = await worker.fetch(post(t1.token, body), env);
      const answer = await res.json() as any;
      expect({ body, status: res.status, code: answer.error?.data?.code }).toEqual({ body, status: 400, code: 'parse' });
    }
  });

  it('lists the seven tools as the definitions declare them', async () => {
    const { env, t1 } = await setup();
    const res = await worker.fetch(post(t1.token, rpc('tools/list')), env);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.result.tools).toEqual(TOOL_DEFINITIONS.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations })));
  });

  it('answers an unknown tool, bad arguments, an undeclared op and a not-yet-served op as JSON-RPC errors named in data.code', async () => {
    const { call, t1 } = await setup();
    expect((await call(t1.token, 'myco_nope')).error.data.code).toBe('unknown_tool');
    expect((await call(t1.token, 'myco_search')).error.data.code).toBe('invalid_input');
    expect((await call(t1.token, 'myco_sessions', { op: 'purge' })).error.data.code).toBe('invalid_input');
    expect((await call(t1.token, 'myco_search', { query: 'anything' })).result).toMatchObject({ results: [], mode: 'fts', provider_unavailable: true });
    const never = await call(t1.token, 'myco_plans', { op: 'delete', id: 'x' });
    expect({ code: never.error.data.code, offered: /not offered/.test(never.error.message) }).toEqual({ code: 'not_served', offered: true });
    expect((await call(t1.token, 'myco_cortex', { op: 'canopy_entry' })).error.data.code).toBe('not_served');
  });

  it('records, reads, lists, supersedes and consolidates spores under the built-in user agent', async () => {
    const { call, sqlite, t1 } = await setup();
    const saved = (await call(t1.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'the first thing', tags: ['a', 'b'] })).result;
    expect({ type: saved.observation_type, status: saved.status, shape: /^gotcha-[0-9a-f]{8}$/.test(saved.id) }).toEqual({ type: 'gotcha', status: 'active', shape: true });
    expect((sqlite.query(`SELECT agent_id, session_id, tags FROM spores WHERE id = ?`).get(saved.id) as any)).toEqual({ agent_id: 'user', session_id: null, tags: 'a, b' });

    const got = (await call(t1.token, 'myco_spores', { op: 'get', id: saved.id })).result;
    expect({ id: got.id, observation_type: got.observation_type, content: got.content, superseded_by: got.superseded_by }).toEqual({ id: saved.id, observation_type: 'gotcha', content: 'the first thing', superseded_by: [] });

    const second = (await call(t1.token, 'myco_spores', { op: 'save', type: 'decision', content: 'the second thing' })).result;
    const superseded = (await call(t1.token, 'myco_spores', { op: 'supersede', old_spore_id: saved.id, new_spore_id: second.id, reason: 'replaced' })).result;
    expect(superseded).toEqual({ old_spore: saved.id, new_spore: second.id, status: 'superseded' });
    expect((await call(t1.token, 'myco_spores', { op: 'get', id: saved.id })).result.superseded_by).toEqual([second.id]);
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events WHERE spore_id = ?`).get(saved.id) as any).c).toBe(1);

    const listed = (await call(t1.token, 'myco_spores', { op: 'list', status: 'active' })).result;
    expect({ total: listed.total, ids: listed.spores.map((s: any) => s.id) }).toEqual({ total: 1, ids: [second.id] });

    const consolidated = (await call(t1.token, 'myco_spores', { op: 'consolidate', source_spore_ids: [second.id], consolidated_content: 'wisdom', observation_type: 'wisdom' })).result;
    expect({ sources: consolidated.sources_consolidated, status: consolidated.status }).toEqual({ sources: 1, status: 'consolidated' });
    expect((sqlite.query(`SELECT status FROM spores WHERE id = ?`).get(second.id) as any).status).toBe('consolidated');

    expect((await call(t1.token, 'myco_spores', { op: 'get', id: 'nope' })).result).toEqual({ ok: false, error: 'Spore not found' });
    expect((await call(t1.token, 'myco_spores', { op: 'obsolete', id: 'nope', reason: 'r' })).result).toEqual({ ok: false, error: 'spore_id not found' });
  });

  it('files a spore under the session the caller names, with that session\'s latest prompt, and answers one refusal for every id the caller\'s machine does not hold', async () => {
    const { call, sqlite, t1, t2 } = await setup();
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES ('proj_1', 'sess_mine', 'machine_1', ?, 1000, 1000)`).run(t1.tokenId);
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES ('proj_1', 'sess_theirs', 'machine_2', ?, 1000, 1000)`).run(t2.tokenId);
    const prompt = sqlite.query(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, content_hash, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', ?, 'sess_mine', ?, 'user', 'h', ?, ?, ?, ?)`);
    prompt.run('p_first', 'e1', 1_000, 1_000, t1.tokenId, 1_000);
    prompt.run('p_last', 'e2', 2_000, 2_000, t1.tokenId, 2_000);

    const saved = (await call(t1.token, 'myco_spores', { op: 'save', type: 'decision', content: 'named', session_id: 'sess_mine' })).result;
    expect(sqlite.query(`SELECT session_id, prompt_id FROM spores WHERE id = ?`).get(saved.id)).toEqual({ session_id: 'sess_mine', prompt_id: 'p_last' });

    const refusal = { ok: false, error: 'session_id not found' };
    expect((await call(t1.token, 'myco_spores', { op: 'save', type: 'decision', content: 'x', session_id: 'sess_nowhere' })).result).toEqual(refusal);
    expect((await call(t1.token, 'myco_spores', { op: 'save', type: 'decision', content: 'x', session_id: 'sess_theirs' })).result).toEqual(refusal);
    expect((sqlite.query(`SELECT COUNT(*) c FROM spores WHERE content = 'x'`).get() as any).c).toBe(0);

    const second = (await call(t1.token, 'myco_spores', { op: 'save', type: 'decision', content: 'replacement', session_id: 'sess_mine' })).result;
    expect((await call(t1.token, 'myco_spores', { op: 'supersede', old_spore_id: saved.id, new_spore_id: second.id, session_id: 'sess_theirs' })).result).toEqual(refusal);
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events`).get() as any).c).toBe(0);

    expect((await call(t1.token, 'myco_spores', { op: 'supersede', old_spore_id: saved.id, new_spore_id: second.id, session_id: 'sess_mine' })).result.status).toBe('superseded');
    expect(sqlite.query(`SELECT session_id FROM resolution_events WHERE spore_id = ?`).get(saved.id)).toEqual({ session_id: 'sess_mine' });

    const got = (await call(t1.token, 'myco_spores', { op: 'get', id: second.id })).result;
    expect({ predecessors: got.predecessors, superseded_by: got.superseded_by }).toEqual({ predecessors: [saved.id], superseded_by: [] });
  });

  it('carries the named session onto a consolidation, its wisdom row and every source event alike, and refuses to retire a spore in another machine\'s session', async () => {
    const { call, sqlite, t1, t2 } = await setup();
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES ('proj_1', 'sess_mine', 'machine_1', ?, 1000, 1000)`).run(t1.tokenId);
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES ('proj_1', 'sess_theirs', 'machine_2', ?, 1000, 1000)`).run(t2.tokenId);
    sqlite.query(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, content_hash, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', 'p_only', 'sess_mine', 'e1', 'user', 'h', 1000, 1000, ?, 1000)`).run(t1.tokenId);
    const a = (await call(t1.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'a' })).result;
    const b = (await call(t1.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'b' })).result;

    const merged = (await call(t1.token, 'myco_spores', { op: 'consolidate', source_spore_ids: [a.id, b.id], consolidated_content: 'wisdom', observation_type: 'wisdom', session_id: 'sess_mine' })).result;
    expect(merged.sources_consolidated).toBe(2);
    expect(sqlite.query(`SELECT session_id, prompt_id FROM spores WHERE id = ?`).get(merged.new_spore_id)).toEqual({ session_id: 'sess_mine', prompt_id: 'p_only' });
    expect(sqlite.query(`SELECT session_id, COUNT(*) c FROM resolution_events WHERE new_spore_id = ? GROUP BY session_id`).get(merged.new_spore_id)).toEqual({ session_id: 'sess_mine', c: 2 });

    const third = (await call(t1.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'c' })).result;
    expect((await call(t1.token, 'myco_spores', { op: 'obsolete', id: third.id, reason: 'gone', session_id: 'sess_theirs' })).result).toEqual({ ok: false, error: 'session_id not found' });
    expect(sqlite.query(`SELECT status FROM spores WHERE id = ?`).get(third.id)).toEqual({ status: 'active' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events WHERE spore_id = ?`).get(third.id) as any).c).toBe(0);
  });

  it('saves a plan by its file on the key a member hook derives, updates it on a second save, and reads it back with its content and tags', async () => {
    const { call, sqlite, t1 } = await setup();
    const first = (await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', source_path: 'docs/plans/x.md', content: '- [x] one\n- [ ] two', title: 'X', tags: ['t1'] })).result;
    expect({ ok: first.ok, id: first.id, logical_key: first.logical_key, status: first.status, tags: first.tags, session: first.session_id }).toEqual({ ok: true, id: await uuidv5('plan', 'proj_1', 'docs/plans/x.md'), logical_key: 'path:docs/plans/x.md', status: 'active', tags: ['t1'], session: 'sess_a' });

    const listed = (await call(t1.token, 'myco_plans', { op: 'list' })).result;
    expect(listed).toEqual([{ id: first.id, title: 'X', status: 'active', progress: '1/2', prompt_id: null, tags: ['t1'], created_at: first.created_at }]);

    expect((await call(t1.token, 'myco_plans', { op: 'save', id: first.id, status: 'in_progress' })).result).toEqual({ ok: false, error: 'session_id is required for op: save' });
    const updated = (await call(t1.token, 'myco_plans', { op: 'save', id: first.id, session_id: 'sess_a', status: 'in_progress' })).result;
    expect({ ok: updated.ok, id: updated.id, status: updated.status, title: updated.title }).toEqual({ ok: true, id: first.id, status: 'in_progress', title: 'X' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM plans`).get() as any).c).toBe(1);

    expect((await call(t1.token, 'myco_plans', { op: 'save', id: first.id, session_id: 'sess_a', status: 'all' })).result).toEqual({ ok: false, error: 'status must be one of: active, in_progress, completed, abandoned' });
    const got = (await call(t1.token, 'myco_plans', { op: 'get', id: first.id })).result;
    expect({ content: got.content, progress: got.progress, status: got.status }).toEqual({ content: '- [x] one\n- [ ] two', progress: '1/2', status: 'in_progress' });

    const byKey = (await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', plan_key: 'primary', content: 'p' })).result;
    expect({ id: byKey.id, logical_key: byKey.logical_key }).toEqual({ id: await uuidv5('plan-key', 'proj_1', 'primary'), logical_key: 'session:sess_a:key:primary' });
    expect((await call(t1.token, 'myco_plans', { op: 'get', id: 'nope' })).result).toEqual({ ok: false, error: 'Plan not found' });
    expect((await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', content: 'c' })).result).toEqual({ ok: false, error: 'source_path or plan_key is required when creating a new plan' });
  });

  it('names the prompt a plan came from — the caller\'s own, else the session\'s latest — refuses a prompt another machine captured, and lands a tags-only update on identical content', async () => {
    const { call, sqlite, env, t1, t2 } = await setup();
    const p1 = '00000000-0000-7000-8000-000000000101';
    const p2 = '00000000-0000-7000-8000-000000000102';
    await worker.fetch(new Request('https://s/events', { method: 'POST', headers: memberHeaders(t1.token), body: JSON.stringify(envelope({ sessionId: 'sess_a', createdAt: 100, payload: { promptId: p1, text: 'one', origin: 'user' } })) }), env);
    await worker.fetch(new Request('https://s/events', { method: 'POST', headers: memberHeaders(t1.token), body: JSON.stringify(envelope({ eventId: '00000000-0000-7000-8000-000000000110', sessionId: 'sess_a', createdAt: 200, payload: { promptId: p2, text: 'two', origin: 'user' } })) }), env);
    const latest = (await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', plan_key: 'latest', content: 'c' })).result;
    expect([latest.ok, latest.prompt_id]).toEqual([true, p2]);
    const named = (await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', plan_key: 'named', content: 'c', prompt_id: p1 })).result;
    expect([named.ok, named.prompt_id]).toEqual([true, p1]);
    const foreign = (await call(t2.token, 'myco_plans', { op: 'save', session_id: 'sess_b', plan_key: 'foreign', content: 'c', prompt_id: p1 })).result;
    expect({ ok: foreign.ok, code: foreign.code }).toEqual({ ok: false, code: 'identity_mismatch' });
    // An update keeps the prompt the row names; new tags land although nothing else moved.
    const retagged = (await call(t1.token, 'myco_plans', { op: 'save', id: named.id, session_id: 'sess_a', tags: ['later'] })).result;
    expect([retagged.ok, retagged.prompt_id, retagged.tags]).toEqual([true, p1, ['later']]);
    expect((sqlite.query(`SELECT tag FROM tags WHERE entity_id = ?`).all(named.id) as any[]).map((r) => r.tag)).toEqual(['later']);
  });

  it('lets another member update a plan, keeping the creating session and machine and recording the updating member, while a session another machine captured stays its own', async () => {
    const { call, sqlite, env, t1, t2 } = await setup();
    const created = (await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', plan_key: 'shared', content: 'v1' })).result;
    const updated = (await call(t2.token, 'myco_plans', { op: 'save', id: created.id, session_id: 'sess_b', status: 'abandoned' })).result;
    expect({ ok: updated.ok, status: updated.status, session: updated.session_id }).toEqual({ ok: true, status: 'abandoned', session: 'sess_a' });
    const row = sqlite.query(`SELECT machine_id, session_id, token_id, updated_by, status FROM plans WHERE plan_key = ?`).get(created.id) as any;
    const t2Member = (sqlite.query(`SELECT member_id FROM member_credentials WHERE id = ?`).get(t2.tokenId) as any).member_id;
    expect(row).toEqual({ machine_id: 'machine_1', session_id: 'sess_a', token_id: t1.tokenId, updated_by: t2Member, status: 'abandoned' });

    const foreign = await worker.fetch(new Request('https://s/events', { method: 'POST', headers: memberHeaders(t2.token), body: JSON.stringify(envelope({ sessionId: 'sess_a' })) }), env);
    expect(await foreign.json()).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
  });

  it('projects a same-millisecond status update as the newer write, whatever the event-id tiebreak says', async () => {
    const { serverEnv, t1 } = await setup();
    const ctx = { env: serverEnv, projectId: 'proj_1', principal: { kind: 'member' as const, memberId: 'mem_machine_1', machineId: 'machine_1', tokenId: t1.tokenId }, now: 5_000 };
    for (let i = 0; i < 10; i++) {
      const created = await handlePlans({ op: 'save', session_id: 'sess_a', plan_key: `race-${i}`, content: 'v1' }, ctx) as any;
      const updated = await handlePlans({ op: 'save', id: created.id, session_id: 'sess_a', status: 'abandoned' }, ctx) as any;
      expect({ i, ok: updated.ok, status: updated.status }).toEqual({ i, ok: true, status: 'abandoned' });
    }
  });

  it('refuses a plan into an archived Project from the ingest path while an editorial spore still lands, and reads the archived Project', async () => {
    const { call, db, t1 } = await setup();
    await archiveProject(db, 'proj_1', 'mem_machine_1', Date.now());
    const plan = await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', plan_key: 'k', content: 'c' });
    expect({ status: plan.status, result: plan.result }).toEqual({ status: 200, result: { ok: false, code: 'project_archived', error: 'this project is archived on the server; unarchive it from the dashboard to resume capture' } });
    expect((await call(t1.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'still editable' })).result.status).toBe('active');
    expect((await call(t1.token, 'myco_plans', {})).result).toEqual([]);
  });

  it('ignores an argument the tool does not declare: myco_agent cannot pivot, and an unknown key never reaches a handler', async () => {
    const { call, t1 } = await setup();
    expect((await call(t1.token, 'myco_agent', { project_id: 'proj_unknown' })).result).toEqual({ ok: true, op: 'runs', data: { runs: [], cursor: null } });
    expect((await call(t1.token, 'myco_plans', { limit: 5, purge: true })).result).toEqual([]);
  });

  it('caps a spore body, and consolidates in one write counting only the sources it moved', async () => {
    const { call, sqlite, t1 } = await setup();
    expect((await call(t1.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'x'.repeat(MAX_SPORE_CONTENT_BYTES + 1) })).result).toEqual({ ok: false, error: `content exceeds ${MAX_SPORE_CONTENT_BYTES} bytes` });
    const a = (await call(t1.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'a' })).result;
    const b = (await call(t1.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'b' })).result;
    expect((await call(t1.token, 'myco_spores', { op: 'obsolete', id: b.id, reason: 'gone' })).result.status).toBe('obsolete');
    const merged = (await call(t1.token, 'myco_spores', { op: 'consolidate', source_spore_ids: [a.id, b.id], consolidated_content: 'ab', observation_type: 'wisdom' })).result;
    expect({ sources: merged.sources_consolidated, status: merged.status }).toEqual({ sources: 1, status: 'consolidated' });
    expect(sqlite.query(`SELECT id, status FROM spores WHERE id IN (?, ?) ORDER BY id`).all(a.id, b.id)).toEqual([{ id: a.id, status: 'consolidated' }, { id: b.id, status: 'obsolete' }].sort((x, y) => x.id.localeCompare(y.id)));
    expect((sqlite.query(`SELECT COUNT(*) c FROM resolution_events WHERE new_spore_id = ?`).get(merged.new_spore_id) as any).c).toBe(1);
  });

  it('answers a plan the size the payload cap admits, and an over-quota save as a result rather than a failure', async () => {
    const { call, sqlite, t1 } = await setup();
    const big = (await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', plan_key: 'big', content: 'x'.repeat(200_000) })).result;
    expect(big.ok).toBe(true);
    sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA - 1, t1.tokenId);
    const over = await call(t1.token, 'myco_plans', { op: 'save', session_id: 'sess_a', plan_key: 'more', content: 'y'.repeat(1000) });
    expect({ status: over.status, result: over.result }).toEqual({ status: 200, result: { ok: false, code: 'quota', error: 'token write quota exceeded' } });
  });

  it('lists and reads sessions in the member-side shape, filtered in the query', async () => {
    const { call, sqlite, t1 } = await setup();
    const insert = sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', ?, 'machine_1', ?, ?, ?, 'claude-code', ?, ?, ?)`);
    insert.run('s_open', t1.tokenId, 1_000, 1_000, 'main', 1_000, null);
    insert.run('s_done', t1.tokenId, 2_000, 2_000, 'feature', 2_000, 3_000);
    sqlite.query(`UPDATE sessions SET title = 'Fixed the parser', summary = 'What happened.', titled_at = 4000 WHERE session_id = 's_done'`).run();
    const all = (await call(t1.token, 'myco_sessions')).result;
    expect(all.map((s: any) => [s.id, s.status, s.user, s.title, s.summary])).toEqual([['s_done', 'completed', 'machine_1', 'Fixed the parser', 'What happened.'], ['s_open', 'active', 'machine_1', null, '']]);
    expect((await call(t1.token, 'myco_sessions', { status: 'abandoned' })).result).toEqual({ ok: false, error: 'status must be active or completed' });
    expect((await call(t1.token, 'myco_sessions', { branch: 'main' })).result.map((s: any) => s.id)).toEqual(['s_open']);
    expect((await call(t1.token, 'myco_sessions', { status: 'completed' })).result.map((s: any) => s.id)).toEqual(['s_done']);
    expect((await call(t1.token, 'myco_sessions', { since: new Date(1_500).toISOString() })).result.map((s: any) => s.id)).toEqual(['s_done']);
    const got = (await call(t1.token, 'myco_sessions', { op: 'get', id: 's_done' })).result;
    expect({ id: got.id, ended_at: got.ended_at, prompts: got.prompt_count, counts: got.counts }).toEqual({ id: 's_done', ended_at: 3_000, prompts: 0, counts: { prompts: 0, toolCalls: 0, responses: 0, plans: 0, attachments: 0 } });
    expect((await call(t1.token, 'myco_sessions', { op: 'get', id: 'nope' })).result).toEqual({ ok: false, error: 'Session not found' });
  });

  it('answers the digest at the requested tier, the nearest tier as a fallback, and the no-digest text when none exists', async () => {
    const { call, db, t1 } = await setup();
    expect((await call(t1.token, 'myco_cortex')).result).toEqual({ content: NO_DIGEST_MESSAGE, tier: 5000, fallback: false });
    await upsertDigest(db, { projectId: 'proj_1' }, { id: 'd1', agentId: 'user', tier: 1500, content: 'brief', substrateHash: null, generatedAt: 10 });
    const nearest = (await call(t1.token, 'myco_cortex', { tier: 5000 })).result;
    expect(nearest).toEqual({ content: 'brief', tier: 1500, fallback: true, generated_at: 10 });
    const exact = (await call(t1.token, 'myco_cortex', { tier: 1500 })).result;
    expect(exact.fallback).toBe(false);
    expect((await call(t1.token, 'myco_cortex', { op: 'instructions' })).result).toEqual({ ok: false, error: 'Cortex instructions not available' });
    const activity = (await call(t1.token, 'myco_cortex', { op: 'projects_activity' })).result;
    expect(activity.projects.map((p: any) => p.id).sort()).toEqual(['proj_1', 'proj_2']);
  });

  it('serializes a digest as its text and every other result as JSON, beside the structured result', async () => {
    const { env, t1 } = await setup();
    const digest = await (await worker.fetch(post(t1.token, rpc('tools/call', { name: 'myco_cortex', arguments: {} })), env)).json() as any;
    expect(digest.result.content).toEqual([{ type: 'text', text: NO_DIGEST_MESSAGE }]);
    const plans = await (await worker.fetch(post(t1.token, rpc('tools/call', { name: 'myco_plans', arguments: {} })), env)).json() as any;
    expect({ text: plans.result.content[0].text, structured: plans.result.structuredContent }).toEqual({ text: '[]', structured: { result: [] } });
  });

  it('reads skills and runs in the member-side shapes', async () => {
    const { call, db, sqlite, t1 } = await setup();
    await insertSkillRecord(db, { projectId: 'proj_1' }, { id: 'sk1', agentId: 'user', name: 'debug-capture', displayName: 'Debug capture', description: 'd', candidateId: null, sourceIds: '[]', path: 'skills/debug-capture/SKILL.md', createdAt: 5 });
    const listed = (await call(t1.token, 'myco_skills')).result;
    expect(listed.map((s: any) => [s.id, s.display_name, s.usage_count])).toEqual([['sk1', 'Debug capture', 0]]);
    const got = (await call(t1.token, 'myco_skills', { op: 'get', id: 'debug-capture' })).result;
    expect({ id: got.id, content: got.content }).toEqual({ id: 'sk1', content: null });
    expect((await call(t1.token, 'myco_skills', { op: 'get', id: 'nope' })).result).toEqual({ ok: false, error: 'Skill not found' });
    expect((await call(t1.token, 'myco_agent')).result).toEqual({ ok: true, op: 'runs', data: { runs: [], cursor: null } });
    expect((await call(t1.token, 'myco_agent', { op: 'run', id: 'nope' })).result).toEqual({ ok: false, op: 'run', error: 'run not found' });
    sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('evolver', 'evolver', 'built-in', 1, 0)`).run();
    const seedRun = sqlite.query(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at) VALUES ('proj_1', ?, ?, 'digest', 'completed', ?)`);
    seedRun.run('r_user', 'user', 1_000);
    seedRun.run('r_evolver', 'evolver', 2_000);
    const filtered = (await call(t1.token, 'myco_agent', { agent_id: 'user', limit: 1 })).result;
    expect(filtered.data.runs.map((r: any) => r.id)).toEqual(['r_user']);
  });

  it('reads another Project through project_id without creating one, and answers an unknown Project as absent', async () => {
    const { call, sqlite, t1 } = await setup();
    const before = (sqlite.query(`SELECT COUNT(*) c FROM projects`).get() as any).c;
    expect((await call(t1.token, 'myco_plans', { project_id: 'proj_2' })).result).toEqual([]);
    expect((await call(t1.token, 'myco_plans', { project_id: 'proj_unknown' })).result).toEqual({ ok: false, error: 'Project not found' });
    expect((await call(t1.token, 'myco_sessions', { project_id: 'proj_unknown' })).result).toEqual({ ok: false, error: 'Project not found' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM projects`).get() as any).c).toBe(before);
  });

  it('serves the protocol revisions before the modern era only: a server/discover probe is answered method-not-found, so every client runs the initialize handshake', async () => {
    const { env, t1 } = await setup();
    expect({ served: SERVED_PROTOCOL_VERSIONS.length > 0, modern: SERVED_PROTOCOL_VERSIONS.filter((v) => v >= FIRST_MODERN_REVISION) }).toEqual({ served: true, modern: [] });
    const probe = await worker.fetch(post(t1.token, rpc('server/discover', {})), env);
    const body = await probe.json() as any;
    expect({ status: probe.status, code: body.error?.code, id: body.id }).toEqual({ status: 200, code: -32601, id: 1 });
    const init = await worker.fetch(post(t1.token, rpc('initialize', { protocolVersion: SERVED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 't', version: '0' } })), env);
    expect(((await init.json()) as any).result.protocolVersion).toBe(SERVED_PROTOCOL_VERSIONS[0]);
  });

  it('answers a storage failure inside a call as a retryable JSON-RPC error at 503', async () => {
    const e = sqliteEnv({ onSql: (sql) => { if (/FROM skill_records/.test(sql)) throw new Error('storage is away'); } });
    const t1 = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const res = await worker.fetch(post(t1.token, rpc('tools/call', { name: 'myco_skills', arguments: {} })), e.env);
    const body = await res.json() as any;
    expect({ status: res.status, retry: res.headers.get('retry-after') !== null, code: body.error?.data?.code }).toEqual({ status: 503, retry: true, code: 'unavailable' });
  });
});

/** A request over a grant key: the bearer alone — no protocol header, no Project header. */
const grantRequest = (key: string, body: string | undefined, over: { path?: string; method?: string; headers?: Record<string, string> } = {}) =>
  new Request(`https://s${over.path ?? '/mcp'}`, { method: over.method ?? 'POST', headers: { authorization: `Bearer ${key}`, 'cf-connecting-ip': '1.2.3.4', ...over.headers }, body });

async function grantSetup(opts: Parameters<typeof sqliteEnv>[0] = {}) {
  const e = sqliteEnv(opts);
  const now = Date.now();
  const t1 = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'review bot', 'mem_machine_1', now);
  const callAs = async (key: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const res = await worker.fetch(grantRequest(key, rpc('tools/call', { name, arguments: args }), { headers }), e.env);
    const body = await res.json() as any;
    return { status: res.status, body, result: body.result?.structuredContent?.result, error: body.error };
  };
  const memberCall = async (name: string, args: Record<string, unknown> = {}, extra: Record<string, string> = {}) => {
    const res = await worker.fetch(post(t1.token, rpc('tools/call', { name, arguments: args }), extra), e.env);
    const body = await res.json() as any;
    return { status: res.status, body, result: body.result?.structuredContent?.result, error: body.error };
  };
  const lastUsed = () => (e.sqlite.query(`SELECT last_used_at FROM external_grants WHERE id = ?`).get(grant.id) as any).last_used_at;
  return { ...e, now, t1, grant, callAs, memberCall, lastUsed };
}

describe('POST /mcp over an External Agent grant', () => {
  it('lists the six tools as the member side declares them, narrowed to the ops it answers, and answers every allowlisted read in the member-side shape', async () => {
    const { env, db, grant, callAs, memberCall } = await grantSetup();
    const listed = await (await worker.fetch(grantRequest(grant.key, rpc('tools/list')), env)).json() as any;
    expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual([...EXTERNAL_TOOLS].sort());
    expect(listed.result.tools).toEqual(externalDefinitions().map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations })));
    await memberCall('myco_spores', { op: 'save', type: 'gotcha', content: 'seen by the bot' });
    await upsertDigest(db, { projectId: 'proj_1' }, { id: 'd-bot', agentId: 'user', tier: 5000, content: 'the digest', substrateHash: null, generatedAt: 10 });
    const spores = await callAs(grant.key, 'myco_spores', { op: 'list' });
    expect({ total: spores.result.total, content: spores.result.spores[0].content }).toEqual({ total: 1, content: 'seen by the bot' });
    expect((await callAs(grant.key, 'myco_spores', { op: 'get', id: spores.result.spores[0].id })).result.content).toBe('seen by the bot');
    expect(spores.result.spores.map((s: any) => 'author' in s)).toEqual([false]);
    expect('author' in (await callAs(grant.key, 'myco_spores', { op: 'get', id: spores.result.spores[0].id })).result).toBe(false);
    expect('author' in (await memberCall('myco_spores', { op: 'get', id: spores.result.spores[0].id })).result).toBe(true);
    expect((await callAs(grant.key, 'myco_plans', { op: 'list' })).result).toEqual([]);
    expect((await callAs(grant.key, 'myco_sessions', {})).result).toEqual([]);
    expect((await callAs(grant.key, 'myco_skills', { op: 'list' })).result).toEqual([]);
    expect((await callAs(grant.key, 'myco_cortex', { op: 'digest', tier: 5000 })).result.content).toBe('the digest');
    const search = await callAs(grant.key, 'myco_search', { query: 'seen' });
    expect(search.result.results).toMatchObject([{ type: 'spore', id: spores.result.spores[0].id }]);
  });

  it('refuses every write, every admin read, myco_agent, an op outside the enum and an empty op exactly as a tool that does not exist', async () => {
    const { grant, callAs } = await grantSetup();
    const unknown = await callAs(grant.key, 'myco_nope');
    expect({ status: unknown.status, error: unknown.error }).toEqual({ status: 200, error: { code: -32000, message: 'Unknown tool: myco_nope', data: { code: 'unknown_tool' } } });
    // The refusals are the registry minus the surface, enumerated rather than
    // listed: an op added to a tool is refused here from the moment it exists,
    // and an op added to the surface leaves this list by the same edit.
    const refused: Array<[string, Record<string, unknown>]> = [];
    for (const [tool, entry] of Object.entries(TOOL_REGISTRY)) {
      for (const op of Object.keys(entry.ops)) {
        const args = op === NO_OP ? {} : { op };
        if (isExternalCall(tool as ServedTool, opOf(tool as ServedTool, args))) continue;
        refused.push([tool, args]);
      }
    }
    refused.push(['myco_plans', { op: '' }]);
    const named = refused.map(([tool, args]) => `${tool}:${args.op ?? ''}`);
    expect(named).toContain('myco_spores:consolidate');
    expect(named).toContain('myco_spores:obsolete');
    expect(named).toContain('myco_plans:save');
    expect(named).toContain('myco_agent:runs');
    expect(named).not.toContain('myco_spores:save');
    expect(named).not.toContain('myco_spores:supersede');
    for (const [name, args] of refused) {
      const res = await callAs(grant.key, name, args);
      expect({ name, args, status: res.status, error: res.error }).toEqual({ name, args, status: 200, error: { ...unknown.error, message: `Unknown tool: ${name}` } });
    }
  });

  it('accepts project_id naming its own Project, refuses any other value as a tool that does not exist without looking the Project up, and reads its own Project whatever the header names', async () => {
    const { grant, callAs, memberCall, executed } = await grantSetup();
    await memberCall('myco_spores', { op: 'save', type: 'gotcha', content: 'in proj_1' });
    const plain = await callAs(grant.key, 'myco_spores', { op: 'list' });
    const own = await callAs(grant.key, 'myco_spores', { op: 'list', project_id: 'proj_1' });
    expect(own.body).toEqual(plain.body);
    const from = executed.length;
    const foreign = await callAs(grant.key, 'myco_spores', { op: 'list', project_id: 'proj_2' });
    const absent = await callAs(grant.key, 'myco_spores', { op: 'list', project_id: 'proj_nowhere' });
    expect({ foreign: foreign.error, absent: absent.error }).toEqual({ foreign: { code: -32000, message: 'Unknown tool: myco_spores', data: { code: 'unknown_tool' } }, absent: foreign.error });
    expect(executed.slice(from).filter((sql) => /\bprojects\b/i.test(sql))).toEqual([]);
    const misnamed = await callAs(grant.key, 'myco_spores', { op: 'list' }, { [PROJECT_HEADER]: 'proj_2' });
    expect(misnamed.result.total).toBe(1);
    expect((await memberCall('myco_spores', { op: 'list' }, { [PROJECT_HEADER]: 'proj_2' })).result.total).toBe(0);
  });

  it('records use once per interval, keys the limiter on the grant id, never charges the source bucket, and issues no write but that record on any allowlisted read', async () => {
    const { db, grant, callAs, memberCall, lastUsed, tokenKeys, sourceKeys, executed } = await grantSetup();
    const spore = (await memberCall('myco_spores', { op: 'save', type: 'gotcha', content: 'seed' })).result.id as string;
    const plan = (await memberCall('myco_plans', { op: 'save', content: '# p', session_id: 'sess-seed', plan_key: 'seed' })).result;
    await insertSkillRecord(db, { projectId: 'proj_1' }, { id: 'skill-seed', agentId: 'user', name: 'seed', displayName: 'Seed', description: 'd', candidateId: null, sourceIds: '[]', path: 'skills/seed/SKILL.md', createdAt: 5 });
    await upsertDigest(db, { projectId: 'proj_1' }, { id: 'd-seed', agentId: 'user', tier: 5000, content: 'seed digest', substrateHash: null, generatedAt: 10 });
    const from = executed.length;
    const keysFrom = tokenKeys.length;
    await callAs(grant.key, 'myco_plans', { op: 'list' });
    const first = lastUsed();
    expect(typeof first).toBe('number');
    const reads: Array<[string, Record<string, unknown>]> = [
      ['myco_sessions', {}], ['myco_skills', {}], ['myco_spores', {}], ['myco_cortex', {}], ['myco_search', { query: 'q' }],
      ['myco_spores', { op: 'get', id: spore }], ['myco_plans', { op: 'get', id: plan.id }], ['myco_skills', { op: 'get', id: 'skill-seed' }], ['myco_sessions', { op: 'get', id: 'sess-seed' }], ['myco_cortex', { op: 'digest', tier: 5000 }],
    ];
    for (const [name, args] of reads) {
      const res = await callAs(grant.key, name, args);
      expect({ name, args, answered: res.error === undefined || res.error.data?.code === 'not_served' }).toEqual({ name, args, answered: true });
    }
    expect(lastUsed()).toBe(first);
    expect(executed.slice(from).filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)).every((sql) => /UPDATE external_grants/.test(sql))).toBe(true);
    expect(executed.slice(from).some((sql) => /UPDATE external_grants/.test(sql))).toBe(true);
    expect({ tokenKeys: [...new Set(tokenKeys.slice(keysFrom))], sourceKeys }).toEqual({ tokenKeys: [grant.id], sourceKeys: [] });
  });

  it('refuses a revoked grant and a rotated grant\'s predecessor with 401, admits the successor, and charges the source bucket for a key it does not hold', async () => {
    const { env, db, grant, callAs, now, sourceKeys } = await grantSetup();
    const rotated = await rotateExternalGrant(db, { projectId: 'proj_1' }, grant.id, 'mem_machine_1', now);
    expect((await worker.fetch(grantRequest(grant.key, rpc('tools/list')), env)).status).toBe(401);
    expect((await callAs(rotated!.key, 'myco_plans', { op: 'list' })).result).toEqual([]);
    await revokeExternalGrant(db, { projectId: 'proj_1' }, rotated!.id, 'mem_machine_1', now);
    expect((await worker.fetch(grantRequest(rotated!.key, rpc('tools/list')), env)).status).toBe(401);
    expect(sourceKeys).toEqual(['1.2.3.4', '1.2.3.4']);
  });

  it('reaches POST /mcp alone: every other path answers 401, and a served path asked with the wrong method answers 405 naming the method, to a member and to a grant alike', async () => {
    const { env, grant, t1 } = await grantSetup();
    for (const [method, path, body] of [['POST', '/events', envelope()], ['POST', '/spores/save', '{}'], ['GET', '/api/enrollment', undefined], ['DELETE', '/api/secrets/x', undefined], ['POST', '/nope', '{}']] as Array<[string, string, string | undefined]>) {
      const res = await worker.fetch(grantRequest(grant.key, body, { method, path }), env);
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 401 });
    }
    const grantGet = await worker.fetch(grantRequest(grant.key, undefined, { method: 'GET' }), env);
    expect({ status: grantGet.status, allow: grantGet.headers.get('allow') }).toEqual({ status: 405, allow: 'POST' });
    const memberGet = await worker.fetch(new Request('https://s/mcp', { method: 'GET', headers: memberHeaders(t1.token) }), env);
    expect({ status: memberGet.status, allow: memberGet.headers.get('allow') }).toEqual({ status: 405, allow: 'POST' });
    expect((await worker.fetch(new Request('https://s/mcp', { method: 'GET', headers: { 'cf-connecting-ip': '1.2.3.4' } }), env)).status).toBe(401);
  });

  it('refuses an over-cap body in the answered shape, keeps reading an archived Project, and answers a storage fault or a limiter fault as a retryable 503', async () => {
    const { env, sqlite, grant, callAs } = await grantSetup();
    const capped = await worker.fetch(grantRequest(grant.key, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(MAX_BODY_BYTES) } })), env);
    expect({ status: capped.status, code: ((await capped.json()) as any).error?.data?.code }).toEqual({ status: 400, code: 'body_cap' });
    sqlite.query(`UPDATE projects SET archived_at = 1, archived_by = 'mem_machine_1' WHERE project_id = 'proj_1'`).run();
    expect((await callAs(grant.key, 'myco_plans', { op: 'list' })).result).toEqual([]);

    const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    try {
      const faulty = await grantSetup({ onSql: (sql) => { if (/FROM skill_records/.test(sql)) throw new Error('storage is away'); } });
      const fault = await worker.fetch(grantRequest(faulty.grant.key, rpc('tools/call', { name: 'myco_skills', arguments: {} })), faulty.env);
      expect({ status: fault.status, retry: fault.headers.get('retry-after') !== null, code: ((await fault.json()) as any).error?.data?.code }).toEqual({ status: 503, retry: true, code: 'unavailable' });
      expect(lines.map((l) => JSON.parse(l)).filter((e) => e.kind === 'mcp_error').map((e) => ({ grantId: e.grantId, memberId: e.memberId }))).toEqual([{ grantId: faulty.grant.id, memberId: undefined }]);

      const limiterless = await grantSetup();
      limiterless.env.TOKEN_LIMIT = { limit: async () => { throw new Error('limiter is away'); } };
      const early = await worker.fetch(grantRequest(limiterless.grant.key, rpc('tools/list')), limiterless.env);
      expect({ status: early.status, retry: early.headers.get('retry-after') !== null }).toEqual({ status: 503, retry: true });
      expect(lines.map((l) => JSON.parse(l)).filter((e) => e.kind === 'request_error').map((e) => e.grantId)).toEqual([limiterless.grant.id]);
    } finally {
      console.log = original;
    }
  });

  it('names a served tool or the literal unknown in telemetry, never the caller\'s text, and the member backstop refuses a grant as a tool that does not exist', async () => {
    const { serverEnv, grant, callAs } = await grantSetup();
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => { lines.push(String(line)); };
    try {
      await callAs(grant.key, 'myco_<script>', {});
      await callAs(grant.key, 'myco_spores', { op: 'consolidate' });
      await callAs(grant.key, 'myco_spores', { op: 'save', content: 'x', type: 'gotcha' });
    } finally {
      console.log = original;
    }
    const tools = lines.map((l) => JSON.parse(l)).filter((e) => e.kind === 'mcp_tool').map((e) => ({ tool: e.tool, status: e.status, grantId: e.grantId }));
    expect(tools).toEqual([
      { tool: 'unknown', status: 'unknown_tool', grantId: grant.id },
      { tool: 'myco_spores', status: 'unknown_tool', grantId: grant.id },
      { tool: 'myco_spores', status: 'ok', grantId: grant.id },
    ]);
    expect(() => memberOf(grantToolContext(serverEnv, { projectId: 'proj_1', grantId: grant.id, body: '', now: 0 }), 'myco_plans')).toThrow('Unknown tool: myco_plans');
  });
});

/**
 * The run principal: a credential the dispatcher minted for one run, presented
 * to `/mcp`. Bound to the run's Project, admitted to the `(tool, op)` pairs its
 * task declares and to nothing else, refused on every member route that is not
 * the run-control plane, and every write it makes names the run as author.
 */
const RUN_NOW = 1_700_000_000_000;
const SWEEP = 'supersession-sweep';

async function runSetup() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [RUN_NOW]);
  e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at)
                VALUES ('proj_1', 'sess_1', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [RUN_NOW - 10_000, RUN_NOW, RUN_NOW - 10_000, RUN_NOW]);
  e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                VALUES ('proj_1', 'sess_1', 'p_1', 'e_1', 'hello', 'user', 'h_1', ?, ?, 'tok_1', ?)`, [RUN_NOW - 5_000, RUN_NOW - 5_000, RUN_NOW - 5_000]);
  await ensureMember(e.db, HARNESS_MEMBER_ID, Date.now(), 'member', 'harness runtime');
  const harness = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
  const member = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());

  /** A dispatched row for this credential; `running` unless the test wants it left `pending`. */
  const dispatch = async (credential: { tokenId: string }, runId: string, task: string, over: { sessionId?: string | null; status?: string; projectId?: string; startedAt?: number; dryRun?: boolean } = {}) => {
    const projectId = over.projectId ?? 'proj_1';
    const runContext = JSON.stringify({ ...(over.sessionId === null ? {} : { session_id: over.sessionId ?? 'sess_1' }), timeoutSeconds: 300 });
    expect(await recordDispatch(e.db, { projectId }, { id: runId, agentId: 'myco-agent', task, provider: 'anthropic', model: null, runContext, dispatchedBy: credential.tokenId, startedAt: over.startedAt ?? Date.now(), dryRun: over.dryRun })).toBe(true);
    e.sqlite.run(`UPDATE agent_runs SET status = ? WHERE project_id = ? AND id = ?`, [over.status ?? 'running', projectId, runId]);
  };
  const call = async (token: string, name: string, args: Record<string, unknown> = {}, extra: Record<string, string> = {}) => {
    const res = await worker.fetch(post(token, rpc('tools/call', { name, arguments: args }), extra), e.env);
    const body = await res.json() as any;
    return { status: res.status, body, result: body.result?.structuredContent?.result, error: body.error };
  };
  const list = async (token: string, extra: Record<string, string> = {}) => {
    const res = await worker.fetch(post(token, rpc('tools/list'), extra), e.env);
    return { status: res.status, body: await res.json() as any };
  };
  const writes = (from: number) => e.executed.slice(from).filter((sql) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql));
  return { ...e, harness, member, dispatch, call, list, writes };
}

/** Every `(tool, op)` the registry keys, as the registry resolves it. */
const everyRegistryCall = (): Array<{ tool: string; op: string; args: Record<string, unknown> }> =>
  Object.entries(TOOL_REGISTRY).flatMap(([tool, entry]) =>
    Object.keys(entry.ops).map((op) => ({ tool, op, args: op === NO_OP ? { query: 'x' } : { op, id: 'x', content: 'x', type: 'gotcha', query: 'x' } })));

describe('POST /mcp over a run credential', () => {
  it('lists exactly the run surface its task declares, with each op enum narrowed, and lists nothing for a task with no mapped tools', async () => {
    const { harness, dispatch, list } = await runSetup();
    await dispatch(harness, 'run_1', SWEEP);
    const listed = await list(harness.token);
    expect(listed.status).toBe(200);
    const expected = runDefinitions(runAllowlist(TASK_TOOLS[SWEEP], { dryRun: false }));
    expect(listed.body.result.tools).toEqual(expected.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations })));
    expect(listed.body.result.tools.map((t: any) => t.name)).toEqual(['myco_spores']);
    expect(listed.body.result.tools[0].inputSchema.properties.op.enum.sort()).toEqual(['get', 'list', 'obsolete', 'save', 'supersede']);

    for (const task of ['title-summary', 'container-smoke']) {
      const h = await runSetup();
      await h.dispatch(h.harness, 'run_x', task);
      expect({ task, tools: (await h.list(h.harness.token)).body.result.tools }).toEqual({ task, tools: [] });
      const from = h.executed.length;
      expect({ task, code: (await h.call(h.harness.token, 'myco_spores', { op: 'list' })).error.data.code }).toEqual({ task, code: 'unknown_tool' });
      expect({ task, writes: h.writes(from) }).toEqual({ task, writes: [] });
    }
  });

  it('refuses every (tool, op) the registry keys outside the run\'s allowlist as a tool that does not exist, writing nothing', async () => {
    const { harness, dispatch, call, executed, writes } = await runSetup();
    await dispatch(harness, 'run_1', SWEEP);
    const allow = runAllowlist(TASK_TOOLS[SWEEP], { dryRun: false });
    const outside = everyRegistryCall().filter(({ tool, op }) => !(allow.get(tool as any)?.has(op) ?? false));
    expect(outside.length).toBeGreaterThan(10);
    expect(outside.map((c) => `${c.tool}:${c.op}`)).toEqual(expect.arrayContaining(['myco_plans:save', 'myco_cortex:digest', 'myco_agent:runs', 'myco_search:*', 'myco_spores:consolidate']));
    const from = executed.length;
    for (const { tool, op, args } of outside) {
      const answered = await call(harness.token, tool, args);
      expect({ tool, op, code: answered.error?.data?.code }).toEqual({ tool, op, code: 'unknown_tool' });
    }
    expect(writes(from)).toEqual([]);
  });

  it('is bound to the run\'s Project: a header naming another is refused before any handler, a project_id naming another is a tool that does not exist, and its own is admitted', async () => {
    const { harness, dispatch, call, list } = await runSetup();
    await dispatch(harness, 'run_1', SWEEP);
    const foreign = await list(harness.token, { [PROJECT_HEADER]: 'proj_2' });
    expect({ status: foreign.status, code: foreign.body.error.data.code, message: foreign.body.error.message }).toEqual({ status: 400, code: 'project_mismatch', message: RUN_PROJECT_MISMATCH });
    expect((await call(harness.token, 'myco_spores', { op: 'list', project_id: 'proj_2' })).error.data.code).toBe('unknown_tool');
    expect((await call(harness.token, 'myco_spores', { op: 'list', project_id: 'proj_nowhere' })).error.data.code).toBe('unknown_tool');
    expect((await call(harness.token, 'myco_spores', { op: 'list', project_id: 'proj_1' })).result).toMatchObject({ total: 0 });
  });

  it('holds no surface without exactly one live run: none, pending, completed, stale, or two rows naming one credential', async () => {
    const none = await runSetup();
    const answered = await none.list(none.harness.token);
    expect({ status: answered.status, code: answered.body.error.data.code, message: answered.body.error.message }).toEqual({ status: 400, code: 'no_run', message: NO_LIVE_RUN });

    const pending = await runSetup();
    await pending.dispatch(pending.harness, 'run_1', SWEEP, { status: 'pending' });
    expect((await pending.list(pending.harness.token)).body.error.data.code).toBe('no_run');

    const completed = await runSetup();
    await completed.dispatch(completed.harness, 'run_1', SWEEP, { status: 'completed' });
    expect((await completed.list(completed.harness.token)).body.error.data.code).toBe('no_run');

    const stale = await runSetup();
    await stale.dispatch(stale.harness, 'run_1', SWEEP, { startedAt: Date.now() - 3_600_000 });
    expect((await stale.list(stale.harness.token)).body.error.data.code).toBe('no_run');

    // The dispatcher mints one credential per launch; two rows naming one is recorded here directly to pin the fail-closed answer.
    const two = await runSetup();
    await two.dispatch(two.harness, 'run_1', SWEEP);
    await two.dispatch(two.harness, 'run_2', SWEEP, { projectId: 'proj_2', sessionId: null });
    expect((await two.list(two.harness.token)).body.error.data.code).toBe('no_run');
  });

  it('attributes every write to the run: its agent, the run id as author, the dispatch-named session and its latest prompt; a member\'s write names the member', async () => {
    const { harness, member, dispatch, call, sqlite } = await runSetup();
    await dispatch(harness, 'run_1', SWEEP);
    const saved = (await call(harness.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'seen by the run' })).result;
    expect(sqlite.query(`SELECT agent_id, author, session_id, prompt_id FROM spores WHERE id = ?`).get(saved.id)).toEqual({ agent_id: 'myco-agent', author: 'run_1', session_id: 'sess_1', prompt_id: 'p_1' });
    const second = (await call(harness.token, 'myco_spores', { op: 'save', type: 'decision', content: 'the successor' })).result;
    expect((await call(harness.token, 'myco_spores', { op: 'supersede', old_spore_id: saved.id, new_spore_id: second.id, reason: 'replaced' })).result.status).toBe('superseded');
    expect(sqlite.query(`SELECT agent_id, author, session_id FROM resolution_events WHERE spore_id = ?`).get(saved.id)).toEqual({ agent_id: 'myco-agent', author: 'run_1', session_id: 'sess_1' });
    expect((await call(harness.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'x', session_id: 'sess_other' })).result).toEqual({ ok: false, error: 'session_id not found' });
    expect((await call(harness.token, 'myco_spores', { op: 'get', id: saved.id })).result.author).toBe('run_1');

    const mine = (await call(member.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'seen by a person' })).result;
    expect(sqlite.query(`SELECT agent_id, author FROM spores WHERE id = ?`).get(mine.id)).toEqual({ agent_id: 'user', author: 'mem_machine_1' });
  });

  it('writes with no session, still authored by the run, when the dispatch names a session the Project does not hold', async () => {
    const { harness, dispatch, call, sqlite } = await runSetup();
    await dispatch(harness, 'run_1', SWEEP, { sessionId: 'sess_missing' });
    const saved = (await call(harness.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'orphaned dispatch' })).result;
    expect(sqlite.query(`SELECT author, session_id FROM spores WHERE id = ?`).get(saved.id)).toEqual({ author: 'run_1', session_id: null });
  });

  it('gives a dry run its reads and none of its writes', async () => {
    const { harness, dispatch, call, list } = await runSetup();
    await dispatch(harness, 'run_1', SWEEP, { dryRun: true });
    expect((await list(harness.token)).body.result.tools[0].inputSchema.properties.op.enum.sort()).toEqual(['get', 'list']);
    expect((await call(harness.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'x' })).error.data.code).toBe('unknown_tool');
    expect((await call(harness.token, 'myco_spores', { op: 'list' })).result).toMatchObject({ total: 0 });
  });

  it('is refused on every member route that is not the run-control plane, live run or not, in the route\'s shape and writing nothing, while a member is admitted', async () => {
    const { env, harness, member, dispatch, executed, writes } = await runSetup();
    await dispatch(harness, 'run_1', SWEEP);
    const from = executed.length;
    const asJson = async (token: string, path: string, body: unknown) => {
      const res = await worker.fetch(new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(token), body: JSON.stringify(body) }), env);
      return { status: res.status, body: await res.json() as any };
    };
    for (const [path, body, shape] of [
      ['/spores/save', { id: 'sp_x', agentId: 'user', observationType: 'gotcha', content: 'x' }, 'persisted'],
      ['/spores/list', {}, 'persisted'],
      ['/events', [envelope()], 'persisted'],
      ['/context/prompt', { sessionId: 'sess_1', promptId: 'p_1' }, 'persisted'],
      ['/tokens/refresh', {}, 'refreshed'],
    ] as const) {
      const answered = await asJson(harness.token, path, body);
      expect({ path, status: answered.status, body: answered.body }).toEqual({ path, status: 200, body: { [shape]: false, code: 'run_scope', reason: RUN_SCOPE } });
    }
    const blob = await worker.fetch(new Request(`https://s/blobs/${'a'.repeat(64)}`, { method: 'POST', headers: memberHeaders(harness.token, { 'content-type': 'text/plain; charset=utf-8', 'content-length': '1' }), body: new Uint8Array([1]) }), env);
    expect(await blob.json()).toEqual({ stored: false, code: 'run_scope', reason: RUN_SCOPE });
    expect(writes(from)).toEqual([]);
    expect((await asJson(member.token, '/spores/list', {})).body.persisted).toBe(true);

    const idle = await runSetup();
    const idleAnswer = await worker.fetch(new Request('https://s/spores/list', { method: 'POST', headers: memberHeaders(idle.harness.token), body: '{}' }), idle.env);
    expect(await idleAnswer.json()).toEqual({ persisted: false, code: 'run_scope', reason: RUN_SCOPE });
  });
});

import assert from 'node:assert/strict';
import { seededSqlite, sqliteD1 } from '../tests/myco-server/helpers/d1.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '../packages/myco-server/src/constants.js';
import { wrappingKeyFromText } from '../packages/myco-server/src/platform/wrapping-key.js';
import type { ServerEnv } from '../packages/myco-server/src/core/adapters.js';
import { ownerCookie, OWNER_ENV, MEMBER_SUB, seedMemberRoleAccount } from '../tests/myco-server/helpers/owner.js';
import { createServer } from '../packages/myco-server/src/pipeline.js';
import { issueMemberToken } from '../packages/myco-server/src/auth/tokens.js';
import { callTool, authorizedDefinitionsFor } from '../packages/myco-server/src/mcp/server.js';
import { authorize, authorizeDeclaration, declaredAction } from '../packages/myco-server/src/auth/authorization.js';
import { ROUTES, RETIRED_ROUTES } from '../packages/myco-server/src/routes.js';
import { TOOL_REGISTRY } from '../packages/myco-server/src/mcp/registry.js';
import { RUN_TOOL_REGISTRY } from '../packages/myco-server/src/mcp/run-surface.js';

const sqlite = seededSqlite();
const fixture = { sqlite, db: sqliteD1(sqlite) };
seedMemberRoleAccount(fixture.sqlite);
const now = Date.now();
const env: ServerEnv = { db: fixture.db, blobs: { get: async () => null, head: async () => null, put: async () => ({ size: 0 }), delete: async () => {} }, sourceLimit: { limit: async () => ({ success: true }) }, tokenLimit: { limit: async () => ({ success: true }) }, secrets: OWNER_ENV, wrappingKey: wrappingKeyFromText(async () => undefined, 'smoke'), platform: { name: 'bun', capabilities: () => [], classifyError: () => null, classifyBlobFailure: () => 'other', jobBudget: { calls: 100, wallMs: 1000 } }, harnessCredentialSource: 'worker-login', afterResponse: () => {}, outbound: () => { throw new Error('Unexpected outbound'); } };
const server = createServer({ now: () => now, sourceOf: () => 'smoke', fetchImpl: () => { throw new Error('Unexpected outbound call'); } });
const credential = await issueMemberToken(fixture.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now);
const ctx = { env, projectId: 'proj_1', principal: { kind: 'member' as const, memberId: 'mem_machine_2', machineId: 'machine_2', tokenId: credential.tokenId }, now };
const member = { kind: 'member' as const, memberId: 'member', role: 'member' as const, deploymentId: 'a', live: true, transport: 'http' as const };
const processed = { kind: 'processed' as const, deploymentId: 'a', exists: true };
assert.equal(authorize(member, 'read', processed), true);
assert.equal(authorize(member, 'read', { ...processed, deploymentId: 'b' }), false);
assert.equal(authorizeDeclaration(member, undefined, {}, processed), false);
for (const role of ['owner', 'admin', 'member'] as const) {
  assert.equal(authorize({ ...member, role }, 'read', { ...processed, kind: 'raw', uploader: false }), false);
  assert.equal(authorize({ ...member, role }, 'read', { ...processed, kind: 'raw', uploader: true }), true);
  assert.equal(authorize({ ...member, role }, 'claimant.edit', { ...processed, kind: 'machine-settings', claimantMemberId: 'other' }), false);
}
const run = { ...member, kind: 'run' as const, projectId: 'proj_1', runId: 'run', tokenId: 'token', attempt: 1 };
const runResource = { ...processed, kind: 'run' as const, projectId: 'proj_1', runId: 'run', tokenId: 'token', attempt: 1 };
assert.equal(authorize(run, 'execute', runResource), true);
for (const mismatch of [{ projectId: 'proj_2' }, { runId: 'other' }, { tokenId: 'other' }, { attempt: 2 }]) assert.equal(authorize(run, 'execute', { ...runResource, ...mismatch }), false);
assert.equal(authorize(member, 'execute', runResource), false);
assert.equal((await server.handleRequest(new Request('https://smoke/health'), env)).status, 200);
assert.equal((await server.handleRequest(new Request('https://smoke/spores/list', { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, [PROJECT_HEADER]: 'proj_1', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) }, body: '{}' }), env)).status, 200);
const listed = await authorizedDefinitionsFor(ctx);
assert.ok(listed.some((tool) => tool.name === 'myco_plans'));
assert.ok(!listed.some((tool) => tool.name === 'myco_run'));
await callTool(ctx, 'myco_plans', { op: 'list', project: 'proj_1' });
fixture.sqlite.run(`INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('smoke-agent','Smoke','built-in',1,?)`, [now]);
for (const [id, actor] of [['own', 'mem_machine_2'], ['other', 'mem_machine_3']]) fixture.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,dispatch_spec,started_at) VALUES ('proj_1',?,'smoke-agent','title-summary','queued',?,?)`, [id, JSON.stringify({ actor }), now]);
const post = async (id: string) => server.handleRequest(new Request(`https://smoke/api/projects/proj_1/runs/${id}/cancel`, { method: 'POST', headers: { cookie: await ownerCookie(now, MEMBER_SUB), origin: 'https://smoke' } }), env);
assert.equal((await post('other')).status, 404);
assert.equal((await post('own')).status, 200);
assert.equal((fixture.sqlite.query("SELECT status FROM agent_runs WHERE id='other'").get() as { status: string }).status, 'queued');
const statusRoute = ROUTES.find((route) => route.path.endsWith('/plans/{planKey}/status'))!;
const statusTool = TOOL_REGISTRY.myco_plans.ops.save.authorization;
assert.equal(declaredAction(statusRoute.authorization, { status: 'completed' }), declaredAction(statusTool, { id: 'plan', status: 'completed' }));
for (const role of ['owner', 'admin', 'member'] as const) {
  const plan = { ...processed, kind: 'plan' as const };
  assert.equal(authorizeDeclaration({ ...member, role }, statusRoute.authorization, { status: 'completed' }, plan), true);
  assert.equal(authorizeDeclaration({ ...member, role, transport: 'mcp' }, statusTool, { id: 'plan', status: 'completed' }, plan), true);
}
fixture.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES ('foreign-machine','mem_machine_3',?)", [now]);
for (const [id, expected] of [['missing-machine', 404], ['foreign-machine', 403]] as const) {
  const response = await server.handleRequest(new Request(`https://smoke/api/machines/${id}/settings`, { headers: { cookie: await ownerCookie(now, MEMBER_SUB) } }), env);
  assert.equal(response.status, expected);
}
const sessionPost = async (path: string, body: unknown, sub = MEMBER_SUB) => server.handleRequest(new Request(`https://smoke${path}`, { method: 'POST', headers: { cookie: await ownerCookie(now, sub), origin: 'https://smoke' }, body: JSON.stringify(body) }), env);
assert.equal((await sessionPost('/api/enrollment', { role: 'owner' })).status, 403);
assert.equal((await sessionPost('/api/enrollment', { role: 'owner' }, '583231')).status, 400);
assert.equal((await sessionPost('/api/enrollment', { role: 'admin' }, '583231')).status, 403);
assert.equal((await sessionPost('/api/harness/dispatch', { task: 'title-summary', projectId: 'proj_1', fresh: true })).status, 403);
assert.equal((await sessionPost('/api/harness/dispatch', { task: 'title-summary', projectId: 'missing-project' })).status, 400);
const smokePlanKey = 'ffffffff-ffff-4fff-afff-ffffffffffff';
fixture.sqlite.run(`INSERT INTO plans (project_id,plan_key,session_id,event_id,machine_id,content_hash,status,created_at,updated_at,token_id,received_at)
  VALUES ('proj_1',?,'smoke-session','smoke-plan-event','machine_1','smoke-hash','active',?,?,?,?)`, [smokePlanKey, now, now, credential.tokenId, now]);
assert.equal((await sessionPost(`/api/projects/proj_1/sessions/smoke-session/plans/${smokePlanKey}/status`, { status: 'completed' })).status, 200);
const edited = await callTool(ctx, 'myco_plans', { op: 'save', id: smokePlanKey, session_id: 'different-session', status: 'in_progress', project: 'proj_1' }) as { result: { ok: boolean } };
assert.equal(edited.result.ok, true);
const memberPost = async (path: string, body: unknown) => server.handleRequest(new Request(`https://smoke${path}`, { method: 'POST', headers: { authorization: `Bearer ${credential.token}`, [PROJECT_HEADER]: 'proj_1', [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) }, body: JSON.stringify(body) }), env);
assert.equal((await (await memberPost('/members/link-github', {})).json() as { code: string }).code, 'link_requires_admin');
assert.equal((await (await memberPost('/members/link-github', { unexpected: true })).json() as { code: string }).code, 'unknown_field');
assert.equal((await (await memberPost('/members/raw-claims', { revision: '0' })).json() as { code: string }).code, 'not_owner');
fixture.sqlite.run("UPDATE deployment_ownership SET member_id='mem_machine_1', revision=1 WHERE id=1");
fixture.sqlite.run("UPDATE members SET role='admin', github_id='770003' WHERE id='mem_machine_3'");
const ownerCredential = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
fixture.sqlite.run("INSERT INTO machine_claims (machine_id,member_id,claimed_at) VALUES ('machine_1','mem_machine_1',?)", [now]);
for (const [sub, visible] of [['583231', true], ['770003', false]] as const) {
  const headers = { cookie: await ownerCookie(now, sub) };
  const page = await (await server.handleRequest(new Request('https://smoke/api/credentials', { headers }), env)).json() as { rows: Array<{ id: string }> };
  assert.ok(page.rows, JSON.stringify({ sub, page }));
  assert.equal(page.rows.some(row => row.id === ownerCredential.tokenId), visible);
  assert.equal((await server.handleRequest(new Request(`https://smoke/api/credentials/${ownerCredential.tokenId}/activity`, { headers }), env)).status, visible ? 200 : 404);
}
assert.equal((await sessionPost('/api/machines/machine_1/stop', {}, '770003')).status, 404);
assert.equal((fixture.sqlite.query('SELECT revoked_at FROM member_credentials WHERE id = ?').get(ownerCredential.tokenId) as { revoked_at: number | null }).revoked_at, null);
assert.equal((await sessionPost('/api/machines/machine_1/stop', {}, '583231')).status, 200);
assert.equal((fixture.sqlite.query('SELECT revoked_by FROM member_credentials WHERE id = ?').get(ownerCredential.tokenId) as { revoked_by: string }).revoked_by, 'mem_machine_1');
const coverage = { routes: ROUTES.length, retired: RETIRED_ROUTES.length, memberOps: Object.values(TOOL_REGISTRY).reduce((n, t) => n + Object.keys(t.ops).length, 0), runOps: Object.values(RUN_TOOL_REGISTRY).reduce((n, t) => n + Object.keys(t.ops).length, 0) };
assert.ok(ROUTES.every((r) => r.authorization !== undefined));
assert.ok(RETIRED_ROUTES.every((r) => r.authorization.action === 'never'));
console.log(JSON.stringify({ smoke: 'passed', coverage }));
fixture.sqlite.close();

import { expect, test } from 'bun:test';
import { agentProse } from '@goondocks/myco-shared/run-text';
import worker from '@myco-server-worker/index.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { revokeCredentialAsMember, issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { issueExternalGrant } from '@myco-server-worker/auth/grants.js';
import { ensureMember, issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { revokeMember } from '@myco-server-worker/auth/members-admin.js';
import { HARNESS_MEMBER_ID, MAX_PROJECTS } from '@myco-server-worker/constants.js';
import { parseCardWrites } from '@myco-server-worker/core/turn-cards.js';
import { recordDispatch, applyRunUpdate } from '@myco-server-worker/core/runs.js';
import { writeSpore } from '@myco-server-worker/core/spore-admission.js';
import { handleRun } from '@myco-server-worker/mcp/tools/run.js';
import { runAllowlist } from '@myco-server-worker/mcp/run-surface.js';
import { readWindowFor } from '@myco-server-worker/core/read-window.js';
import { envelope, memberPost, sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, asOwnerPost, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

async function rig(onSql?: NonNullable<Parameters<typeof sqliteEnv>[0]>['onSql']) {
  const f = sqliteEnv({ onSql });
  const now = Date.now();
  const token = await issueMemberToken(f.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now);
  f.sqlite.run("UPDATE members SET role='member' WHERE id='mem_machine_2'");
  const server = createServer({ now: () => now, sourceOf: () => '127.0.0.1', fetchImpl: () => { throw new Error('unexpected outbound request'); } });
  const post = async (path: string, body: unknown) => (await worker.fetch(memberPost(token.token, body, path), f.env)).json() as Promise<any>;
  const rpc = async (key: string, name: string, args: Record<string, unknown>) => {
    const response = await worker.fetch(memberPost(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { project: 'proj_1', ...args } } }, '/mcp'), f.env);
    const body = await response.json() as any;
    return body.result?.structuredContent?.result ?? body.error;
  };
  const owner = async (path: string, body: unknown) => server.handleRequest(await asOwnerPost(f.db, path, body), { ...f.serverEnv, secrets: OWNER_ENV });
  return { ...f, now, token, post, rpc, owner, server };
}

const spore = (id: string, extra = {}) => ({ id, agentId: 'user', observationType: 'gotcha', content: `finding ${id}`, agentLine: 'When testing, retain the evidence.', ...extra });

test('run prose masks values after punctuated secret connectors', () => {
  for (const connector of ['is:', 'is=', 'is : =', ':=', '=:', 'was:', 'are:', 'were:', 'is,', 'is;']) {
    const result = agentProse(`The password ${connector} syntheticvalue\nUseful diagnosis remains.`, 1000);
    expect(result).not.toContain('syntheticvalue');
    expect(result).toContain('Useful diagnosis remains.');
  }
});

test('settings recursively strip bare and prefixed credential shapes for member reads', async () => {
  const f = await rig();
  try {
    const urls = ['user:syntheticvalue@host', 'DATABASE_URL=postgres://user:syntheticvalue@host/db', '[https://user:syntheticvalue@host/path?token=hidden]', 'postgres://user:syntheticvalue@[::1]:5432/db', 'https://syntheticvalue@host/path', 'user:syntheticvalue@host/path?token=querysecret', 'https://user:syntheticvalue@[::1]/path?token=querysecret'];
    f.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.tasks',?,0,'test')", [JSON.stringify({ nested: urls })]);
    const result = await f.post('/members/settings', {});
    expect(JSON.stringify(result)).not.toContain('syntheticvalue');
    expect(JSON.stringify(result)).not.toContain('querysecret');
    expect(JSON.stringify(result)).toContain('host');
  } finally { f.sqlite.close(); }
});

test('person lifecycle refuses runtime identity revocation and invitations without touching authority', async () => {
  const f = await rig();
  try {
    await ensureMember(f.db, HARNESS_MEMBER_ID, f.now, 'member', 'harness');
    const token = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, f.now);
    expect(await revokeMember(f.db, HARNESS_MEMBER_ID, 'mem_machine_1', f.now)).toMatchObject({ ok: false });
    await expect(issueEnrollmentAuthority(f.db, f.now, { role: 'member', issuer: { kind: 'operator' }, memberId: HARNESS_MEMBER_ID })).rejects.toThrow();
    expect(await revokeCredentialAsMember(f.db, { id: 'mem_machine_1', role: 'admin', label: 'owner' }, token.tokenId, f.now)).toMatchObject({ revoked: false });
    expect(f.sqlite.query('SELECT revoked_at FROM members WHERE id=?').get(HARNESS_MEMBER_ID)).toEqual({ revoked_at: null });
    expect(f.sqlite.query('SELECT revoked_at FROM member_credentials WHERE id=?').get(token.tokenId)).toEqual({ revoked_at: null });
  } finally { f.sqlite.close(); }
});

test('HTTP and MCP spore admission reject foreign sessions and derive ordinary metadata', async () => {
  const f = await rig();
  try {
    f.sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,started_at,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','foreign','machine_1',1,'tok_1',1,1)");
    expect(await f.post('/spores/save', spore('foreign', { sessionId: 'foreign' }))).toMatchObject({ persisted: false });
    expect(await f.rpc(f.token.token, 'myco_spores', { op: 'save', type: 'gotcha', content: 'foreign', session_id: 'foreign', agent_line: 'Retain evidence.' })).toMatchObject({ ok: false });
    expect(await f.post('/spores/save', spore('ordinary', { agentId: 'myco-agent', status: 'superseded', createdAt: 1 }))).toMatchObject({ persisted: true });
    const held = f.sqlite.query("SELECT agent_id,status,created_at,author,agent_line FROM spores WHERE id='ordinary'").get() as any;
    expect(held).toMatchObject({ agent_id: 'user', status: 'active', author: 'mem_machine_2', agent_line: 'When testing, retain the evidence.' });
    expect(held.created_at).toBeGreaterThan(1);
    expect(await f.post('/spores/save', { ...spore('missing-line'), agentLine: undefined })).toMatchObject({ persisted: false });
    expect(await f.post('/spores/save', spore('import-forged', { channel: 'import', createdAt: 1 }))).toMatchObject({ persisted: false });
  } finally { f.sqlite.close(); }
});

test('grant lifecycle admits only its own sources and replacement, with one absent refusal', async () => {
  let replacement: string | null = null;
  let race = false;
  const f = await rig((sql, db) => {
    if (race && sql.includes('UPDATE spores SET status')) { race = false; db.run("UPDATE spores SET author='mem_machine_2' WHERE id=?", [replacement]); }
  });
  try {
    const grant = await issueExternalGrant(f.db, { projectId: 'proj_1' }, 'review', 'mem_machine_1', f.now);
    await f.post('/spores/save', spore('member'));
    const own = await f.rpc(grant.key, 'myco_spores', { op: 'save', type: 'gotcha', content: 'review finding', agent_line: 'Retain evidence.', provenance_kind: 'pr', provenance_ref: 'https://github.com/a/b/pull/1' });
    expect(own.id).toBeString();
    for (const source of ['member', 'absent']) {
      const result = await f.rpc(grant.key, 'myco_spores', { op: 'supersede', old_spore_id: source, new_spore_id: own.id });
      expect(result).toEqual({ ok: false, error: 'spore_id not found' });
    }
    expect(await f.rpc(grant.key, 'myco_spores', { op: 'supersede', old_spore_id: own.id, new_spore_id: 'member' })).toEqual({ ok: false, error: 'spore_id not found' });
    const grantWrite = (input: Record<string, unknown>) => writeSpore(input, { env: f.serverEnv, projectId: 'proj_1', now: f.now, principal: { kind: 'grant', grantId: grant.id } });
    expect(await grantWrite({ op: 'obsolete', id: 'member', reason: 'review' })).toEqual({ ok: false, error: 'spore_id not found' });
    expect(await grantWrite({ op: 'consolidate', source_spore_ids: [own.id, 'member'], consolidated_content: 'combined', observation_type: 'wisdom', agent_line: 'Retain evidence.' })).toEqual({ ok: false, error: 'spore_id not found' });
    expect(f.sqlite.query("SELECT status FROM spores WHERE id='member'").get()).toEqual({ status: 'active' });
    const next = await f.rpc(grant.key, 'myco_spores', { op: 'save', type: 'gotcha', content: 'replacement finding', agent_line: 'Retain evidence.' });
    replacement = next.id;
    race = true;
    expect(await f.rpc(grant.key, 'myco_spores', { op: 'supersede', old_spore_id: own.id, new_spore_id: next.id })).toEqual({ ok: false, error: 'spore_id not found' });
    expect(race).toBe(false);
    expect(f.sqlite.query('SELECT status FROM spores WHERE id=?').get(own.id)).toEqual({ status: 'active' });
    expect(await grantWrite({ op: 'obsolete', id: own.id, reason: 'review' })).toMatchObject({ status: 'obsolete' });
  } finally { f.sqlite.close(); }
});

test('capture creation honors policy while existing projects remain writable', async () => {
  const f = await rig();
  try {
    f.sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('capture.auto_create_projects','false',0,'test')");
    expect(await f.post('/members/projects', { name: 'blocked' })).toMatchObject({ persisted: false, code: 'auto_create_off' });
    const response = await worker.fetch(memberPost(f.token.token, envelope(), '/events', { 'x-myco-project': 'fresh' }), f.env);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ persisted: false, code: 'unavailable' });
    expect(f.sqlite.query("SELECT project_id FROM projects WHERE project_id='fresh'").get()).toBeNull();
    expect(await f.post('/events', envelope())).toMatchObject({ persisted: true });
    const admin = await issueMemberToken(f.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, f.now);
    expect(await (await worker.fetch(memberPost(admin.token, envelope(), '/events', { 'x-myco-project': 'admin-fresh' }), f.env)).json()).toMatchObject({ persisted: true });
  } finally { f.sqlite.close(); }
});

test('administrative project creation normalizes names and shares the global ceiling', async () => {
  const f = await rig();
  try {
    expect((await f.owner('/api/projects', { projectId: 'blank', name: '   ' })).status).toBe(400);
    const made = await f.owner('/api/projects', { projectId: 'named', name: '  Named  ' });
    expect(made.status).toBe(201);
    expect(await made.json()).toMatchObject({ projectId: 'named', name: 'Named' });
    for (let i = 3; i < MAX_PROJECTS; i++) f.sqlite.run('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,0)', [`fill_${i}`, 'fill']);
    expect((await f.owner('/api/projects', { projectId: 'full', name: 'Full' })).status).toBe(400);
    expect(f.sqlite.query("SELECT project_id FROM projects WHERE project_id='full'").get()).toBeNull();
  } finally { f.sqlite.close(); }
});

test('run owner rejects invalid status and backwards transitions', async () => {
  const f = await rig();
  try {
    await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'run', agentId: 'user', task: 'embedding-reconcile', provider: 'embedding', model: null, runContext: '{}', startedAt: f.now, dispatchedBy: f.token.tokenId });
    for (const status of ['queued', 'invented', null]) await expect(applyRunUpdate(f.db, { projectId: 'proj_1' }, 'run', { status })).rejects.toThrow();
    expect(await applyRunUpdate(f.db, { projectId: 'proj_1' }, 'run', { status: 'completed' })).toBe(0);
    expect(f.sqlite.query("SELECT status FROM agent_runs WHERE id='run'").get()).toEqual({ status: 'pending' });
    f.sqlite.run("UPDATE agent_runs SET status='running' WHERE id='run'");
    expect(await applyRunUpdate(f.db, { projectId: 'proj_1' }, 'run', { status: 'completed' })).toBe(1);
  } finally { f.sqlite.close(); }
});

test('card admission refuses null and array card fields', () => {
  for (const card of [null, []]) expect(parseCardWrites([{ turns: ['turn'], signal: 'high', card }], new Set(['turn']))).toBe('each card carries its fields');
});

test('run state cannot reset server read budgets', async () => {
  const f = await rig();
  try {
    const ctx = { env: f.serverEnv, projectId: 'proj_1', now: f.now, principal: { kind: 'run' as const, runId: 'run', agentId: 'user', task: 'vault-seed', sessionId: null, runContext: null, model: null, tokenId: f.token.tokenId, allow: runAllowlist([]), window: readWindowFor('vault-seed') } };
    expect(await handleRun({ op: 'state_set', key: 'spore_reads:run', value: '0' }, ctx)).toMatchObject({ ok: false });
    expect(await handleRun({ op: 'state_set', key: 'work-notes', value: 'safe' }, ctx)).toMatchObject({ applied: true });
  } finally { f.sqlite.close(); }
});

test('external reads and filters withhold grant identity and human session labels', async () => {
  const f = await rig();
  try {
    const grant = await issueExternalGrant(f.db, { projectId: 'proj_1' }, 'review', 'mem_machine_1', f.now);
    const saved = await f.rpc(grant.key, 'myco_spores', { op: 'save', type: 'gotcha', content: 'external finding', agent_line: 'Retain evidence.' });
    for (const args of [{ op: 'list' }, { op: 'get', id: saved.id }]) {
      const result = await f.rpc(grant.key, 'myco_spores', args);
      expect(JSON.stringify(result)).not.toContain(grant.id);
    }
    expect(await f.rpc(grant.key, 'myco_spores', { op: 'list', agent_id: grant.id })).toMatchObject({ ok: false });
    await f.post('/events', envelope());
    for (const args of [{ op: 'list' }, { op: 'get', id: 'sess_1' }]) {
      const result = await f.rpc(grant.key, 'myco_sessions', args);
      const row = Array.isArray(result) ? result[0] : result;
      expect(row.user).toBeNull();
    }
    expect(await f.rpc(grant.key, 'myco_sessions', { op: 'list', user: 'machine_2' })).toMatchObject({ ok: false });
    const own = await f.rpc(f.token.token, 'myco_sessions', { op: 'get', id: 'sess_1' });
    expect(own.user).toBe('machine_2');
  } finally { f.sqlite.close(); }
});

test('runner sign-in denial requires the same live administrator as approval', async () => {
  const f = await rig();
  try {
    seedMemberRoleAccount(f.sqlite);
    const request = (path: string, body: unknown, cookie?: string) => f.server.handleRequest(new Request(`https://s${path}`, { method: 'POST',
      headers: { origin: 'https://s', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }), { ...f.serverEnv, secrets: OWNER_ENV });
    const started = await (await request('/auth/runner/start', { name: 'mini', machineId: 'runner-machine', machineName: 'Mini', os: 'darwin', candidate: `mycorun_${'a'.repeat(43)}` })).json() as any;
    expect(started.user_code).toBeString();
    const member = await ownerCookie(f.db, f.now, '770001');
    expect((await request('/api/device/deny', { user_code: started.user_code }, member)).status).toBe(409);
    expect(f.sqlite.query("SELECT decision FROM device_requests WHERE subject='runner'").get()).toEqual({ decision: null });
    expect((await f.owner('/api/device/deny', { user_code: started.user_code })).status).toBe(200);
  } finally { f.sqlite.close(); }
});

async function embedding(f: Awaited<ReturnType<typeof rig>>) {
  await ensureMember(f.db, HARNESS_MEMBER_ID, f.now, 'member', 'harness');
  const token = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, f.now);
  await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'embedding-run', agentId: 'user', task: 'embedding-reconcile', provider: 'embedding', model: null,
    runContext: '{"timeoutSeconds":300}', startedAt: f.now, dispatchedBy: token.tokenId });
  return (path: string, body: unknown) => f.server.handleRequest(memberPost(token.token, body, path), f.serverEnv);
}

test('failed completion postconditions cannot grant replacement eligibility', async () => {
  const f = await rig();
  try {
    const post = await embedding(f);
    const result = await (await post('/runs/update', { runId: 'embedding-run', update: { status: 'completed' }, replaced: true })).json();
    expect(result).toMatchObject({ persisted: true, applied: false, reason: 'postcondition' });
    const row = f.sqlite.query("SELECT status,run_context FROM agent_runs WHERE id='embedding-run'").get() as any;
    expect(row.status).toBe('failed');
    expect(JSON.parse(row.run_context).replaced).not.toBe(true);
    expect(f.sqlite.query("SELECT COUNT(*) n FROM agent_runs").get()).toEqual({ n: 1 });
  } finally { f.sqlite.close(); }
});

test('postcommit call observation failures preserve the accepted embedding result', async () => {
  let failObservation = false;
  let observedFailure = false;
  const f = sqliteEnv({ onSql(sql) { if (failObservation && sql.includes('INSERT INTO agent_run_events')) { observedFailure = true; throw new Error('observation unavailable'); } } });
  const now = Date.now();
  const server = createServer({ now: () => now, sourceOf: () => '127.0.0.1', fetchImpl: () => { throw new Error('unexpected outbound'); } });
  try {
    await ensureMember(f.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
    const token = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
    await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'embedding-run', agentId: 'user', task: 'embedding-reconcile', provider: 'embedding', model: null,
      runContext: '{"timeoutSeconds":300}', startedAt: now, dispatchedBy: token.tokenId });
    failObservation = true;
    const response = await server.handleRequest(memberPost(token.token, { runId: 'embedding-run', update: { status: 'failed', error: 'stopped' } }, '/runs/update'), f.serverEnv);
    expect(observedFailure).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ persisted: true, changed: 1, applied: true });
    expect(f.sqlite.query("SELECT status FROM agent_runs WHERE id='embedding-run'").get()).toEqual({ status: 'failed' });
  } finally { f.sqlite.close(); }
});

test('every worker protocol route reports the same subject-liveness outcome', async () => {
  let armed = false;
  const f = sqliteEnv({ onSql(sql, db) {
    if (armed && sql.includes('SELECT m.role, m.revoked_at, o.member_id AS owner')) { armed = false; db.run("UPDATE members SET revoked_at=1 WHERE id='mem_machine_1'"); }
  } });
  try {
    const token = await issueMemberToken(f.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    for (const path of ['/worker/lease', '/worker/end', '/worker/repository', '/worker/steps', '/worker/models', '/worker/claim']) {
      f.sqlite.run("UPDATE members SET revoked_at=NULL WHERE id='mem_machine_1'");
      armed = true;
      const response = await worker.fetch(memberPost(token.token, {}, path), f.env);
      expect(await response.json()).toEqual({ persisted: true, [path === '/worker/end' ? 'ended' : 'held']: false, reason: 'the lease is no longer held' });
    }
  } finally { f.sqlite.close(); }
});

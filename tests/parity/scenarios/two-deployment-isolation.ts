import { expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { sha256Hex, sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { sqliteVectorStore } from '@myco-server-worker/platform/bun/vectors.js';
import { vectorId, type VectorMetadata } from '@myco-server-worker/core/embedding/vectors.js';
import { NO_OP, RUN_TOOLS, SERVED_TOOLS } from '@myco-server-worker/core/tool-catalogue.js';
import { TOOL_REGISTRY } from '@myco-server-worker/mcp/registry.js';
import { RUN_TOOL_REGISTRY } from '@myco-server-worker/mcp/run-surface.js';
import { matchRoute, ROUTES, type Route } from '@myco-server-worker/routes.js';
import { lit, MACHINE_ID, MEMBER_ID, SESSION_SECRET, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { credentials, selectOwner } from '../clients/identity.ts';
import { linkedMember, dispatch, takeRun, repository, runDetail } from '../clients/runs.ts';
import { allowWorkerClaims, owner, putCapability, putSetting } from '../clients/requests.ts';
import { transplantSecret } from '../historical-storage/sealed-secret.ts';
import { revisionHeaders } from '../settings-revision.ts';

const ROUTE_VALUES: Record<string, string> = {
  projectId: 'proj_parity', sessionId: 'session_isolation', runId: 'run_isolation',
  machineId: 'machine_parity', memberId: 'mem_parity', backupId: 'backup_isolation',
  grantId: 'grant_isolation', promptId: '11111111-1111-4111-8111-111111111111', planKey: '22222222-2222-4222-8222-222222222222',
  sporeId: 'spore_isolation', switchId: 'switch_isolation', agentId: 'agent_isolation',
  candidateId: 'candidate_isolation', skillId: 'skill_isolation', id: 'id_isolation',
  leaf: 'agent.limits.concurrent_runs', name: 'anthropic', check: 'database',
  kind: 'prompt', child: 'plans', tier: '1', capability: 'search',
  rootKey: 'a'.repeat(16), key: 'a'.repeat(64), sha256: 'a'.repeat(64),
};

function routePath(route: Route): string {
  const path = route.path.replace(/\{([^}]+)\}/g, (_, name: string) => ROUTE_VALUES[name] ?? 'isolation');
  expect(matchRoute(route.method, path)?.route, `${route.method} ${route.path} must match its own route`).toBe(route);
  return path;
}

let sourceIndex = 0;
function sourceIp(): string {
  const index = sourceIndex++;
  return `10.${1 + Math.floor(index / 65_536)}.${Math.floor(index / 256) % 256}.${index % 256}`;
}

async function request(target: ParityTarget, method: string, path: string, headers: Record<string, string>, body = '{}'): Promise<Response> {
  return fetch(`${target.url}${path}`, {
    method,
    headers: { ...headers, origin: target.url, 'cf-connecting-ip': sourceIp(), 'content-type': 'application/json', ...(method === 'PUT' && path.startsWith('/api/settings/') ? await revisionHeaders(target, path) : {}) },
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
}

// A physical snapshot witnesses that rejected foreign authority changes no stored row.
function sqliteRows(database: Database): Record<string, string> {
  const tables = (database.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
    .filter(({ name }) => !name.startsWith('sqlite_') && !name.startsWith('_cf_'));
  const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
  return Object.fromEntries(tables.map(({ name }) => {
    const columns = database.query(`PRAGMA table_info(${lit(name)})`).all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    const values = names.map((column) => `quote(${identifier(column)})`);
    const order = names.map(identifier).join(', ');
    const rows = database.query(`SELECT json_array(${values.join(', ')}) AS row_value FROM ${identifier(name)} ORDER BY ${order}`).all();
    return [name, JSON.stringify(rows)];
  }));
}

async function databaseRows(target: ParityTarget): Promise<Record<string, string>> {
  const database = new Database(target.bindings.database, { readonly: true });
  try {
    const held = database.query("SELECT value FROM schema_meta WHERE key = 'deployment_id'").get() as { value: string } | null;
    expect(held?.value).toBe(target.deploymentId);
    return sqliteRows(database);
  } finally { database.close(); }
}

async function blobState(target: ParityTarget): Promise<Record<string, string>> {
  const root = target.bindings.blob;
  const state: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile() || /\.sqlite-(wal|shm)$/.test(file)) continue;
      const relative = path.relative(root, file);
      if (file.endsWith('.sqlite')) {
        const sqlite = new Database(file, { readonly: true });
        try { state[relative] = JSON.stringify(sqliteRows(sqlite)); }
        finally { sqlite.close(); }
      } else state[relative] = await sha256HexOf(new Uint8Array(fs.readFileSync(file)));
    }
  };
  await visit(root);
  return state;
}

async function localControls(target: ParityTarget): Promise<void> {
  const me = await request(target, 'GET', '/auth/me', target.ownerHeaders());
  expect(me.status).toBe(200);
  expect((await me.json() as { member: { id: string } }).member.id).toBe('mem_parity');
  const status = await request(target, 'POST', '/members/status', target.memberHeaders());
  expect(status.status).toBe(200);
  expect((await status.json() as { persisted: boolean }).persisted).toBe(true);
  const tools = await request(target, 'POST', '/mcp', target.memberHeaders(), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  expect(tools.status).toBe(200);
  const listed = await tools.json() as { result?: { tools?: Array<{ name: string }> } };
  expect(new Set(listed.result?.tools?.map((tool) => tool.name))).toEqual(new Set(SERVED_TOOLS));
}

interface Authorities { grantKey: string; runToken: string }

async function seedAuthorities(target: ParityTarget): Promise<Authorities> {
  const now = Date.now();
  const event = await request(target, 'POST', '/events', target.memberHeaders(), JSON.stringify({
    eventId: crypto.randomUUID(), sessionId: 'session_isolation', kind: 'session.start', createdAt: now,
    channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'codex', startedAt: now },
  }));
  expect((await event.json() as { persisted: boolean }).persisted).toBe(true);
  const grant = await request(target, 'POST', `/api/projects/${target.projectId}/grants`, target.ownerHeaders(), JSON.stringify({ label: 'isolation grant' }));
  expect(grant.status).toBe(201);
  const grantKey = String((await grant.json() as { key: string }).key);
  const localGrant = await request(target, 'POST', '/mcp', target.grantHeaders(grantKey), JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  expect(localGrant.status).toBe(200);
  await allowWorkerClaims(target);
  expect((await putSetting(target, 'agent.scheduled_tasks_enabled', false)).status).toBe(200);
  expect((await putCapability(target, 'vault_evolution', true)).status).toBe(200);
  await repository(target);
  const dispatched = await dispatch(target, 'vault-seed');
  const { runToken } = await takeRun(target, dispatched.runId);
  const runHeaders = { ...target.memberHeaders(), authorization: `Bearer ${runToken}` };
  const runTools = await request(target, 'POST', '/mcp', runHeaders, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  expect(runTools.status).toBe(200);
  const runRead = await request(target, 'POST', '/mcp', runHeaders, JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'myco_run_spores', arguments: { project: target.projectId, op: 'list' } },
  }));
  expect(runRead.status).toBe(200);
  const runResult = await runRead.json() as { error?: unknown; result?: { structuredContent?: { result?: { spores?: unknown[] } } } };
  expect(runResult.error).toBeUndefined();
  expect(runResult.result?.structuredContent?.result?.spores).toEqual([]);
  return { grantKey, runToken };
}

async function sweepForeignRoutes(from: ParityTarget, to: ParityTarget, authority: Authorities): Promise<{ guarded: number; publicRoutes: number; presentations: number }> {
  let guarded = 0;
  let publicRoutes = 0;
  let presentations = 0;
  for (const route of ROUTES) {
    const path = routePath(route);
    const headers = route.auth === 'session' ? [from.ownerHeaders()] : route.auth === 'member'
      ? [from.memberHeaders(), { ...from.memberHeaders(), authorization: `Bearer ${authority.runToken}` }, from.grantHeaders(authority.grantKey)]
      : [from.memberHeaders()];
    for (const presented of headers) {
      const response = await request(to, route.method, path, presented);
      presentations += 1;
      if (route.auth === 'public' || route.auth === 'auth' || route.auth === 'enroll') {
        if (presented === headers[0]) publicRoutes += 1;
        expect(response.status, `${route.method} ${route.path} must not fail internally`).toBeLessThan(500);
        await response.body?.cancel();
        continue;
      }
      expect(response.status, `${from.deploymentId} -> ${to.deploymentId}: ${route.method} ${route.path}`).toBe(401);
      await response.body?.cancel();
      if (presented === headers[0]) guarded += 1;
    }
  }
  return { guarded, publicRoutes, presentations };
}

async function sweepForeignTools(from: ParityTarget, to: ParityTarget, authority: Authorities): Promise<number> {
  let checked = 0;
  const operations = [
    ...SERVED_TOOLS.flatMap((tool) => Object.keys(TOOL_REGISTRY[tool].ops).map((op) => ({ tool, op }))),
    ...RUN_TOOLS.flatMap((tool) => Object.keys(RUN_TOOL_REGISTRY[tool].ops).map((op) => ({ tool, op }))),
  ];
  for (const { tool, op } of operations) {
    const args = { project: to.projectId, ...(op === NO_OP ? {} : { op }) };
    const body = JSON.stringify({ jsonrpc: '2.0', id: checked + 1, method: 'tools/call', params: { name: tool, arguments: args } });
    for (const presented of [from.memberHeaders(), { ...from.memberHeaders(), authorization: `Bearer ${authority.runToken}` }, from.grantHeaders(authority.grantKey)]) {
      const response = await request(to, 'POST', '/mcp', presented, body);
      expect(response.status, `${from.deploymentId} -> ${to.deploymentId}: ${tool}/${op}`).toBe(401);
      await response.body?.cancel();
      checked += 1;
    }
  }
  return checked;
}

async function bindingControls(target: ParityTarget, peer: ParityTarget, label: string): Promise<string> {
  const setting = await request(target, 'PUT', '/api/settings/agent.limits.concurrent_runs', target.ownerHeaders(), JSON.stringify({ value: label === 'A' ? 2 : 3 }));
  expect(setting.status).toBe(200);
  const secret = await request(target, 'PUT', '/api/secrets/anthropic', target.ownerHeaders(), JSON.stringify({ value: `synthetic-${label}-${target.deploymentId}` }));
  expect(secret.status).toBe(200);
  const content = `blob-${label}-${target.deploymentId}`;
  const physicalBefore = await blobState(target);
  const payload = utf8(content);
  const key = await sha256Hex(content);
  const upload = await fetch(`${target.url}/blobs/${key}`, {
    method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'text/plain', 'content-length': String(payload.byteLength) }, body: payload,
  });
  expect(upload.status).toBe(200);
  expect((await upload.json() as { stored: boolean }).stored).toBe(true);
  expect(await blobState(target)).not.toEqual(physicalBefore);
  const local = await request(target, 'GET', `/api/projects/${target.projectId}/blobs/${key}`, target.ownerHeaders());
  expect(local.status).toBe(200);
  expect(await local.text()).toBe(content);
  const foreign = await request(peer, 'GET', `/api/projects/${peer.projectId}/blobs/${key}`, peer.ownerHeaders());
  expect(foreign.status).toBe(404);
  return key;
}

async function sealedSecretIsolation(from: ParityTarget, to: ParityTarget): Promise<void> {
  // Sealed ciphertext is unreadable under another tenant's wrapping key and readable again after restoration.
  const source = (await from.sql("SELECT ciphertext,iv,key_version FROM deployment_secrets WHERE name = 'anthropic'"))[0];
  const original = (await to.sql("SELECT ciphertext,iv,key_version FROM deployment_secrets WHERE name = 'anthropic'"))[0];
  expect(source).toBeDefined();
  expect(original).toBeDefined();
  const readable = async (): Promise<boolean | undefined> => {
    const response = await request(to, 'GET', '/api/secrets', to.ownerHeaders());
    expect(response.status).toBe(200);
    const body = await response.json() as { secrets: Array<{ name: string; configured: boolean; readable: boolean }> };
    const slot = body.secrets.find((entry) => entry.name === 'anthropic');
    expect(slot?.configured).toBe(true);
    return slot?.readable;
  };
  expect(await readable()).toBe(true);
  try {
    await transplantSecret(to, source!);
    expect(await readable()).toBe(false);
  } finally { await transplantSecret(to, original!); }
  expect(await readable()).toBe(true);
}

async function roleMatrix(target: ParityTarget, rawKey: string): Promise<void> {
  const now = Date.now();
  await selectOwner(target);
  const ownerTokenId = (await credentials(target)).find(row => row.memberId === MEMBER_ID && row.machineId === MACHINE_ID && row.live)!.id;
  const deviceStart = await request(target, 'POST', '/auth/device/start', {}, JSON.stringify({ machineId: MACHINE_ID, machineName: 'Owner laptop', os: 'linux' }));
  expect(deviceStart.status).toBe(200);
  const device = await deviceStart.json() as { user_code: string; device_code: string };
  expect((await request(target, 'POST', '/api/device/approve', target.ownerHeaders(), JSON.stringify({ user_code: device.user_code }))).status).toBe(200);
  expect(await (await request(target, 'POST', '/auth/device/poll', {}, JSON.stringify({ device_code: device.device_code }))).json()).toMatchObject({ joined: true, memberId: MEMBER_ID });
  const adminMember = await linkedMember(target, '730001');
  const plainMember = await linkedMember(target, '730002');
  expect((await owner(target, `/api/members/${adminMember.memberId}/role`, { method: 'POST', body: JSON.stringify({ role: 'admin', expected_revision: '0' }) })).status).toBe(200);
  const session = async (sub: string) => ({
    cookie: `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub, login: sub, iat: now, exp: now + 3_600_000 })}`,
  });
  const actors = [
    { role: 'owner', headers: target.ownerHeaders() },
    { role: 'admin', headers: await session('730001') },
    { role: 'member', headers: await session('730002') },
  ] as const;
  const status = async (actor: typeof actors[number], method: string, path: string, body?: Record<string, unknown>) =>
    (await request(target, method, path, actor.headers, JSON.stringify(body ?? {}))).status;
  for (const actor of actors) {
    expect(await status(actor, 'GET', '/api/settings')).toBe(200);
    const memberList = await request(target, 'GET', '/api/members', actor.headers);
    expect(memberList.status).toBe(200);
    const memberRows = (await memberList.json() as { members: Array<{ id: string; effectiveRole: string }> }).members;
    expect(memberRows.find(member => member.id === MEMBER_ID)?.effectiveRole).toBe('owner');
    expect(memberRows.find(member => member.id === adminMember.memberId)?.effectiveRole).toBe('admin');
    expect(memberRows.find(member => member.id === plainMember.memberId)?.effectiveRole).toBe('member');
    expect(await status(actor, 'GET', '/api/credentials')).toBe(200);
    expect(await status(actor, 'GET', '/api/projects')).toBe(200);
    expect(await status(actor, 'GET', `/api/projects/${target.projectId}/runs`)).toBe(200);
    expect(await status(actor, 'GET', '/api/machines')).toBe(200);
    const machineId = `machine_device_${actor.role}`;
    const started = await request(target, 'POST', '/auth/device/start', {}, JSON.stringify({ machineId, machineName: 'Matrix laptop', os: 'linux' }));
    expect(started.status).toBe(200);
    const device = await started.json() as { user_code: string; device_code: string };
    expect(await status(actor, 'POST', '/api/device/preview', { user_code: device.user_code })).toBe(200);
    expect(await status(actor, 'POST', '/api/device/approve', { user_code: device.user_code, memberId: 'someone-else' })).toBe(400);
    expect(await status(actor, 'POST', '/api/device/approve', { user_code: device.user_code, role: 'owner' })).toBe(400);
    expect(await status(actor, 'POST', '/api/device/approve', { user_code: device.user_code })).toBe(200);
    const redeemed = await request(target, 'POST', '/auth/device/poll', {}, JSON.stringify({ device_code: device.device_code }));
    expect(await redeemed.json()).toMatchObject({ joined: true, memberId: actor.role === 'owner' ? MEMBER_ID : actor.role === 'admin' ? adminMember.memberId : plainMember.memberId, role: actor.role === 'member' ? 'member' : 'admin' });
    const deniedStart = await request(target, 'POST', '/auth/device/start', {}, JSON.stringify({ machineId: `${machineId}_denied`, machineName: 'Matrix laptop', os: 'linux' }));
    expect(deniedStart.status).toBe(200);
    const denied = await deniedStart.json() as { user_code: string; device_code: string };
    expect(await status(actor, 'POST', '/api/device/deny', { user_code: denied.user_code })).toBe(200);
    const deniedPoll = await request(target, 'POST', '/auth/device/poll', {}, JSON.stringify({ device_code: denied.device_code }));
    expect(await deniedPoll.json() as { error: string }).toEqual({ error: 'access_denied' });
    const admin = actor.role !== 'member';
    expect(await status(actor, 'GET', '/api/secrets')).toBe(admin ? 200 : 403);
    expect(await status(actor, 'GET', '/api/backups')).toBe(admin ? 200 : 403);
    expect(await status(actor, 'PUT', '/api/secrets/anthropic', { value: `synthetic-matrix-${actor.role}-${target.deploymentId}` }))
      .toBe(admin ? 200 : 403);
    expect(await status(actor, 'DELETE', '/api/secrets/anthropic')).toBe(admin ? 200 : 403);
    expect(await status(actor, 'PUT', '/api/settings/agent.limits.concurrent_runs', { value: 4 })).toBe(admin ? 200 : 403);
    expect(await status(actor, 'POST', '/api/projects', { projectId: `proj_matrix_${actor.role}`, name: actor.role })).toBe(admin ? 201 : 403);
    expect(await status(actor, 'GET', `/api/machines/${MACHINE_ID}/settings`)).toBe(actor.role === 'owner' ? 200 : 403);
    expect(await status(actor, 'GET', `/api/projects/${target.projectId}/blobs/${rawKey}`)).toBe(actor.role === 'owner' ? 200 : 404);
    if (actor.role !== 'owner') {
      expect(await status(actor, 'POST', '/api/ownership/transfer', { member_id: adminMember.memberId, expected_revision: '1' })).toBe(403);
      expect(await status(actor, 'POST', `/api/members/${MEMBER_ID}/revoke`)).toBe(403);
    }
  }
  expect((await owner(target, '/api/members')).body.members.find((row: any) => row.id === MEMBER_ID)).toMatchObject({ revokedAt: null });

  for (const actor of actors) {
    const admin = actor.role !== 'member';
    expect(await status(actor, 'GET', `/api/projects/${target.projectId}/grants`)).toBe(admin ? 200 : 403);
    expect(await status(actor, 'POST', `/api/projects/${target.projectId}/grants`, { label: `matrix-${actor.role}` })).toBe(admin ? 201 : 403);
    expect(await status(actor, 'GET', '/api/enrollment')).toBe(admin ? 200 : 403);
    expect(await status(actor, 'POST', '/api/enrollment', { role: 'member' })).toBe(admin ? 201 : 403);
    expect(await status(actor, 'POST', '/api/enrollment', { role: 'admin' })).toBe(actor.role === 'owner' ? 201 : 403);
    for (const memberId of [MEMBER_ID, adminMember.memberId]) {
      expect(await status(actor, 'POST', '/api/enrollment', { memberId, role: 'member' })).toBe(actor.role === 'owner' ? 201 : 403);
    }
    expect(await status(actor, 'POST', `/api/members/${plainMember.memberId}/role`, { role: 'admin', expected_revision: '0' }))
      .toBe(actor.role === 'owner' ? 200 : 403);
    if (actor.role === 'owner') {
      const revision = String((await owner(target, '/api/members')).body.members.find((row: any) => row.id === plainMember.memberId).roleRevision);
      expect(await status(actor, 'POST', `/api/members/${plainMember.memberId}/role`, { role: 'member', expected_revision: revision })).toBe(200);
    }
    expect(await status(actor, 'PUT', `/api/machines/${MACHINE_ID}/settings/capture.plan_dirs`, { value: ['~/matrix'] }))
      .toBe(actor.role === 'owner' ? 200 : 403);
  }
  const issued = await request(target, 'POST', '/api/enrollment', actors[1].headers, JSON.stringify({ role: 'member' }));
  expect(issued.status).toBe(201);
  const invitationId = (await issued.json() as { id: string }).id;
  expect(await status(actors[2], 'POST', `/api/enrollment/${invitationId}/revoke`)).toBe(403);
  expect(await status(actors[1], 'POST', `/api/enrollment/${invitationId}/revoke`)).toBe(200);
  const revokedMember = await linkedMember(target, '730003');
  expect(await status(actors[2], 'POST', `/api/members/${revokedMember.memberId}/revoke`)).toBe(403);
  expect(await status(actors[1], 'POST', `/api/members/${revokedMember.memberId}/revoke`)).toBe(200);
  expect((await owner(target, '/api/members')).body.members.find((row: any) => row.id === revokedMember.memberId).revokedAt).not.toBeNull();
  const memberToken = plainMember.token;
  const memberMachine = (await credentials(target)).find(row => row.memberId === plainMember.memberId && row.live)!.machineId;
  const rawContent = `matrix-member-${target.deploymentId}`;
  const rawKeyOfMember = await sha256Hex(rawContent);
  const rawUpload = await fetch(`${target.url}/blobs/${rawKeyOfMember}`, { method: 'POST',
    headers: memberHeadersFor(memberToken, target.projectId,
      { 'content-type': 'text/plain', 'content-length': String(utf8(rawContent).byteLength) }), body: rawContent });
  if (rawUpload.status !== 200) throw new Error(`member raw upload answered ${rawUpload.status}: ${(await rawUpload.text()).slice(0, 500)}`);
  expect((await rawUpload.json() as { stored: boolean }).stored).toBe(true);
  expect(await status(actors[2], 'GET', `/api/projects/${target.projectId}/blobs/${rawKeyOfMember}`)).toBe(200);
  expect(await status(actors[1], 'GET', `/api/projects/${target.projectId}/blobs/${rawKeyOfMember}`)).toBe(404);
  expect(await status(actors[0], 'GET', `/api/projects/${target.projectId}/blobs/${rawKeyOfMember}`)).toBe(404);
  expect(await status(actors[2], 'GET', `/api/machines/${memberMachine}/settings`)).toBe(200);
  expect(await status(actors[0], 'GET', `/api/machines/${memberMachine}/settings`)).toBe(403);

  const dispatchAs = async (headers: Record<string, string>) => {
    const answer = await request(target, 'POST', '/api/harness/dispatch', headers, JSON.stringify({ task: 'title-summary', projectId: target.projectId }));
    expect(answer.status).toBe(200); return String((await answer.json() as { runId: string }).runId);
  };
  const ownRun = await dispatchAs(plainMember.headers), otherRun = await dispatchAs(adminMember.headers);
  const cancelPath = (runId: string) => `/api/projects/${target.projectId}/runs/${runId}/cancel`;
  for (const actor of actors) {
    for (const runId of [ownRun, otherRun]) {
      const response = await request(target, 'GET', `/api/projects/${target.projectId}/runs/${runId}`, actor.headers);
      expect(response.status).toBe(200);
      const { run } = await response.json() as { run: { canCancel: boolean; cancelReason: string | null } };
      const allowed = actor.role !== 'member' || runId === ownRun;
      expect(run.canCancel).toBe(allowed);
      expect(run.cancelReason).toBe(allowed ? null : 'Only the member who requested this run or an administrator can cancel it.');
    }
  }
  expect(await status(actors[2], 'POST', cancelPath(otherRun))).toBe(404);
  expect(await status(actors[2], 'POST', cancelPath(ownRun))).toBe(200);
  expect(await status(actors[1], 'POST', cancelPath(otherRun))).toBe(200);
  for (const id of [ownRun, otherRun]) expect((await runDetail(target, id)).run.status).toBe('failed');

  expect(await status(actors[2], 'POST', '/api/backups')).toBe(403);
  for (const actor of actors.slice(0, 2)) {
    const backup = await request(target, 'POST', '/api/backups', actor.headers);
    expect(backup.status).toBe(200);
    const backupId = (await backup.json() as { backup: { id: string } }).backup.id;
    const previewPath = `/api/backups/${backupId}/restore-preview`;
    expect(await status(actors[2], 'POST', previewPath)).toBe(403);
    for (const viewer of actors.slice(0, 2)) {
      const preview = await request(target, 'POST', previewPath, viewer.headers);
      expect(preview.status).toBe(200);
      const body = await preview.json() as { restore: { allowed: boolean; reason: string | null }; header: { counts: Record<string, number> } };
      expect(body.header.counts.members ?? 0).toBeGreaterThan(0);
      expect(body.restore).toEqual(viewer.role === 'owner'
        ? { allowed: true, reason: null }
        : { allowed: false, reason: 'Only the owner can restore a backup that includes members or access authority.' });
    }
    expect(await status(actors[2], 'POST', `/api/backups/${backupId}/restore`)).toBe(403);
    expect(await status(actor, 'POST', `/api/backups/${backupId}/restore`)).toBe(actor.role === 'owner' ? 200 : 403);
  }

  const ownerCredential = async () => (await credentials(target)).find(row => row.id === ownerTokenId)!;
  const memberStop = await request(target, 'POST', `/api/machines/${MACHINE_ID}/stop`, actors[2].headers);
  expect(memberStop.status).toBe(404);
  const adminStop = await request(target, 'POST', `/api/machines/${MACHINE_ID}/stop`, actors[1].headers);
  expect(adminStop.status).toBe(404);
  expect(await adminStop.json() as { error: string }).toEqual({ error: 'not_found' });
  const adminCredentialStop = await request(target, 'POST', `/api/credentials/${ownerTokenId}/revoke`, actors[1].headers);
  expect(adminCredentialStop.status).toBe(200);
  expect((await adminCredentialStop.json() as { revoked: boolean }).revoked).toBe(false);
  expect((await ownerCredential()).revokedAt).toBeNull();
  const ownerStop = await request(target, 'POST', `/api/machines/${MACHINE_ID}/stop`, actors[0].headers);
  expect(ownerStop.status).toBe(200);
  expect((await ownerStop.json() as { revoked: number }).revoked).toBeGreaterThan(0);
  expect((await ownerCredential()).revokedAt).not.toBeNull();
}

// Native vector writes bind to each tenant's independent physical SQLite file.
async function nativeVectorIsolation(a: ParityTarget, b: ParityTarget): Promise<void> {
  if (a.name !== 'selfhosted') return;
  const scope = { projectId: a.projectId, modelKey: 'isolation-model' };
  const id = await vectorId(scope, 'spore', 'same-source', '1');
  const metadata: VectorMetadata = { type: 'spore', record_id: 'same-source', revision: '1', status: 'active',
    session_id: 'session_isolation', created_at: 1, observation_type: 'decision', release_state: 'live', release_confidence: 'high' };
  const dbA = new Database(a.bindings.vector!);
  const dbB = new Database(b.bindings.vector!);
  try {
    const vectorsA = sqliteVectorStore(dbA);
    const vectorsB = sqliteVectorStore(dbB);
    await vectorsA.upsert(scope, [{ id, values: [1, 0], metadata }]);
    expect(await vectorsB.get(scope, [id])).toEqual([]);
    await vectorsB.upsert(scope, [{ id, values: [0, 1], metadata }]);
    expect((await vectorsA.get(scope, [id]))[0]?.values.slice(0, 2)).toEqual([1, 0]);
    expect((await vectorsB.get(scope, [id]))[0]?.values.slice(0, 2)).toEqual([0, 1]);
    expect((await vectorsA.query(scope, { values: [1, 0], topK: 1 }))[0]?.score).toBeGreaterThan(0.99);
    expect((await vectorsB.query(scope, { values: [0, 1], topK: 1 }))[0]?.score).toBeGreaterThan(0.99);
  } finally {
    dbA.close();
    dbB.close();
  }
}

export const twoDeploymentIsolation: ParityScenario = {
  name: 'two Deployments: every HTTP route and served MCP operation refuses foreign authority before writes',
  dedicated: { sqliteVec: true, timeoutMs: 360_000 },
  paired: true,
  async run(a, peer) {
    if (peer === undefined) throw new Error('two-Deployment isolation needs a second booted target');
    const b = peer;
    expect(a.name).toBe(b.name);
    expect(a.deploymentId).not.toBe(b.deploymentId);
    expect(a.projectId).toBe(b.projectId);
    for (const binding of ['database', 'blob', 'secret'] as const) expect(a.bindings[binding]).not.toBe(b.bindings[binding]);
    if (a.name === 'selfhosted') expect(a.bindings.vector).not.toBe(b.bindings.vector);
    else {
      expect([a.bindings.vector, b.bindings.vector]).toEqual([null, null]);
      for (const target of [a, b]) {
        expect(fs.existsSync(target.bindings.blob)).toBe(true);
        expect(fs.existsSync(target.bindings.secret)).toBe(true);
      }
    }
    await localControls(a);
    await localControls(b);
    const authA = await seedAuthorities(a);
    const authB = await seedAuthorities(b);
    const beforeA = await databaseRows(a);
    const beforeB = await databaseRows(b);
    const blobsBeforeA = await blobState(a);
    const blobsBeforeB = await blobState(b);
    const ab = await sweepForeignRoutes(a, b, authA);
    const ba = await sweepForeignRoutes(b, a, authB);
    expect(ab).toEqual(ba);
    expect(ab.guarded + ab.publicRoutes).toBe(ROUTES.length);
    const opsAB = await sweepForeignTools(a, b, authA);
    const opsBA = await sweepForeignTools(b, a, authB);
    expect(opsAB).toBe(opsBA);
    const memberOps = Object.values(TOOL_REGISTRY).reduce((count, entry) => count + Object.keys(entry.ops).length, 0);
    const runOps = Object.values(RUN_TOOL_REGISTRY).reduce((count, entry) => count + Object.keys(entry.ops).length, 0);
    expect(opsAB).toBe(3 * (memberOps + runOps));
    expect(await databaseRows(a)).toEqual(beforeA);
    expect(await databaseRows(b)).toEqual(beforeB);
    expect(await blobState(a)).toEqual(blobsBeforeA);
    expect(await blobState(b)).toEqual(blobsBeforeB);
    const rawA = await bindingControls(a, b, 'A');
    const rawB = await bindingControls(b, a, 'B');
    expect((await owner(a, '/api/settings')).body.leaves.find((row: any) => row.leaf === 'agent.limits.concurrent_runs').value).toBe(2);
    expect((await owner(b, '/api/settings')).body.leaves.find((row: any) => row.leaf === 'agent.limits.concurrent_runs').value).toBe(3);
    // Independently sealed provider keys must have different ciphertext in the two stores.
    const secretA = await a.sql("SELECT ciphertext FROM deployment_secrets WHERE name = 'anthropic'");
    const secretB = await b.sql("SELECT ciphertext FROM deployment_secrets WHERE name = 'anthropic'");
    expect(secretA).toHaveLength(1);
    expect(secretB).toHaveLength(1);
    expect(secretA[0]?.ciphertext).not.toBe(secretB[0]?.ciphertext);
    await sealedSecretIsolation(a, b);
    await sealedSecretIsolation(b, a);
    await nativeVectorIsolation(a, b);
    await roleMatrix(a, rawA);
    await roleMatrix(b, rawB);
    console.info(`two-Deployment ${a.name}: ${ROUTES.length} registry routes (${ab.guarded} guarded, ${ab.publicRoutes} public/enrollment), ${ab.presentations} route presentations, ${memberOps} member operations and ${runOps} run-only operations (${opsAB} credential presentations) per direction`);
    if (a.name === 'cloudflare') console.info('local workerd/D1 Vectorize runtime read/write: untested; this target has no local VECTORIZE binding');
  },
};
